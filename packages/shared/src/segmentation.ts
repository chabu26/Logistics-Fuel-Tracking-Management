import {
  CONDITION_THRESHOLDS,
  gradientClass,
  loadClass,
  roadShape,
  speedBand,
  timeOfDay,
  trafficClass,
} from './conditions';
import { haversineKm, headingDelta } from './geo';
import type { DataGap, FuelLevelEvent, Segment, TelemetryReading, TripContext } from './types';

export interface SegmentationOptions {
  /** Length of a moving segment, km */
  segmentKm?: number;
  /** A stationary period with the engine on at least this long becomes its own idle segment, seconds */
  minIdleS?: number;
  /** Readings further apart than this are treated as a data gap and not joined, seconds */
  maxGapS?: number;
}

type IntervalState = 'move' | 'stop' | 'off' | 'gap';

interface Interval {
  a: TelemetryReading;
  b: TelemetryReading;
  state: IntervalState;
  dtS: number;
  distKm: number;
  /** litres from the CAN counter, or null when the counter is missing */
  canFuelL: number | null;
}

const t = (r: TelemetryReading) => Date.parse(r.time);

/** Rolling median of the fuel level sensor, to remove slosh and sensor noise. */
export function smoothFuelLevel(readings: TelemetryReading[], window = 9): number[] {
  const half = Math.floor(window / 2);
  return readings.map((_, i) => {
    const slice = readings
      .slice(Math.max(0, i - half), Math.min(readings.length, i + half + 1))
      .map((r) => r.fuelLevelL)
      .sort((x, y) => x - y);
    return slice[Math.floor(slice.length / 2)];
  });
}

function buildIntervals(readings: TelemetryReading[], maxGapS: number): Interval[] {
  const out: Interval[] = [];
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const b = readings[i];
    const dtS = (t(b) - t(a)) / 1000;
    if (dtS <= 0) continue;
    const odo = b.odometerKm - a.odometerKm;
    const gps = haversineKm(a.lat, a.lon, b.lat, b.lon);
    // Prefer the odometer; fall back to GPS when the odometer looks wrong
    const distKm = odo >= 0 && odo < gps * 1.5 + 0.05 ? odo : gps;
    const canFuelL =
      a.fuelUsedTotalL !== undefined && b.fuelUsedTotalL !== undefined
        ? Math.max(0, b.fuelUsedTotalL - a.fuelUsedTotalL)
        : null;
    let state: IntervalState;
    if (dtS > maxGapS) state = 'gap';
    else if (!a.ignition || !b.ignition) state = 'off';
    else if ((a.speedKmh + b.speedKmh) / 2 < CONDITION_THRESHOLDS.stoppedKmh && distKm < 0.01) state = 'stop';
    else state = 'move';
    out.push({ a, b, state, dtS, distKm, canFuelL });
  }
  return out;
}

/**
 * Cut one trip's readings into short segments, each tagged with every condition and the litres used.
 * Moving segments are ~segmentKm long. Long stops with the engine on become idle segments.
 * Short stops are folded into the moving segment around them and counted as stops (traffic).
 */
