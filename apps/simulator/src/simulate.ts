import { busLoadKg, timeOfDay, type RefuelSource, type TelemetryReading } from '@fleetfuel/shared';
import { DEMO_DEPOT, DEMO_ROUTES, type DemoRoute, type DemoVehicle } from '@fleetfuel/shared/demo';
import { litresBurned, maxAccel, physicsFor, type VehiclePhysics } from './physics';
import { Rng } from './random';
import { buildRoad, gradeAt, pointAt, type Road } from './road';

// ------------------------------------------------------------------ output

export interface SimTrip {
  key: string;
  registration: string;
  driverEmail: string;
  routeCode: string;
  startedAt: string;
  endedAt: string;
  loadKg?: number;
  passengers?: number;
  weather: 'dry' | 'rain';
}

export interface SimRefuel {
  registration: string;
  driverEmail: string;
  source: RefuelSource;
  litres: number;
  pricePerL: number;
  occurredAt: string;
  lat: number;
  lon: number;
  odometerKm: number;
  stationName?: string;
  cardTxnRef?: string;
  pumpReading?: number;
}

export interface SimDelivery {
  litres: number;
  pricePerL: number;
  supplier: string;
  deliveredAt: string;
}

export interface SimDip {
  litres: number;
  measuredAt: string;
}

/** Something staged on purpose, with the alert the platform should raise for it. */
export interface Incident {
  kind: IncidentKind;
  registration: string | null;
  at: string;
  litres: number | null;
  description: string;
  expectedAlert: string;
}

export interface SimOutput {
  trips: SimTrip[];
  refuels: SimRefuel[];
  deliveries: SimDelivery[];
  dips: SimDip[];
  telemetry: Map<string, TelemetryReading[]>;
  incidents: Incident[];
}

export type IncidentKind =
  | 'inflated_receipt'
  | 'night_siphon'
  | 'card_fraud'
  | 'tracker_unplugged'
  | 'unrecorded_refuel'
  | 'faulty_injector'
  | 'long_idle'
  | 'depot_theft';

interface IncidentPlan {
  kind: IncidentKind;
  registration: string | null;
  /** earliest day (0-based) the incident can happen */
  fromDay: number;
  done?: boolean;
}

/** One staged incident per kind, spread over the period. */
export const DEFAULT_INCIDENTS: IncidentPlan[] = [
  { kind: 'inflated_receipt', registration: 'BAE 4471', fromDay: 2 },
  { kind: 'night_siphon', registration: 'BAF 5521', fromDay: 3 },
  { kind: 'card_fraud', registration: 'BBC 9032', fromDay: 4 },
  { kind: 'tracker_unplugged', registration: 'BCD 7789', fromDay: 5 },
  { kind: 'unrecorded_refuel', registration: 'BAH 2210', fromDay: 4 },
  { kind: 'faulty_injector', registration: 'ALB 1234', fromDay: 7 },
  { kind: 'long_idle', registration: 'BBC 9032', fromDay: 6 },
  { kind: 'depot_theft', registration: null, fromDay: 5 },
];

export interface SimOptions {
  /** First day, local date YYYY-MM-DD */
  startDate: string;
  days: number;
  seed: number;
  vehicles: DemoVehicle[];
  incidents: boolean;
}

// ------------------------------------------------------------------ constants

const UTC_OFFSET_H = 2; // Zambia
const STEP_S = 10; // tracker reading interval while the engine runs
const PARKED_STEP_S = 300; // heartbeat while parked with the engine off
const REFUEL_STEP_S = 60;
const PRICE_STATION = 27.5; // ZMW per litre, demo value
const PRICE_DEPOT = 26.2;
const PRICE_DELIVERY = 25.8;

/** Local time on a day to UTC milliseconds. */
const localMs = (date: string, hour: number) => Date.parse(`${date}T00:00:00Z`) + (hour - UTC_OFFSET_H) * 3600_000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();
const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;

// ------------------------------------------------------------------ depot

