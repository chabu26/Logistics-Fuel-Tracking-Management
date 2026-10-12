/** One reading sent by a vehicle's tracker (GPS + fuel sensor + CAN data). */
export interface TelemetryReading {
  /** ISO 8601 timestamp (UTC) */
  time: string;
  lat: number;
  lon: number;
  altitudeM: number;
  speedKmh: number;
  /** Direction of travel in degrees, 0 = north */
  headingDeg: number;
  ignition: boolean;
  /** Litres in the tank, from the fuel level sensor (noisy) */
  fuelLevelL: number;
  /** Cumulative litres burned by the engine, from the CAN bus (precise). Optional: not every vehicle exposes it. */
  fuelUsedTotalL?: number;
  odometerKm: number;
  harshAccel?: boolean;
  harshBrake?: boolean;
}

export type VehicleKind = 'truck' | 'bus' | 'van';
export type RefuelSource = 'depot' | 'fuel_card' | 'cash';

export type SpeedBand = '0-20' | '20-40' | '40-60' | '60-80' | '80-100' | '100+';
export type Gradient = 'uphill' | 'flat' | 'downhill';
export type Traffic = 'free' | 'slow' | 'stop_start';
export type RoadShape = 'straight' | 'winding';
export type TimeOfDay = 'peak' | 'off_peak' | 'night';
export type LoadClass = 'empty' | 'partial' | 'full';
export type Surface = 'tar' | 'gravel';
export type Weather = 'dry' | 'rain';
export type SegmentKind = 'moving' | 'idle';

/** Context known about the trip that the readings belong to. */
export interface TripContext {
  tripId?: string;
  vehicleId: string;
  driverId?: string;
  routeId?: string;
  /** Load carried, kg. For buses this can be estimated from passengers. */
  loadKg?: number;
  passengers?: number;
  /** Max payload of the vehicle, kg, used to classify load as empty / partial / full */
  maxLoadKg?: number;
  surface?: Surface;
  weather?: Weather;
  /** Offset of local time from UTC in hours. Zambia = +2. */
  utcOffsetHours?: number;
}

/** A short piece of a trip with every condition tagged and the litres it used. */
export interface Segment {
  kind: SegmentKind;
  startedAt: string;
  endedAt: string;
  distanceKm: number;
  durationS: number;
  fuelUsedL: number;
  /** How fuel used was measured */
  fuelSource: 'can_counter' | 'level_sensor';
  avgSpeedKmh: number;
  speedBand: SpeedBand | null;
  gradientPct: number;
  gradient: Gradient | null;
  traffic: Traffic | null;
  roadShape: RoadShape | null;
  timeOfDay: TimeOfDay;
  loadClass: LoadClass | null;
  harshEvents: number;
  startLat: number;
  startLon: number;
  // copied from trip context
  vehicleId: string;
  tripId?: string;
  driverId?: string;
  routeId?: string;
  loadKg?: number;
  passengers?: number;
  surface?: Surface;
  weather?: Weather;
}

/** Fuel level events found in the readings (refuels and drops). */
export interface FuelLevelEvent {
  type: 'rise' | 'drop_while_parked';
  startedAt: string;
  endedAt: string;
  litres: number;
  /** Smoothed tank level just before and just after the event, litres */
  levelBeforeL: number;
  levelAfterL: number;
  lat: number;
  lon: number;
}

/** A stretch with no readings while the vehicle still moved: the tracker was off, unplugged or out of signal. */
export interface DataGap {
  startedAt: string;
  endedAt: string;
  durationS: number;
  /** Distance covered during the gap, from the odometer or GPS, km */
  distanceKm: number;
  /** Fuel level change across the gap, litres (negative = fuel went down) */
  fuelChangeL: number;
  lat: number;
  lon: number;
}