export function segmentTrip(
  readingsIn: TelemetryReading[],
  ctx: TripContext,
  opts: SegmentationOptions = {},
): Segment[] {
  const segmentKm = opts.segmentKm ?? 1;
  const minIdleS = opts.minIdleS ?? 120;
  const maxGapS = opts.maxGapS ?? 300;

  const readings = [...readingsIn].sort((x, y) => t(x) - t(y));
  if (readings.length < 2) return [];
  // A wide median (about 2.5 minutes at 10 s readings) for litres measured by the tank sensor.
  // Segment litres are signed differences of this level: noise then cancels out when segments are added
  // up, where clipping each segment at zero would only ever add fuel and overstate consumption.
  const levels = smoothFuelLevel(readings, 15);
  const indexOf = new Map(readings.map((r, i) => [r, i]));
  const intervals = buildIntervals(readings, maxGapS);

  // Short stops become part of the moving flow; long ones become idle.
  const runs: { state: IntervalState; items: Interval[] }[] = [];
  for (const iv of intervals) {
    const last = runs[runs.length - 1];
    if (last && last.state === iv.state) last.items.push(iv);
    else runs.push({ state: iv.state, items: [iv] });
  }
  for (const run of runs) {
    if (run.state !== 'stop') continue;
    const dur = run.items.reduce((s, iv) => s + iv.dtS, 0);
    if (dur < minIdleS) {
      for (const iv of run.items) iv.state = 'move';
      (run as { shortStop?: boolean }).shortStop = true;
    }
  }

  const segments: Segment[] = [];
  const lc = loadClass(ctx.loadKg, ctx.maxLoadKg);

  const close = (items: Interval[], kind: 'moving' | 'idle', stops: number) => {
    if (items.length === 0) return;
    const first = items[0].a;
    const last = items[items.length - 1].b;
    const distanceKm = items.reduce((s, iv) => s + iv.distKm, 0);
    const durationS = items.reduce((s, iv) => s + iv.dtS, 0);
    const allCan = items.every((iv) => iv.canFuelL !== null);
    let fuelUsedL: number;
    if (allCan) {
      fuelUsedL = items.reduce((s, iv) => s + (iv.canFuelL ?? 0), 0);
    } else {
      const startL = levels[indexOf.get(first)!];
      const endL = levels[indexOf.get(last)!];
      fuelUsedL = startL - endL; // can be slightly negative on its own; sums stay unbiased
    }
    let headingChange = 0;
    for (const iv of items) {
      if (iv.a.speedKmh > 5 && iv.b.speedKmh > 5) headingChange += headingDelta(iv.a.headingDeg, iv.b.headingDeg);
    }
    const avgSpeedKmh = durationS > 0 ? round(distanceKm / (durationS / 3600), 1) : 0;
    const gradientPct = distanceKm > 0.05 ? ((last.altitudeM - first.altitudeM) / (distanceKm * 1000)) * 100 : 0;
    const harshEvents = items.reduce((s, iv) => s + (iv.b.harshAccel ? 1 : 0) + (iv.b.harshBrake ? 1 : 0), 0);
    const moving = kind === 'moving';
    segments.push({
      kind,
      startedAt: first.time,
      endedAt: last.time,
      distanceKm: round(distanceKm, 3),
      durationS: Math.round(durationS),
      fuelUsedL: round(fuelUsedL, 3),
      fuelSource: allCan ? 'can_counter' : 'level_sensor',
      avgSpeedKmh: avgSpeedKmh,
      speedBand: moving ? speedBand(avgSpeedKmh) : null,
      gradientPct: round(gradientPct, 2),
      gradient: moving ? gradientClass(gradientPct) : null,
      traffic: moving ? trafficClass(avgSpeedKmh, stops) : null,
      roadShape: moving ? roadShape(headingChange, distanceKm) : null,
      timeOfDay: timeOfDay(first.time, ctx.utcOffsetHours ?? 2),
      loadClass: lc,
      harshEvents,
      startLat: first.lat,
      startLon: first.lon,
      vehicleId: ctx.vehicleId,
      tripId: ctx.tripId,
      driverId: ctx.driverId,
      routeId: ctx.routeId,
      loadKg: ctx.loadKg,
      passengers: ctx.passengers,
      surface: ctx.surface,
      weather: ctx.weather,
    });
  };

  let current: Interval[] = [];
  let currentKm = 0;
  let stops = 0;
  for (const run of runs) {
    if (run.state === 'move') {
      if ((run as { shortStop?: boolean }).shortStop) stops++;
      for (const iv of run.items) {
        current.push(iv);
        currentKm += iv.distKm;
        if (currentKm >= segmentKm) {
          close(current, 'moving', stops);
          current = [];
          currentKm = 0;
          stops = 0;
        }
      }
    } else {
      // A long stop, the engine off, or a data gap ends the moving segment
      if (currentKm > 0.1) close(current, 'moving', stops);
      current = [];
      currentKm = 0;
      stops = 0;
      if (run.state === 'stop') close(run.items, 'idle', 0);
    }
  }
  if (currentKm > 0.1) close(current, 'moving', stops);
  return segments;
}

export interface FuelEventOptions {
  /** A rise in level bigger than this while stationary is a refuel, litres */
  riseThresholdL?: number;
  /** A fall in level bigger than this with the engine off is a suspicious drop, litres */
  dropThresholdL?: number;
}

/**
 * Find refuels (level rises) and drops while parked in a vehicle's readings.
 * Run on a whole day of readings, not a single trip, so overnight drops are caught.
 */
