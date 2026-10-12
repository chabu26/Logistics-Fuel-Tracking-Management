import type { TelemetryReading } from '../src/types';

export interface Leg {
  /** seconds this leg lasts */
  durationS: number;
  speedKmh: number;
  /** metres climbed per km (negative = downhill) */
  climbMPerKm?: number;
  /** litres burned per hour on this leg */
  lPerHour: number;
  ignition?: boolean;
  /** change the tank level by this much at the start of the leg (refuel or siphon) */
  tankChangeL?: number;
}

/**
 * Build tracker readings for a vehicle driving north from Lusaka through a series of legs.
 * Every reading is `stepS` seconds apart. Distance comes from speed; fuel from litres per hour.
 */
export function drive(legs: Leg[], opts: { start?: string; stepS?: number; startLevelL?: number; can?: boolean } = {}): TelemetryReading[] {
  const stepS = opts.stepS ?? 10;
  let time = Date.parse(opts.start ?? '2026-10-06T06:00:00Z');
  let lat = -15.4167;
  const lon = 28.2833;
  let alt = 1280;
  let odo = 10000;
  let level = opts.startLevelL ?? 300;
  let used = 0;
  const out: TelemetryReading[] = [];
  const push = (speed: number, ignition: boolean) =>
    out.push({
      time: new Date(time).toISOString(),
      lat,
      lon,
      altitudeM: alt,
      speedKmh: speed,
      headingDeg: 0,
      ignition,
      fuelLevelL: level,
      fuelUsedTotalL: opts.can === false ? undefined : used,
      odometerKm: odo,
    });
  push(0, legs[0]?.ignition ?? true);
  for (const leg of legs) {
    level += leg.tankChangeL ?? 0;
    const steps = Math.round(leg.durationS / stepS);
    for (let i = 0; i < steps; i++) {
      time += stepS * 1000;
      const km = (leg.speedKmh * stepS) / 3600;
      odo += km;
      lat += km / 111; // heading north
      alt += km * (leg.climbMPerKm ?? 0);
      const l = (leg.lPerHour * stepS) / 3600;
      used += l;
      level -= l;
      push(leg.speedKmh, leg.ignition ?? true);
    }
  }
  return out;
}
