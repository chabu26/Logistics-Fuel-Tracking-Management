import type { Segment, TelemetryReading } from '@fleetfuel/shared';

/** Telemetry columns, in the order used by SELECTs that feed `toReading`. */
export const TELEMETRY_COLUMNS =
  'time, lat, lon, altitude_m, speed_kmh, heading_deg, ignition, fuel_level_l, fuel_used_total_l, odometer_km, harsh_accel, harsh_brake';

export function toReading(r: Record<string, any>): TelemetryReading {
  return {
    time: (r.time as Date).toISOString(),
    lat: r.lat,
    lon: r.lon,
    altitudeM: r.altitude_m ?? 0,
    speedKmh: r.speed_kmh,
    headingDeg: r.heading_deg ?? 0,
    ignition: r.ignition,
    fuelLevelL: r.fuel_level_l ?? 0,
    fuelUsedTotalL: r.fuel_used_total_l ?? undefined,
    odometerKm: r.odometer_km ?? 0,
    harshAccel: r.harsh_accel,
    harshBrake: r.harsh_brake,
  };
}

/** Segment fields stored in trip_segments, as [column, Segment key]. */
export const SEGMENT_FIELDS: [string, keyof Segment][] = [
  ['kind', 'kind'],
  ['started_at', 'startedAt'],
  ['ended_at', 'endedAt'],
  ['distance_km', 'distanceKm'],
  ['duration_s', 'durationS'],
  ['fuel_used_l', 'fuelUsedL'],
  ['fuel_source', 'fuelSource'],
  ['avg_speed_kmh', 'avgSpeedKmh'],
  ['speed_band', 'speedBand'],
  ['gradient_pct', 'gradientPct'],
  ['gradient', 'gradient'],
  ['traffic', 'traffic'],
  ['road_shape', 'roadShape'],
  ['time_of_day', 'timeOfDay'],
  ['load_class', 'loadClass'],
  ['load_kg', 'loadKg'],
  ['passengers', 'passengers'],
  ['harsh_events', 'harshEvents'],
  ['surface', 'surface'],
  ['weather', 'weather'],
  ['start_lat', 'startLat'],
  ['start_lon', 'startLon'],
  ['vehicle_id', 'vehicleId'],
  ['trip_id', 'tripId'],
  ['driver_id', 'driverId'],
  ['route_id', 'routeId'],
];

export function toSegment(r: Record<string, any>): Segment {
  const s: Record<string, unknown> = {};
  for (const [col, key] of SEGMENT_FIELDS) {
    const v = r[col];
    s[key] = v instanceof Date ? v.toISOString() : v ?? undefined;
  }
  for (const k of ['speedBand', 'gradient', 'traffic', 'roadShape', 'loadClass'] as const) s[k] = s[k] ?? null;
  return s as unknown as Segment;
}

/** Map a SQL row (snake_case) to camelCase for API responses. */
export function camel<T extends Record<string, any>>(row: T): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
}