export function detectFuelEvents(readingsIn: TelemetryReading[], opts: FuelEventOptions = {}): FuelLevelEvent[] {
  const riseThresholdL = opts.riseThresholdL ?? 10;
  const dropThresholdL = opts.dropThresholdL ?? 8;
  const readings = [...readingsIn].sort((x, y) => t(x) - t(y));
  if (readings.length < 3) return [];
  const stationary = readings.map((r) => r.speedKmh < CONDITION_THRESHOLDS.stoppedKmh);

  const events: FuelLevelEvent[] = [];
  let i = 0;
  while (i < readings.length) {
    if (!stationary[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < readings.length && stationary[j + 1]) j++;
    // One stop can hold several events (siphoned overnight, refuelled in the morning), so walk through it.
    // The reading just before the stop is the starting reference. Smoothing stays inside the stop, where
    // the fuel is not sloshing.
    const window = readings.slice(Math.max(0, i - 1), j + 1);
    events.push(...stopEvents(window, riseThresholdL, dropThresholdL));
    i = j + 1;
  }
  return events;
}

/** Rises and drops inside one stop, found by following the smoothed level away from a reference point. */
function stopEvents(window: TelemetryReading[], riseThresholdL: number, dropThresholdL: number): FuelLevelEvent[] {
  // the reading before the stop stays raw: smoothing it with the stop would pull in the change itself
  const levels = [window[0].fuelLevelL, ...smoothFuelLevel(window.slice(1), 5)];
  const events: FuelLevelEvent[] = [];
  const settle = 0.5; // litres of wobble allowed while a level is still climbing or falling
  let ref = 0;
  let k = 1;
  while (k < window.length) {
    const diff = levels[k] - levels[ref];
    if (diff > riseThresholdL || -diff > dropThresholdL) {
      const rising = diff > 0;
      // follow the change to where it levels off
      let end = k;
      while (end + 1 < window.length && (rising ? levels[end + 1] >= levels[end] - settle : levels[end + 1] <= levels[end] + settle)) end++;
      // start = last reading before the level began to move
      let start = ref;
      for (let s = ref; s < k; s++) if (Math.abs(levels[s] - levels[ref]) <= settle) start = s;
      const litres = Math.abs(levels[end] - levels[start]);
      const engineOff = window.slice(start + 1, end + 1).every((r) => !r.ignition);
      if (rising || engineOff) {
        events.push({
          type: rising ? 'rise' : 'drop_while_parked',
          litres: round(litres, 1),
          startedAt: window[start + 1 <= end ? start + 1 : start].time,
          endedAt: window[end].time,
          levelBeforeL: round(levels[start], 1),
          levelAfterL: round(levels[end], 1),
          lat: window[end].lat,
          lon: window[end].lon,
        });
      }
      ref = end;
      k = end + 1;
      continue;
    }
    // small changes (engine idling, noise) move the reference slowly so they never add up to an event
    if (Math.abs(diff) <= settle) ref = k;
    else if (window[k].ignition) ref = k; // burning fuel while idling is not a drop
    k++;
  }
  return events;
}

export interface IdlePeriod {
  startedAt: string;
  endedAt: string;
  durationS: number;
  /** From the CAN counter when available, otherwise estimated from the tank sensor */
  fuelUsedL: number;
  lat: number;
  lon: number;
}

/**
 * Every stretch with the engine on and the vehicle not moving, at least `minS` long, across all readings,
 * not just inside trips: drivers often idle at a terminus or yard between trips.
 */
export function findIdlePeriods(readingsIn: TelemetryReading[], minS = 300): IdlePeriod[] {
  const readings = [...readingsIn].sort((x, y) => t(x) - t(y));
  const idle = readings.map((r) => r.ignition && r.speedKmh < CONDITION_THRESHOLDS.stoppedKmh);
  const out: IdlePeriod[] = [];
  let i = 0;
  while (i < readings.length) {
    if (!idle[i]) {
      i++;
      continue;
    }
    let j = i;
    // a reading gap longer than 5 minutes ends the period: we can't say what happened in between
    while (j + 1 < readings.length && idle[j + 1] && t(readings[j + 1]) - t(readings[j]) <= 300_000) j++;
    const durationS = (t(readings[j]) - t(readings[i])) / 1000;
    if (durationS >= minS) {
      const a = readings[i];
      const b = readings[j];
      const can = a.fuelUsedTotalL !== undefined && b.fuelUsedTotalL !== undefined;
      const levels = smoothFuelLevel(readings.slice(i, j + 1));
      out.push({
        startedAt: a.time,
        endedAt: b.time,
        durationS: Math.round(durationS),
        fuelUsedL: round(can ? b.fuelUsedTotalL! - a.fuelUsedTotalL! : Math.max(0, levels[0] - levels[levels.length - 1]), 2),
        lat: a.lat,
        lon: a.lon,
      });
    }
    i = j + 1;
  }
  return out;
}

/**
 * Find stretches where readings stopped but the vehicle kept moving (distance covered across the gap).
 * A short gap in poor signal is normal: trackers buffer and resend. A gap that is never filled while the
 * odometer advances usually means the device was unplugged or switched off.
 */
export function findDataGaps(readingsIn: TelemetryReading[], opts: { maxGapS?: number; minDistanceKm?: number } = {}): DataGap[] {
  const maxGapS = opts.maxGapS ?? 300;
  const minDistanceKm = opts.minDistanceKm ?? 1;
  const readings = [...readingsIn].sort((x, y) => t(x) - t(y));
  const gaps: DataGap[] = [];
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const b = readings[i];
    const dtS = (t(b) - t(a)) / 1000;
    if (dtS <= maxGapS) continue;
    const odo = b.odometerKm - a.odometerKm;
    const distanceKm = odo > 0 ? odo : haversineKm(a.lat, a.lon, b.lat, b.lon);
    if (distanceKm < minDistanceKm) continue;
    gaps.push({
      startedAt: a.time,
      endedAt: b.time,
      durationS: Math.round(dtS),
      distanceKm: round(distanceKm, 1),
      fuelChangeL: round(b.fuelLevelL - a.fuelLevelL, 1),
      lat: a.lat,
      lon: a.lon,
    });
  }
  return gaps;
}

function round(n: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
