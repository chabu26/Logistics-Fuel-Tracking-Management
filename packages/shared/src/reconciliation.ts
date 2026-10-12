import { haversineKm } from './geo';
import type { IdlePeriod } from './segmentation';
import type { DataGap, FuelLevelEvent, RefuelSource, Segment } from './types';

/** A refuel as recorded by a person or a fuel card statement. */
export interface RefuelRecord {
  id: string;
  source: RefuelSource;
  litres: number;
  occurredAt: string;
  lat?: number | null;
  lon?: number | null;
}

export interface RefuelMatch {
  refuelId: string;
  /** Index of the matched rise in the `rises` array */
  riseIndex: number;
  recordedL: number;
  sensorL: number;
  /** Recorded minus what the sensor saw go in. Positive = more on paper than in the tank */
  diffL: number;
}

export interface MatchResult {
  matches: RefuelMatch[];
  /** Refuels on record that the fuel sensor never saw */
  unmatchedRefuels: RefuelRecord[];
  /** Indexes of rises in the tank with no refuel on record */
  unmatchedRises: number[];
}

export interface MatchOptions {
  /** How far apart in time a record and a sensor rise can be and still match, minutes */
  windowMin?: number;
  /** How far apart in space, when both have a location, km */
  maxDistanceKm?: number;
}

const ms = (iso: string) => Date.parse(iso);

/**
 * Pair each refuel record with the rise in tank level the fuel sensor saw at the same time and place.
 * Records are matched in time order, each to the closest unused rise inside the window.
 */
export function matchRefuels(refuels: RefuelRecord[], rises: FuelLevelEvent[], opts: MatchOptions = {}): MatchResult {
  const windowMs = (opts.windowMin ?? 60) * 60_000;
  const maxDistanceKm = opts.maxDistanceKm ?? 3;
  const used = new Set<number>();
  const matches: RefuelMatch[] = [];
  const unmatchedRefuels: RefuelRecord[] = [];

  for (const r of [...refuels].sort((a, b) => ms(a.occurredAt) - ms(b.occurredAt))) {
    let best = -1;
    let bestDt = Infinity;
    rises.forEach((e, i) => {
      if (used.has(i) || e.type !== 'rise') return;
      // a record can sit before, during or after the rise, depending on when it was typed in
      const t = ms(r.occurredAt);
      const dt = t < ms(e.startedAt) ? ms(e.startedAt) - t : t > ms(e.endedAt) ? t - ms(e.endedAt) : 0;
      if (dt > windowMs) return;
      if (r.lat != null && r.lon != null && haversineKm(r.lat, r.lon, e.lat, e.lon) > maxDistanceKm) return;
      if (dt < bestDt) {
        best = i;
        bestDt = dt;
      }
    });
    if (best < 0) {
      unmatchedRefuels.push(r);
      continue;
    }
    used.add(best);
    const sensorL = rises[best].litres;
    matches.push({ refuelId: r.id, riseIndex: best, recordedL: r.litres, sensorL, diffL: round(r.litres - sensorL, 1) });
  }

  const unmatchedRises = rises.map((e, i) => i).filter((i) => rises[i].type === 'rise' && !used.has(i));
  return { matches, unmatchedRefuels, unmatchedRises };
}

/** Company-level settings for loss detection. Each company can override these. */
export interface LossRules {
  /** Allowed gap between recorded and sensor litres, as a share of the recorded litres */
  tolerancePct: number;
  /** Gaps below this many litres are never flagged, whatever the share */
  minLitres: number;
  /** Gaps above this many litres are critical rather than a warning */
  criticalLitres: number;
  /** Idling longer than this in one go raises an alert, minutes */
  maxIdleMin: number;
  /** A trip using this many times its expected fuel is abnormal */
  abnormalFactor: number;
  /** A vehicle needs at least this much driving history before its trips are judged, km */
  minBaselineKm: number;
}

export const DEFAULT_LOSS_RULES: LossRules = {
  tolerancePct: 3,
  minLitres: 5,
  criticalLitres: 20,
  maxIdleMin: 15,
  abnormalFactor: 1.25,
  minBaselineKm: 400,
};

export type AlertType =
  | 'drop_while_parked'
  | 'refuel_mismatch'
  | 'refuel_without_record'
  | 'refuel_over_capacity'
  | 'abnormal_consumption'
  | 'off_route'
  | 'excessive_idling'
  | 'depot_stock_gap'
  | 'device_tampering'
  | 'rising_consumption';

