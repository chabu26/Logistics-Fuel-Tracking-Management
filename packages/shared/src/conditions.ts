import type { Gradient, LoadClass, RoadShape, SpeedBand, TimeOfDay, Traffic } from './types';

/** Thresholds used to tag conditions. Companies will be able to override these later. */
export const CONDITION_THRESHOLDS = {
  /** Gradient (%) above which a segment counts as uphill, below minus this as downhill */
  gradientPct: 2,
  /** Average speed (km/h) below which a moving segment counts as slow traffic */
  slowTrafficKmh: 30,
  /** Number of stops inside one segment that makes it stop-start */
  stopStartStops: 2,
  /** Speed (km/h) under which the vehicle counts as stopped */
  stoppedKmh: 3,
  /** Total heading change (degrees per km) above which a road counts as winding */
  windingDegPerKm: 120,
  /** Load share of max payload: below = empty, above = full, between = partial */
  emptyLoadShare: 0.1,
  fullLoadShare: 0.8,
} as const;

export const SPEED_BANDS: SpeedBand[] = ['0-20', '20-40', '40-60', '60-80', '80-100', '100+'];

export function speedBand(kmh: number): SpeedBand {
  if (kmh < 20) return '0-20';
  if (kmh < 40) return '20-40';
  if (kmh < 60) return '40-60';
  if (kmh < 80) return '60-80';
  if (kmh < 100) return '80-100';
  return '100+';
}

export function gradientClass(pct: number): Gradient {
  if (pct > CONDITION_THRESHOLDS.gradientPct) return 'uphill';
  if (pct < -CONDITION_THRESHOLDS.gradientPct) return 'downhill';
  return 'flat';
}

export function trafficClass(avgSpeedKmh: number, stops: number): Traffic {
  if (stops >= CONDITION_THRESHOLDS.stopStartStops) return 'stop_start';
  if (avgSpeedKmh < CONDITION_THRESHOLDS.slowTrafficKmh) return 'slow';
  return 'free';
}

export function roadShape(headingChangeDeg: number, distanceKm: number): RoadShape {
  if (distanceKm <= 0) return 'straight';
  return headingChangeDeg / distanceKm > CONDITION_THRESHOLDS.windingDegPerKm ? 'winding' : 'straight';
}

/**
 * Peak = weekday 06:00–09:00 and 16:00–19:00 local time, night = 20:00–05:00.
 */
export function timeOfDay(isoTime: string, utcOffsetHours = 2): TimeOfDay {
  const d = new Date(Date.parse(isoTime) + utcOffsetHours * 3600_000);
  const h = d.getUTCHours();
  const weekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
  if (h >= 20 || h < 5) return 'night';
  if (weekday && ((h >= 6 && h < 9) || (h >= 16 && h < 19))) return 'peak';
  return 'off_peak';
}

export function loadClass(loadKg: number | undefined, maxLoadKg: number | undefined): LoadClass | null {
  if (loadKg === undefined || !maxLoadKg) return null;
  const share = loadKg / maxLoadKg;
  if (share < CONDITION_THRESHOLDS.emptyLoadShare) return 'empty';
  if (share > CONDITION_THRESHOLDS.fullLoadShare) return 'full';
  return 'partial';
}

/** Average adult passenger + luggage, kg. Used to estimate bus load from a passenger count. */
export const KG_PER_PASSENGER = 85;

export function busLoadKg(passengers: number): number {
  return passengers * KG_PER_PASSENGER;
}