class Depot {
  levelL = DEMO_DEPOT.openingLevelL;
  pumpReading = 184_220;
  constructor(
    private out: SimOutput,
    private rng: Rng,
  ) {}

  dispense(litres: number) {
    this.levelL -= litres;
    this.pumpReading = round(this.pumpReading + litres);
  }

  /** Evening dip; order a delivery for the next morning when stock runs low. */
  endOfDay(date: string) {
    this.out.dips.push({ litres: Math.round((this.levelL + this.rng.gauss(0, 8)) / 10) * 10, measuredAt: iso(localMs(date, 18)) });
    if (this.levelL < 7000) {
      const litres = 10000;
      this.levelL += litres;
      this.out.deliveries.push({ litres, pricePerL: PRICE_DELIVERY, supplier: 'Bulk fuel supplier (demo)', deliveredAt: iso(localMs(addDays(date, 1), 5)) });
    }
  }
}

// ------------------------------------------------------------------ vehicle

class VehicleSim {
  readonly phys: VehiclePhysics;
  readonly readings: TelemetryReading[] = [];
  t = 0; // ms
  level: number;
  usedTotal = 1000 * 37; // CAN counter since the engine was new
  odo: number;
  lat = DEMO_DEPOT.lat;
  lon = DEMO_DEPOT.lon;
  alt = 1270;
  heading = 0;
  /** Where the vehicle is: at the depot or away at the end of a route */
  away: { route: DemoRoute } | null = null;
  tripCount = 0;
  /** >1 burns more fuel than physics says (faulty injector) */
  waste = 1;
  /** Readings are not sent (tracker unplugged) */
  silent = false;
  readonly driverAggression: number;

  constructor(
    readonly v: DemoVehicle,
    private rng: Rng,
    private out: SimOutput,
    private depot: Depot,
    private plans: IncidentPlan[],
    startMs: number,
  ) {
    this.phys = physicsFor(v);
    this.level = v.tankCapacityL * rng.between(0.6, 0.9);
    this.odo = rng.int(80_000, 420_000);
    this.t = startMs;
    this.driverAggression = rng.between(0, 1);
  }

  emit(speedKmh: number, ignition: boolean, accel = 0, harshAccel = false, harshBrake = false) {
    if (this.silent) return;
    // the tank sensor is noisy and fuel sloshes when the vehicle speeds up or brakes
    const sensed = this.level + this.rng.gauss(0, 1.0) + 2.5 * accel;
    this.readings.push({
      time: iso(this.t),
      lat: round(this.lat + this.rng.gauss(0, 0.00003), 6),
      lon: round(this.lon + this.rng.gauss(0, 0.00003), 6),
      altitudeM: round(this.alt + this.rng.gauss(0, 2), 0),
      speedKmh: round(speedKmh, 1),
      headingDeg: round(this.heading, 0),
      ignition,
      fuelLevelL: Math.max(0, round(sensed, 1)),
      fuelUsedTotalL: this.v.canFuelCounter ? round(this.usedTotal, 2) : undefined,
      odometerKm: round(this.odo, 2),
      harshAccel: harshAccel || undefined,
      harshBrake: harshBrake || undefined,
    });
  }

  plan(kind: IncidentKind, day: number): IncidentPlan | null {
    const p = this.plans.find((x) => x.kind === kind && x.registration === this.v.registration && !x.done && day >= x.fromDay);
    return p ?? null;
  }

  incident(p: IncidentPlan, at: number, litres: number | null, description: string, expectedAlert: string) {
    p.done = true;
    this.out.incidents.push({ kind: p.kind, registration: this.v.registration, at: iso(at), litres, description, expectedAlert });
  }