export interface AlertDraft {
  type: AlertType;
  severity: 'info' | 'warning' | 'critical';
  litres: number | null;
  occurredAt: string;
  lat?: number | null;
  lon?: number | null;
  /** Stable key so re-running the analysis never creates the same alert twice */
  dedupeKey: string;
  details: Record<string, unknown>;
}

const severityFor = (litres: number, rules: LossRules) => (litres >= rules.criticalLitres ? 'critical' : 'warning');

/**
 * Turn the refuel matching, tank drops and data gaps for one vehicle into alerts.
 */
export function fuelAlerts(input: {
  vehicleId: string;
  tankCapacityL: number;
  refuels: RefuelRecord[];
  events: FuelLevelEvent[];
  gaps?: DataGap[];
  rules?: Partial<LossRules>;
  match?: MatchOptions;
}): { alerts: AlertDraft[]; matching: MatchResult } {
  const rules = { ...DEFAULT_LOSS_RULES, ...input.rules };
  const rises = input.events.filter((e) => e.type === 'rise');
  const matching = matchRefuels(input.refuels, rises, input.match);
  const alerts: AlertDraft[] = [];
  const byId = new Map(input.refuels.map((r) => [r.id, r]));

  for (const m of matching.matches) {
    const r = byId.get(m.refuelId)!;
    const rise = rises[m.riseIndex];
    const room = input.tankCapacityL - rise.levelBeforeL;
    if (m.recordedL > room + Math.max(rules.minLitres, input.tankCapacityL * 0.02)) {
      alerts.push({
        type: 'refuel_over_capacity',
        severity: 'critical',
        litres: round(m.recordedL - room, 1),
        occurredAt: r.occurredAt,
        lat: rise.lat,
        lon: rise.lon,
        dedupeKey: `over_capacity:${r.id}`,
        details: { refuelId: r.id, source: r.source, recordedL: m.recordedL, tankCapacityL: input.tankCapacityL, levelBeforeL: rise.levelBeforeL, roomInTankL: round(room, 1) },
      });
    }
    const allowed = Math.max(rules.minLitres, (m.recordedL * rules.tolerancePct) / 100);
    if (m.diffL > allowed) {
      alerts.push({
        type: 'refuel_mismatch',
        severity: severityFor(m.diffL, rules),
        litres: m.diffL,
        occurredAt: r.occurredAt,
        lat: rise.lat,
        lon: rise.lon,
        dedupeKey: `mismatch:${r.id}`,
        details: { refuelId: r.id, source: r.source, recordedL: m.recordedL, sensorL: m.sensorL },
      });
    }
  }

  for (const r of matching.unmatchedRefuels) {
    if (r.litres < rules.minLitres) continue;
    alerts.push({
      type: 'refuel_mismatch',
      severity: severityFor(r.litres, rules),
      litres: r.litres,
      occurredAt: r.occurredAt,
      lat: r.lat,
      lon: r.lon,
      dedupeKey: `mismatch:${r.id}`,
      details: { refuelId: r.id, source: r.source, recordedL: r.litres, sensorL: 0, reason: 'The fuel sensor saw no fuel go in near this time' },
    });
  }

  for (const i of matching.unmatchedRises) {
    const e = rises[i];
    alerts.push({
      type: 'refuel_without_record',
      severity: 'warning',
      litres: e.litres,
      occurredAt: e.startedAt,
      lat: e.lat,
      lon: e.lon,
      dedupeKey: `unrecorded:${input.vehicleId}:${e.startedAt}`,
      details: { sensorL: e.litres, levelBeforeL: e.levelBeforeL, levelAfterL: e.levelAfterL },
    });
  }

  for (const e of input.events) {
    if (e.type !== 'drop_while_parked') continue;
    alerts.push({
      type: 'drop_while_parked',
      severity: severityFor(e.litres, rules),
      litres: e.litres,
      occurredAt: e.startedAt,
      lat: e.lat,
      lon: e.lon,
      dedupeKey: `drop:${input.vehicleId}:${e.startedAt}`,
      details: { levelBeforeL: e.levelBeforeL, levelAfterL: e.levelAfterL, endedAt: e.endedAt },
    });
  }

  for (const g of input.gaps ?? []) {
    alerts.push({
      type: 'device_tampering',
      severity: g.distanceKm >= 10 ? 'critical' : 'warning',
      litres: g.fuelChangeL < 0 ? -g.fuelChangeL : null,
      occurredAt: g.startedAt,
      lat: g.lat,
      lon: g.lon,
      dedupeKey: `gap:${input.vehicleId}:${g.startedAt}`,
      details: { endedAt: g.endedAt, durationMin: Math.round(g.durationS / 60), distanceKm: g.distanceKm, fuelChangeL: g.fuelChangeL },
    });
  }

  return { alerts, matching };
}

