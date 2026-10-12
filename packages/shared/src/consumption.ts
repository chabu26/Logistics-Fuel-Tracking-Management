import type { Segment } from './types';

/** Conditions a fleet manager can break consumption down by. */
export const CONDITION_DIMENSIONS = [
  'speedBand',
  'gradient',
  'traffic',
  'roadShape',
  'timeOfDay',
  'loadClass',
  'surface',
  'weather',
  'routeId',
  'driverId',
] as const;
export type ConditionDimension = (typeof CONDITION_DIMENSIONS)[number];

export interface ConsumptionGroup {
  /** The condition values of this group, e.g. { gradient: 'uphill', speedBand: '20-40' } */
  conditions: Partial<Record<ConditionDimension, string | null>>;
  distanceKm: number;
  fuelUsedL: number;
  durationS: number;
  segments: number;
  /** Litres per 100 km */
  lPer100km: number | null;
  /** True when the group has enough distance for its figure to be trusted */
  enoughData: boolean;
}

export interface SummaryOptions {
  /** Minimum distance before a group's L/100km is trusted, km */
  minDistanceKm?: number;
}

/** Group moving segments by the chosen conditions and compute L/100km for each group. */
export function summarizeConsumption(
  segments: Segment[],
  dimensions: ConditionDimension[],
  opts: SummaryOptions = {},
): ConsumptionGroup[] {
  const minDistanceKm = opts.minDistanceKm ?? 10;
  const groups = new Map<string, ConsumptionGroup>();
  for (const s of segments) {
    if (s.kind !== 'moving') continue;
    const conditions: ConsumptionGroup['conditions'] = {};
    for (const d of dimensions) conditions[d] = (s[d] as string | null | undefined) ?? null;
    const key = JSON.stringify(conditions);
    let g = groups.get(key);
    if (!g) {
      g = { conditions, distanceKm: 0, fuelUsedL: 0, durationS: 0, segments: 0, lPer100km: null, enoughData: false };
      groups.set(key, g);
    }
    g.distanceKm += s.distanceKm;
    g.fuelUsedL += s.fuelUsedL;
    g.durationS += s.durationS;
    g.segments++;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    distanceKm: round(g.distanceKm, 1),
    fuelUsedL: round(g.fuelUsedL, 1),
    lPer100km: g.distanceKm > 0 ? Math.max(0, round((g.fuelUsedL / g.distanceKm) * 100, 1)) : null,
    enoughData: g.distanceKm >= minDistanceKm,
  }));
}

export interface IdleSummary {
  durationS: number;
  fuelUsedL: number;
  /** Litres per hour while idling */
  lPerHour: number | null;
  periods: number;
}

export function summarizeIdling(segments: Segment[]): IdleSummary {
  const idle = segments.filter((s) => s.kind === 'idle');
  const durationS = idle.reduce((a, s) => a + s.durationS, 0);
  const fuelUsedL = idle.reduce((a, s) => a + s.fuelUsedL, 0);
  return {
    durationS,
    fuelUsedL: round(fuelUsedL, 1),
    lPerHour: durationS > 0 ? round(fuelUsedL / (durationS / 3600), 2) : null,
    periods: idle.length,
  };
}

export interface ConsumptionInsight {
  overall: { distanceKm: number; fuelUsedL: number; lPer100km: number | null };
  idling: IdleSummary;
  /** Highest L/100km among groups with enough data */
  worst: ConsumptionGroup | null;
  /** Lowest L/100km among groups with enough data */
  best: ConsumptionGroup | null;
  groups: ConsumptionGroup[];
}

/**
 * The fleet manager's question: "under which combination of conditions does this vehicle use the most
 * and the least fuel?" Groups by the given conditions and picks the extremes among reliable groups.
 */
export function consumptionInsight(
  segments: Segment[],
  dimensions: ConditionDimension[],
  opts: SummaryOptions = {},
): ConsumptionInsight {
  const groups = summarizeConsumption(segments, dimensions, opts).sort(
    (a, b) => (b.lPer100km ?? -1) - (a.lPer100km ?? -1),
  );
  const reliable = groups.filter((g) => g.enoughData && g.lPer100km !== null);
  const moving = segments.filter((s) => s.kind === 'moving');
  const distanceKm = moving.reduce((a, s) => a + s.distanceKm, 0);
  const fuelUsedL = moving.reduce((a, s) => a + s.fuelUsedL, 0);
  return {
    overall: {
      distanceKm: round(distanceKm, 1),
      fuelUsedL: round(fuelUsedL, 1),
      lPer100km: distanceKm > 0 ? round((fuelUsedL / distanceKm) * 100, 1) : null,
    },
    idling: summarizeIdling(segments),
    worst: reliable[0] ?? null,
    best: reliable[reliable.length - 1] ?? null,
    groups,
  };
}

function round(n: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