  /** Parked with the engine off until `untilMs`. `siphon` drains litres over 20 minutes at a given time. */
  park(untilMs: number, siphon?: { atMs: number; litres: number }) {
    let left = siphon?.litres ?? 0;
    while (this.t < untilMs) {
      const step = Math.min(PARKED_STEP_S * 1000, untilMs - this.t);
      this.t += step;
      if (siphon && this.t >= siphon.atMs && left > 0) {
        // 20 minutes of siphoning shows up across four heartbeats
        const take = Math.min(left, siphon.litres / 4);
        this.level -= take;
        left -= take;
      }
      this.emit(0, false);
    }
  }

  /** Engine running, not moving. */
  idle(seconds: number) {
    const end = this.t + seconds * 1000;
    while (this.t < end) {
      const dt = Math.min(STEP_S, (end - this.t) / 1000);
      this.t += dt * 1000;
      const l = (this.phys.idleLPerHour / 3600) * dt * this.waste;
      this.level -= l;
      this.usedTotal += l;
      this.emit(0, true);
    }
  }

  /** Stop at a pump, engine off, and fill up. Returns litres that actually went into the tank. */
  fill(toShare: number): number {
    const litres = round(Math.max(0, this.v.tankCapacityL * toShare - this.level), 0);
    this.emit(0, false);
    const minutes = Math.max(4, Math.ceil(litres / 60));
    for (let m = 0; m < minutes; m++) {
      this.t += REFUEL_STEP_S * 1000;
      this.level += litres / minutes;
      this.emit(0, false);
    }
    this.t += 3 * 60_000;
    this.emit(0, false);
    return litres;
  }

  depotRefuel(day: number, driverEmail: string) {
    if (this.level > this.v.tankCapacityL * 0.65) return;
    this.t += 10 * 60_000;
    const litres = this.fill(0.97);
    if (litres < 10) return;
    this.depot.dispense(litres);
    this.out.refuels.push({
      registration: this.v.registration,
      driverEmail,
      source: 'depot',
      litres,
      pricePerL: PRICE_DEPOT,
      occurredAt: iso(this.t - 2 * 60_000),
      lat: DEMO_DEPOT.lat,
      lon: DEMO_DEPOT.lon,
      odometerKm: round(this.odo, 0),
      pumpReading: this.depot.pumpReading,
    });
    void day;
  }

  /** A refuel at a filling station during a trip. Staged fraud happens here. */
  stationRefuel(day: number, driverEmail: string, road: Road, km: number) {
    const ignitionOffAt = this.t;
    const litres = this.fill(0.95);
    const source: RefuelSource = this.v.kind === 'truck' ? 'fuel_card' : 'cash';
    let recorded = litres;
    const inflated = this.plan('inflated_receipt', day);
    if (inflated) {
      recorded = litres + 60;
      this.incident(inflated, this.t, 60, `Cash receipt for ${recorded} L but only ${litres} L went into the tank`, 'refuel_mismatch (critical, ~60 L)');
    }
    const unrecorded = this.plan('unrecorded_refuel', day);
    if (unrecorded) {
      this.incident(unrecorded, this.t, litres, `Refuelled ${litres} L at a station but no receipt was submitted`, 'refuel_without_record');
      return;
    }
    this.out.refuels.push({
      registration: this.v.registration,
      driverEmail,
      source,
      litres: recorded,
      pricePerL: PRICE_STATION,
      occurredAt: iso(ignitionOffAt + this.rng.int(3, 15) * 60_000),
      lat: round(this.lat, 5),
      lon: round(this.lon, 5),
      odometerKm: round(this.odo, 0),
      stationName: `Filling station km ${Math.round(km)}, ${road.code}`,
      cardTxnRef: source === 'fuel_card' ? `FC${this.rng.int(100000, 999999)}` : undefined,
    });
  }