/** Idle periods (engine on, not moving) longer than the company's limit. */
export function idlingAlerts(vehicleId: string, periods: IdlePeriod[], rules: Partial<LossRules> = {}): AlertDraft[] {
  const maxS = (rules.maxIdleMin ?? DEFAULT_LOSS_RULES.maxIdleMin) * 60;
  return periods
    .filter((p) => p.durationS > maxS)
    .map((p) => ({
      type: 'excessive_idling' as const,
      severity: 'warning' as const,
      litres: p.fuelUsedL,
      occurredAt: p.startedAt,
      lat: p.lat,
      lon: p.lon,
      dedupeKey: `idle:${vehicleId}:${p.startedAt}`,
      details: { durationMin: Math.round(p.durationS / 60), endedAt: p.endedAt, fuelUsedL: p.fuelUsedL },
    }));
}

/** Litres per 100 km for one combination of conditions, learned from a vehicle's history. */
export interface BaselineRate {
  key: string;
  lPer100km: number;
  distanceKm: number;
}

type BaselineSeg = Pick<Segment, 'gradient' | 'speedBand' | 'loadKg'>;

/** Load in 4-tonne bands. Fuel on a climb depends heavily on weight, so "part load" alone is too coarse. */
export const loadBand = (loadKg: number | undefined | null) => (loadKg == null ? '-' : String(Math.round(loadKg / 4000)));

/**
 * Keys from most to least specific. When a vehicle has too little history for the exact combination,
 * the next coarser one is used. Only the first two levels include load: a trip priced mostly from the
 * load-blind levels has no fair comparison yet, so it is not judged.
 */
export const BASELINE_KEYS: ((s: BaselineSeg) => string)[] = [
  (s) => `g:${s.gradient ?? '-'}|v:${s.speedBand ?? '-'}|t:${loadBand(s.loadKg)}`,
  (s) => `g:${s.gradient ?? '-'}|t:${loadBand(s.loadKg)}`,
  (s) => `g:${s.gradient ?? '-'}|v:${s.speedBand ?? '-'}`,
  (s) => `g:${s.gradient ?? '-'}`,
];
const LOAD_AWARE_LEVELS = 2;

/** A vehicle's normal consumption per condition combination, from its past segments. */
export interface Baseline {
  rates: Map<string, BaselineRate>;
  overallLPer100km: number | null;
  distanceKm: number;
}

export function buildBaseline(history: Segment[], minDistanceKm = 5): Baseline {
  const acc = new Map<string, { d: number; f: number }>();
  let d = 0;
  let f = 0;
  for (const s of history) {
    if (s.kind !== 'moving' || s.distanceKm <= 0) continue;
    for (const keyOf of BASELINE_KEYS) {
      const k = keyOf(s);
      const a = acc.get(k) ?? { d: 0, f: 0 };
      a.d += s.distanceKm;
      a.f += s.fuelUsedL;
      acc.set(k, a);
    }
    d += s.distanceKm;
    f += s.fuelUsedL;
  }
  const rates = new Map<string, BaselineRate>();
  for (const [key, a] of acc) {
    if (a.d >= minDistanceKm) rates.set(key, { key, lPer100km: round((a.f / a.d) * 100, 2), distanceKm: round(a.d, 1) });
  }
  return { rates, overallLPer100km: d > 0 ? round((f / d) * 100, 2) : null, distanceKm: round(d, 1) };
}

/** The most specific known rate for a segment's conditions, and how specific it was (0 = exact). */
export function baselineRate(s: BaselineSeg, baseline: Baseline): { lPer100km: number; level: number } | null {
  for (let level = 0; level < BASELINE_KEYS.length; level++) {
    const rate = baseline.rates.get(BASELINE_KEYS[level](s));
    if (rate) return { lPer100km: rate.lPer100km, level };
  }
  return baseline.overallLPer100km === null ? null : { lPer100km: baseline.overallLPer100km, level: BASELINE_KEYS.length };
}

/**
 * Litres a trip should have used, given the conditions it actually met and the vehicle's normal rate in each.
 * The same calculation powers trip fuel allocation later, using a route's expected conditions instead.
 * `coveredShare` = share of the distance priced from history with a similar load.
 */
