/**
 * Demo company used by the seed script and the tracker simulator.
 * Route points are approximate (lat, lon, altitude in metres) and good enough to produce realistic
 * gradients: the Zambezi escarpment to Chirundu and the Luangwa valley on the Great East Road.
 */

export interface DemoRoutePoint {
  lat: number;
  lon: number;
  altM: number;
  /** The road from this point to the next one bends a lot (escarpments, hills) */
  winding?: boolean;
}

export interface DemoRoute {
  code: string;
  name: string;
  surface: 'tar' | 'gravel';
  /** Km at each end of the route driven in town traffic */
  urbanKm: number;
  points: DemoRoutePoint[];
}

export interface DemoVehicle {
  registration: string;
  kind: 'truck' | 'bus' | 'van';
  make: string;
  model: string;
  year: number;
  tankCapacityL: number;
  expectedLPer100km: number;
  maxLoadKg?: number;
  seats?: number;
  deviceId: string;
  /** Newer engines report litres burned over the CAN bus; older ones rely on the tank sensor only */
  canFuelCounter: boolean;
  /** Route codes this vehicle usually runs */
  routes: string[];
  driverEmail: string;
}

export interface DemoUser {
  fullName: string;
  email: string;
  phone: string;
  role: 'admin' | 'fleet_manager' | 'owner' | 'driver' | 'depot_attendant';
}

/** Routes start and end at the company depot in Lusaka's light industrial area. */
const LUSAKA = { lat: -15.43, lon: 28.25, altM: 1270 };

export const DEMO_ROUTES: DemoRoute[] = [
  {
    code: 'LSK-KBW',
    name: 'Lusaka – Kabwe (T2 North)',
    surface: 'tar',
    urbanKm: 12,
    points: [
      LUSAKA,
      { lat: -15.3, lon: 28.29, altM: 1240 },
      { lat: -15.17, lon: 28.31, altM: 1200 },
      { lat: -15.05, lon: 28.3, altM: 1150 },
      { lat: -14.88, lon: 28.36, altM: 1180 },
      { lat: -14.7, lon: 28.4, altM: 1170 },
      { lat: -14.4469, lon: 28.4464, altM: 1180 },
    ],
  },
  {
    code: 'LSK-CHR',
    name: 'Lusaka – Chirundu (T2 South, Zambezi escarpment)',
    surface: 'tar',
    urbanKm: 12,
    points: [
      LUSAKA,
      { lat: -15.56, lon: 28.27, altM: 1220 },
      { lat: -15.77, lon: 28.18, altM: 1000 },
      { lat: -15.8, lon: 28.35, altM: 1050 },
      { lat: -15.88, lon: 28.55, altM: 1150 },
      { lat: -15.96, lon: 28.7, altM: 1100, winding: true },
      { lat: -16.0, lon: 28.78, altM: 700, winding: true },
      { lat: -16.03, lon: 28.85, altM: 380 },
    ],
  },
  {
    code: 'LSK-CHP',
    name: 'Lusaka – Chipata (Great East Road)',
    surface: 'tar',
    urbanKm: 15,
    points: [
      LUSAKA,
      { lat: -15.33, lon: 28.68, altM: 1150 },
      { lat: -15.08, lon: 29.63, altM: 1050 },
      { lat: -15.05, lon: 30.0, altM: 800, winding: true },
      { lat: -15.0, lon: 30.22, altM: 380, winding: true },
      { lat: -14.95, lon: 30.45, altM: 750 },
      { lat: -14.56, lon: 30.81, altM: 900 },
      { lat: -14.24, lon: 31.33, altM: 1000 },
      { lat: -14.06, lon: 32.05, altM: 1050 },
      { lat: -13.6333, lon: 32.65, altM: 1150 },
    ],
  },
  {
    code: 'LSK-LVS',
    name: 'Lusaka – Livingstone (T1)',
    surface: 'tar',
    urbanKm: 12,
    points: [
      LUSAKA,
      { lat: -15.77, lon: 28.18, altM: 1000 },
      { lat: -15.86, lon: 27.75, altM: 1050 },
      { lat: -16.28, lon: 27.48, altM: 1100 },
      { lat: -16.81, lon: 26.98, altM: 1300 },
      { lat: -17.03, lon: 26.49, altM: 1250 },
      { lat: -17.32, lon: 26.2, altM: 1100 },
      { lat: -17.85, lon: 25.86, altM: 900 },
    ],
  },
  {
    code: 'LSK-CITY',
    name: 'Lusaka city deliveries',
    surface: 'tar',
    urbanKm: 100,
    points: [
      { lat: -15.43, lon: 28.25, altM: 1270 },
      { lat: -15.416, lon: 28.283, altM: 1280 },
      { lat: -15.42, lon: 28.33, altM: 1290 },
      { lat: -15.44, lon: 28.32, altM: 1275 },
      { lat: -15.45, lon: 28.3, altM: 1265 },
      { lat: -15.43, lon: 28.25, altM: 1270 },
    ],
  },
];

