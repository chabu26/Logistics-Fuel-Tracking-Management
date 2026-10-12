import type { DemoVehicle } from '@fleetfuel/shared/demo';

/** Physical traits that decide how much fuel a vehicle burns. */
export interface VehiclePhysics {
  emptyMassKg: number;
  /** Drag coefficient × frontal area, m² */
  cdA: number;
  /** Rolling resistance coefficient */
  crr: number;
  maxPowerW: number;
  /** Share of the fuel's energy that reaches the wheels */
  efficiency: number;
  idleLPerHour: number;
  /** Comfortable cruising speed on open road, km/h */
  cruiseKmh: number;
  /** Speed held on winding roads and steep descents, km/h */
  cautiousKmh: number;
}

const DIESEL_J_PER_L = 38.6e6;
const G = 9.81;
const AIR_DENSITY = 1.15; // Zambian plateau, ~1 200 m

export function physicsFor(v: DemoVehicle): VehiclePhysics {
  const age = Math.max(0, 2026 - v.year);
  const wear = Math.min(0.03, age * 0.003); // older engines are a little less efficient
  switch (v.kind) {
    case 'truck':
      return { emptyMassKg: 15000, cdA: 6.0, crr: 0.0065, maxPowerW: 320_000, efficiency: 0.37 - wear, idleLPerHour: 3.2, cruiseKmh: 76, cautiousKmh: 45 };
    case 'bus':
      return { emptyMassKg: 13000, cdA: 6.5, crr: 0.007, maxPowerW: 250_000, efficiency: 0.35 - wear, idleLPerHour: 2.8, cruiseKmh: 92, cautiousKmh: 50 };
    case 'van':
      return { emptyMassKg: 2100, cdA: 1.6, crr: 0.009, maxPowerW: 110_000, efficiency: 0.3 - wear, idleLPerHour: 0.9, cruiseKmh: 100, cautiousKmh: 60 };
  }
}

/** Force resisting motion at a speed and gradient, newtons (gravity, rolling, air). */
export function resistanceN(p: VehiclePhysics, massKg: number, speedMs: number, grade: number): number {
  const theta = Math.atan(grade);
  return massKg * G * (p.crr * Math.cos(theta) + Math.sin(theta)) + 0.5 * AIR_DENSITY * p.cdA * speedMs * speedMs;
}

/** Most acceleration the engine can give at this speed and gradient, m/s² (negative = can't hold speed). */
export function maxAccel(p: VehiclePhysics, massKg: number, speedMs: number, grade: number): number {
  const drive = p.maxPowerW / Math.max(speedMs, 3);
  return Math.min(1.2, (drive - resistanceN(p, massKg, speedMs, grade)) / massKg);
}

/**
 * Litres burned in `dtS` seconds. Engine friction costs the idle rate all the time; on top of that, every
 * joule pushed to the wheels costs fuel. When coasting downhill the engine cuts fuel almost to nothing.
 * `wasteFactor` > 1 models a faulty injector or a heavy right foot.
 */
export function litresBurned(p: VehiclePhysics, massKg: number, speedMs: number, accel: number, grade: number, dtS: number, wasteFactor = 1): number {
  const wheelW = (massKg * accel + resistanceN(p, massKg, speedMs, grade)) * speedMs;
  const idle = (p.idleLPerHour / 3600) * dtS;
  if (wheelW <= 0) return speedMs > 1 ? idle * 0.15 : idle;
  return (idle + (wheelW / (p.efficiency * DIESEL_J_PER_L)) * dtS) * wasteFactor;
}