export function expectedFuel(segments: Segment[], baseline: Baseline): { expectedL: number; coveredShare: number } | null {
  if (baseline.overallLPer100km === null) return null;
  let expected = 0;
  let covered = 0;
  let total = 0;
  for (const s of segments) {
    if (s.kind !== 'moving') continue;
    const rate = baselineRate(s, baseline)!;
    expected += (s.distanceKm * rate.lPer100km) / 100;
    total += s.distanceKm;
    if (rate.level < LOAD_AWARE_LEVELS) covered += s.distanceKm;
  }
  return { expectedL: round(expected, 1), coveredShare: total > 0 ? round(covered / total, 2) : 0 };
}

/** Flag a trip that used far more fuel than this vehicle normally uses in the same conditions. */
export function abnormalConsumptionAlert(
  tripSegments: Segment[],
  baseline: Baseline,
  rules: Partial<LossRules> = {},
): AlertDraft | null {
  const factor = rules.abnormalFactor ?? DEFAULT_LOSS_RULES.abnormalFactor;
  const minLitres = rules.minLitres ?? DEFAULT_LOSS_RULES.minLitres;
  if (baseline.distanceKm < (rules.minBaselineKm ?? DEFAULT_LOSS_RULES.minBaselineKm)) return null;
  const moving = tripSegments.filter((s) => s.kind === 'moving');
  const distanceKm = moving.reduce((a, s) => a + s.distanceKm, 0);
  if (distanceKm < 20) return null;
  const exp = expectedFuel(moving, baseline);
  // need most of the trip's conditions to have been seen before, or the comparison is unfair
  if (!exp || exp.coveredShare < 0.6 || exp.expectedL <= 0) return null;
  const actual = moving.reduce((a, s) => a + s.fuelUsedL, 0);
  const extra = actual - exp.expectedL;
  if (actual < exp.expectedL * factor || extra < minLitres) return null;
  const first = moving[0];
  return {
    type: 'abnormal_consumption',
    severity: actual >= exp.expectedL * (factor + 0.25) ? 'critical' : 'warning',
    litres: round(extra, 1),
    occurredAt: first.startedAt,
    lat: first.startLat,
    lon: first.startLon,
    dedupeKey: `abnormal:${first.tripId ?? first.vehicleId + ':' + first.startedAt}`,
    details: {
      tripId: first.tripId,
      distanceKm: round(distanceKm, 1),
      actualL: round(actual, 1),
      expectedL: exp.expectedL,
      actualLPer100km: round((actual / distanceKm) * 100, 1),
      expectedLPer100km: round((exp.expectedL / distanceKm) * 100, 1),
    },
  };
}

export interface FuelBalance {
  startLevelL: number;
  endLevelL: number;
  /** What people recorded putting in */
  refueledRecordedL: number;
  /** What the fuel sensor saw go in */
  refueledSensorL: number;
  /** Burned by the engine, moving and idling */
  usedL: number;
  /** start + sensor refuels − used − end. Positive = fuel that left the tank without being burned */
  unexplainedL: number;
  /** Recorded refuels − sensor refuels. Positive = paid for but never reached the tank */
  unaccountedPurchasesL: number;
}

/** The fuel balance for one vehicle over a period: in, used, left, and what can't be explained. */
export function fuelBalance(input: {
  startLevelL: number;
  endLevelL: number;
  refueledRecordedL: number;
  refueledSensorL: number;
  usedL: number;
}): FuelBalance {
  return {
    ...input,
    startLevelL: round(input.startLevelL, 1),
    endLevelL: round(input.endLevelL, 1),
    refueledRecordedL: round(input.refueledRecordedL, 1),
    refueledSensorL: round(input.refueledSensorL, 1),
    usedL: round(input.usedL, 1),
    unexplainedL: round(input.startLevelL + input.refueledSensorL - input.usedL - input.endLevelL, 1),
    unaccountedPurchasesL: round(input.refueledRecordedL - input.refueledSensorL, 1),
  };
}

/** Depot tank stock: what should be in the tank against what a dip measured. */
export function depotStock(input: { openingL: number; deliveredL: number; dispensedL: number; dipL?: number | null }) {
  const expectedL = round(input.openingL + input.deliveredL - input.dispensedL, 1);
  const gapL = input.dipL == null ? null : round(expectedL - input.dipL, 1);
  return { ...input, expectedL, gapL };
}

function round(n: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