  /**
   * Drive the whole road. Speed follows traffic, bends, hills, police checkpoints and the engine's power;
   * fuel follows the physics of moving the vehicle's mass at that speed and gradient.
   */
  drive(road: Road, day: number, trip: { loadKg: number; driverEmail: string; weather: 'dry' | 'rain' }) {
    const mass = this.phys.emptyMassKg + trip.loadKg;
    const rain = trip.weather === 'rain' ? 0.88 : 1;
    const style = 0.94 + this.driverAggression * 0.12; // calm drivers cruise a little slower
    const aggressive = this.driverAggression > 0.75;

    // traffic lights / junctions in town and police checkpoints on the highway
    // `late` = an aggressive driver who sees this stop late and brakes hard
    const stops: { km: number; seconds: number; late: boolean }[] = [];
    for (let km = 0.5; km < road.lengthKm - 0.5; ) {
      const p = pointAt(road, km);
      if (p.urban) {
        const tod = timeOfDay(iso(this.t), UTC_OFFSET_H);
        const chance = tod === 'peak' ? 0.75 : tod === 'night' ? 0.15 : 0.4;
        if (this.rng.chance(chance)) stops.push({ km, seconds: this.rng.int(tod === 'peak' ? 40 : 20, tod === 'peak' ? 150 : 70), late: aggressive && this.rng.chance(0.15) });
        km += this.rng.between(0.4, 0.9);
      } else {
        if (this.rng.chance(1 / 90)) stops.push({ km, seconds: this.rng.int(60, 300), late: aggressive && this.rng.chance(0.3) });
        km += 1;
      }
    }

    const unplug = this.plan('tracker_unplugged', day);
    const unplugAt = unplug && road.lengthKm > 120 ? { from: 60, to: 95 } : null;
    let siphonedInGap = false;
    let refuelled = false;
    let km = 0;
    let v = 0; // m/s
    let stopIdx = 0;
    const cruise = this.phys.cruiseKmh * style * rain;
    const wobble = this.rng.between(0, Math.PI * 2);

    while (km < road.lengthKm) {
      const p = pointAt(road, km);
      const grade = gradeAt(road, km);
      this.lat = p.lat;
      this.lon = p.lon;
      this.alt = p.altM;
      this.heading = p.headingDeg;

      if (unplugAt) {
        const off = km >= unplugAt.from && km < unplugAt.to;
        if (off && !this.silent) this.silent = true;
        if (off && !siphonedInGap && km > (unplugAt.from + unplugAt.to) / 2) {
          // pulled off the road for 15 minutes while the tracker was unplugged
          siphonedInGap = true;
          this.level -= 35;
          this.t += 15 * 60_000;
        }
        if (!off && this.silent) {
          this.silent = false;
          this.incident(unplug!, this.t, 35, `Tracker disconnected for ${unplugAt.to - unplugAt.from} km on ${road.code}; 35 L removed while it was off`, 'device_tampering (critical)');
        }
      }

      // fuel stop on the open road when the tank runs low
      if (!refuelled && !p.urban && this.level < this.v.tankCapacityL * 0.22) {
        refuelled = true;
        v = 0;
        this.stationRefuel(day, trip.driverEmail, road, km);
        continue;
      }

      let target = p.urban ? (timeOfDay(iso(this.t), UTC_OFFSET_H) === 'peak' ? 28 : 46) : cruise + 4 * Math.sin(km / 7 + wobble);
      if (p.winding) target = Math.min(target, this.phys.cautiousKmh);
      if (grade < -0.04 && this.v.kind !== 'van') target = Math.min(target, this.phys.cautiousKmh + 10);
      if (!p.urban && road.lengthKm - km < 2) target = Math.min(target, 40);

      const stop = stops[stopIdx];
      if (stop) {
        const distM = (stop.km - km) * 1000;
        const comfort = stop.late ? 3.4 : 1.4;
        const brakingM = (v * v) / (2 * comfort) + v * STEP_S * (stop.late ? 0.2 : 0.6);
        if (distM <= 25 && v < 2.5) {
          // at the stop: wait with the engine running
          v = 0;
          km = Math.max(km, stop.km);
          this.emit(0, true);
          this.idle(stop.seconds);
          stopIdx++;
          continue;
        }
        if (distM < brakingM) target = Math.min(target, Math.max(0, Math.sqrt(Math.max(0, 2 * comfort * distM)) * 3.6 * 0.8));
      }

      const targetMs = target / 3.6;
      const aMax = maxAccel(this.phys, mass, v, grade);
      let a = (targetMs - v) / STEP_S;
      const brakeDecel = stop?.late ? -3.4 : -1.8;
      // aggressive drivers sometimes floor it pulling away
      const floor = aggressive && v < 8 && this.rng.chance(0.08);
      a = Math.max(brakeDecel, Math.min(a, floor ? aMax : aMax * (0.45 + 0.35 * this.driverAggression)));
      const harshAccel = a > (this.v.kind === 'van' ? 2.2 : 0.95);
      const harshBrake = a < -3;
      const vNew = Math.max(0, v + a * STEP_S);
      const distKm = ((v + vNew) / 2) * STEP_S / 1000;
      const litres = litresBurned(this.phys, mass, (v + vNew) / 2, a, grade, STEP_S, this.waste * (1 + this.driverAggression * 0.04));
      v = vNew;
      km += distKm;
      this.odo += distKm;
      this.level -= litres;
      this.usedTotal += litres;
      this.t += STEP_S * 1000;
      this.emit(v * 3.6, true, a, harshAccel, harshBrake);
      if (v < 0.3 && !stop) v = 1; // never get stuck
    }
    const end = pointAt(road, road.lengthKm);
    this.lat = end.lat;
    this.lon = end.lon;
    this.alt = end.altM;
    this.idle(this.rng.int(30, 150));
    this.emit(0, false);
  }
}