export const DEMO_DEPOT = { name: 'Lusaka depot tank 1', capacityL: 20000, openingLevelL: 8000, lat: -15.43, lon: 28.25 };

export const DEMO_USERS: DemoUser[] = [
  { fullName: 'Natasha Mwansa', email: 'admin@demo.zm', phone: '+260971000001', role: 'admin' },
  { fullName: 'Patrick Chileshe', email: 'fleet@demo.zm', phone: '+260971000002', role: 'fleet_manager' },
  { fullName: 'Grace Mumba', email: 'owner@demo.zm', phone: '+260971000003', role: 'owner' },
  { fullName: 'Joseph Chilufya', email: 'depot@demo.zm', phone: '+260971000004', role: 'depot_attendant' },
  { fullName: 'Mwila Banda', email: 'mwila@demo.zm', phone: '+260971000011', role: 'driver' },
  { fullName: 'Chanda Phiri', email: 'chanda@demo.zm', phone: '+260971000012', role: 'driver' },
  { fullName: 'Bwalya Mulenga', email: 'bwalya@demo.zm', phone: '+260971000013', role: 'driver' },
  { fullName: 'Mutale Zulu', email: 'mutale@demo.zm', phone: '+260971000014', role: 'driver' },
  { fullName: 'Kunda Tembo', email: 'kunda@demo.zm', phone: '+260971000015', role: 'driver' },
  { fullName: 'Mapalo Lungu', email: 'mapalo@demo.zm', phone: '+260971000016', role: 'driver' },
  { fullName: 'Musonda Sakala', email: 'musonda@demo.zm', phone: '+260971000017', role: 'driver' },
];

/** Password for every demo user. Change it before showing the demo to anyone outside the team. */
export const DEMO_PASSWORD = 'demo1234';

export const DEMO_VEHICLES: DemoVehicle[] = [
  { registration: 'ALB 1234', kind: 'truck', make: 'Scania', model: 'R460', year: 2021, tankCapacityL: 600, expectedLPer100km: 38, maxLoadKg: 30000, deviceId: 'TRK-0001', canFuelCounter: true, routes: ['LSK-CHR', 'LSK-KBW'], driverEmail: 'mwila@demo.zm' },
  { registration: 'BAF 5521', kind: 'truck', make: 'Volvo', model: 'FH 440', year: 2017, tankCapacityL: 500, expectedLPer100km: 40, maxLoadKg: 28000, deviceId: 'TRK-0002', canFuelCounter: false, routes: ['LSK-CHP'], driverEmail: 'chanda@demo.zm' },
  { registration: 'BCD 7789', kind: 'truck', make: 'MAN', model: 'TGS 33.440', year: 2019, tankCapacityL: 400, expectedLPer100km: 39, maxLoadKg: 26000, deviceId: 'TRK-0003', canFuelCounter: true, routes: ['LSK-LVS', 'LSK-KBW'], driverEmail: 'bwalya@demo.zm' },
  { registration: 'BAE 4471', kind: 'bus', make: 'Yutong', model: 'ZK6122', year: 2018, tankCapacityL: 300, expectedLPer100km: 30, seats: 65, deviceId: 'TRK-0004', canFuelCounter: false, routes: ['LSK-CHP', 'LSK-LVS'], driverEmail: 'mutale@demo.zm' },
  { registration: 'BAH 2210', kind: 'bus', make: 'Higer', model: 'KLQ6129', year: 2020, tankCapacityL: 300, expectedLPer100km: 29, seats: 60, deviceId: 'TRK-0005', canFuelCounter: true, routes: ['LSK-LVS', 'LSK-KBW'], driverEmail: 'kunda@demo.zm' },
  { registration: 'BBC 9032', kind: 'bus', make: 'Golden Dragon', model: 'XML6127', year: 2016, tankCapacityL: 280, expectedLPer100km: 31, seats: 62, deviceId: 'TRK-0006', canFuelCounter: false, routes: ['LSK-CHR', 'LSK-KBW'], driverEmail: 'mapalo@demo.zm' },
  { registration: 'BAJ 3307', kind: 'van', make: 'Toyota', model: 'HiAce', year: 2022, tankCapacityL: 70, expectedLPer100km: 11, maxLoadKg: 1200, deviceId: 'TRK-0007', canFuelCounter: true, routes: ['LSK-CITY'], driverEmail: 'musonda@demo.zm' },
];