// ------------------------------------------------------------------ fleet schedule

/** Simulate the whole fleet day by day. Same seed, same history. */
export function simulateFleet(opts: SimOptions): SimOutput {
  const rng = new Rng(opts.seed);
  const out: SimOutput = { trips: [], refuels: [], deliveries: [], dips: [], telemetry: new Map(), incidents: [] };
  const depot = new Depot(out, rng);
  const plans = opts.incidents ? DEFAULT_INCIDENTS.map((p) => ({ ...p })) : [];
  const routeByCode = new Map(DEMO_ROUTES.map((r) => [r.code, r]));
  const sims = opts.vehicles.map((v) => new VehicleSim(v, rng, out, depot, plans, localMs(opts.startDate, 0)));

  for (let day = 0; day < opts.days; day++) {
    const date = addDays(opts.startDate, day);
    const sunday = new Date(`${date}T12:00:00Z`).getUTCDay() === 0;

    for (const s of sims) {
      const weather = rng.chance(0.2) ? 'rain' : 'dry';
      const driver = s.v.driverEmail;

      if (s.away) {
        // overnight away: drive back to the depot this morning
        const route = s.away.route;
        s.park(localMs(date, rng.between(5.5, 7)));
        runTrip(s, route, true, day, date, weather, driver);
        s.away = null;
        continue;
      }
      if (sunday) continue;

      const route = routeByCode.get(s.v.routes[s.tripCount % s.v.routes.length])!;
      s.tripCount++;
      s.park(localMs(date, rng.between(5.5, 6.5)));
      s.depotRefuel(day, driver);
      if (route.code === 'LSK-CITY') {
        runTrip(s, route, false, day, date, weather, driver);
        s.park(localMs(date, rng.between(12.5, 13.5)));
        runTrip(s, route, false, day, date, weather, driver);
        continue;
      }
      const out1 = runTrip(s, route, false, day, date, weather, driver);
      if (out1.lengthKm < 200) {
        // short route: turn around the same day
        const longIdle = s.plan('long_idle', day);
        s.park(s.t + rng.between(45, 90) * 60_000);
        if (longIdle) {
          s.emit(0, true);
          s.idle(45 * 60);
          s.incident(longIdle, s.t - 45 * 60_000, null, 'Bus idled 45 minutes at the terminus with the engine running', 'excessive_idling');
        }
        const fraud = s.plan('card_fraud', day);
        if (fraud) {
          const litres = 120;
          out.refuels.push({
            registration: s.v.registration,
            driverEmail: driver,
            source: 'fuel_card',
            litres,
            pricePerL: PRICE_STATION,
            occurredAt: iso(s.t - 20 * 60_000),
            lat: round(s.lat, 5),
            lon: round(s.lon, 5),
            odometerKm: round(s.odo, 0),
            stationName: `Filling station, ${route.code}`,
            cardTxnRef: `FC${rng.int(100000, 999999)}`,
          });
          s.incident(fraud, s.t - 20 * 60_000, litres, `Fuel card charged for ${litres} L but no fuel went into this bus`, 'refuel_mismatch (critical, 120 L)');
        }
        runTrip(s, route, true, day, date, weather, driver);
      } else {
        s.away = { route };
      }
    }

    // overnight: everyone parks until tomorrow; staged siphoning happens tonight
    const nightEnd = localMs(addDays(date, 1), 5);
    for (const s of sims) {
      const siphon = s.plan('night_siphon', day);
      if (siphon && s.level > 120) {
        const at = localMs(addDays(date, 1), 1.5);
        s.incident(siphon, at, 70, '70 L siphoned overnight while parked, engine off', 'drop_while_parked (critical, ~70 L)');
        s.park(nightEnd, { atMs: at, litres: 70 });
      } else {
        s.park(nightEnd);
      }
    }

    const theft = plans.find((p) => p.kind === 'depot_theft' && !p.done && day >= p.fromDay);
    if (theft) {
      depot.levelL -= 350;
      theft.done = true;
      out.incidents.push({ kind: 'depot_theft', registration: null, at: iso(localMs(date, 16)), litres: 350, description: '350 L taken from the depot tank without a record', expectedAlert: 'depot_stock_gap (critical, ~350 L) at the evening dip' });
    }
    depot.endOfDay(date);
  }

  for (const s of sims) out.telemetry.set(s.v.deviceId, s.readings);
  return out;

  function runTrip(s: VehicleSim, route: DemoRoute, back: boolean, day: number, date: string, weather: 'dry' | 'rain', driver: string): Road {
    const road = buildRoad(route, rng, back);
    const loadKg = loadFor(s.v, back, rng);
    const passengers = s.v.kind === 'bus' ? Math.round(loadKg / busLoadKg(1)) : undefined;
    const injector = s.plan('faulty_injector', day);
    if (injector) s.waste = 1.4;
    // warm-up and loading, engine on
    s.emit(0, true);
    const startedAt = s.t;
    s.idle(s.v.kind === 'bus' ? rng.int(240, 600) : rng.int(90, 240));
    s.drive(road, day, { loadKg, driverEmail: driver, weather });
    if (injector) {
      s.waste = 1;
      s.incident(injector, startedAt, null, `Faulty injector: ${route.code} trip burned about 40% more than normal`, 'abnormal_consumption');
    }
    out.trips.push({
      key: `${s.v.registration}#${out.trips.length}`,
      registration: s.v.registration,
      driverEmail: driver,
      routeCode: route.code,
      startedAt: iso(startedAt - 1000),
      endedAt: iso(s.t + 1000),
      loadKg: s.v.kind === 'bus' ? undefined : loadKg,
      passengers,
      weather,
    });
    void date;
    return road;
  }
}

function loadFor(v: DemoVehicle, back: boolean, rng: Rng): number {
  if (v.kind === 'bus') return busLoadKg(rng.int(Math.round((v.seats ?? 60) * 0.4), v.seats ?? 60));
  const max = v.maxLoadKg ?? 1000;
  if (v.kind === 'van') return Math.round(max * rng.between(0.2, 0.9));
  // trucks go out loaded and mostly come back empty or part-loaded
  if (!back) return Math.round(max * rng.between(0.85, 1));
  return rng.chance(0.4) ? Math.round(max * rng.between(0.3, 0.7)) : Math.round(max * rng.between(0, 0.05));
}
