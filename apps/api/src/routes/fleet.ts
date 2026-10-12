import { z } from 'zod';
import { CAN, hashPassword } from '../auth';
import { query, queryOne } from '../db';
import { notFound, parse, type Router } from '../http';
import { camel } from '../mappers';

const Vehicle = z.object({
  registration: z.string().min(2),
  kind: z.enum(['truck', 'bus', 'van']),
  make: z.string().optional(),
  model: z.string().optional(),
  year: z.number().int().min(1980).max(2100).optional(),
  fuelType: z.enum(['diesel', 'petrol']).default('diesel'),
  tankCapacityL: z.number().positive(),
  expectedLPer100km: z.number().positive().optional(),
  maxLoadKg: z.number().positive().optional(),
  seats: z.number().int().positive().optional(),
  deviceId: z.string().optional(),
  canFuelCounter: z.boolean().default(false),
});

const VehicleUpdate = Vehicle.partial().extend({ active: z.boolean().optional() });

const Route = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  distanceKm: z.number().positive().optional(),
  surface: z.enum(['tar', 'gravel']).default('tar'),
  /** [[lon, lat], ...] */
  path: z.array(z.tuple([z.number(), z.number()])).optional(),
});

const User = z.object({
  fullName: z.string().min(2),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  role: z.enum(['admin', 'fleet_manager', 'owner', 'driver', 'depot_attendant']),
  password: z.string().min(8).optional(),
});

const VEHICLE_COLS = {
  registration: 'registration',
  kind: 'kind',
  make: 'make',
  model: 'model',
  year: 'year',
  fuelType: 'fuel_type',
  tankCapacityL: 'tank_capacity_l',
  expectedLPer100km: 'expected_l_per_100km',
  maxLoadKg: 'max_load_kg',
  seats: 'seats',
  deviceId: 'device_id',
  canFuelCounter: 'can_fuel_counter',
  active: 'active',
} as const;

export function fleetRoutes(r: Router) {
  // ------------------------------------------------------------- vehicles
  r.get('/vehicles', {}, async (ctx) => {
    const rows = await query('SELECT * FROM vehicles WHERE company_id = $1 ORDER BY registration', [ctx.user.companyId]);
    return rows.map(camel);
  });

  r.get('/vehicles/:id', {}, async (ctx) => {
    const v = await queryOne('SELECT * FROM vehicles WHERE id = $1 AND company_id = $2', [ctx.params.id, ctx.user.companyId]);
    if (!v) throw notFound('Vehicle not found');
    return camel(v);
  });

  r.post('/vehicles', { roles: CAN.manageFleet }, async (ctx) => {
    const v = parse(Vehicle, ctx.body);
    const entries = Object.entries(v).filter(([, val]) => val !== undefined);
    const cols = ['company_id', ...entries.map(([k]) => VEHICLE_COLS[k as keyof typeof VEHICLE_COLS])];
    const vals = [ctx.user.companyId, ...entries.map(([, val]) => val)];
    const row = await queryOne(`INSERT INTO vehicles (${cols.join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
    ctx.status = 201;
    return camel(row!);
  });

  r.patch('/vehicles/:id', { roles: CAN.manageFleet }, async (ctx) => {
    const v = parse(VehicleUpdate, ctx.body);
    const entries = Object.entries(v).filter(([, val]) => val !== undefined);
    if (entries.length === 0) return { ok: true };
    const sets = entries.map(([k], i) => `${VEHICLE_COLS[k as keyof typeof VEHICLE_COLS]} = $${i + 3}`);
    const row = await queryOne(
      `UPDATE vehicles SET ${sets.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
      [ctx.params.id, ctx.user.companyId, ...entries.map(([, val]) => val)],
    );
    if (!row) throw notFound('Vehicle not found');
    return camel(row);
  });

  // ------------------------------------------------------------- routes
  r.get('/routes', {}, async (ctx) => {
    const rows = await query('SELECT id, code, name, distance_km, surface FROM routes WHERE company_id = $1 ORDER BY code', [ctx.user.companyId]);
    return rows.map(camel);
  });

  r.post('/routes', { roles: CAN.manageFleet }, async (ctx) => {
    const v = parse(Route, ctx.body);
    const row = await queryOne(
      `INSERT INTO routes (company_id, code, name, distance_km, surface, path) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ctx.user.companyId, v.code, v.name, v.distanceKm ?? null, v.surface, v.path ? JSON.stringify(v.path) : null],
    );
    ctx.status = 201;
    return camel(row!);
  });

  // ------------------------------------------------------------- people
  r.get('/users', { roles: [...CAN.manageFleet, 'owner'] }, async (ctx) => {
    const role = ctx.query.get('role');
    const rows = await query(
      `SELECT id, full_name, email, phone, whatsapp, role, active FROM users
        WHERE company_id = $1 AND ($2::text IS NULL OR role = $2) ORDER BY full_name`,
      [ctx.user.companyId, role],
    );
    return rows.map(camel);
  });

  r.post('/users', { roles: CAN.manageUsers }, async (ctx) => {
    const v = parse(User, ctx.body);
    const row = await queryOne(
      `INSERT INTO users (company_id, full_name, email, phone, whatsapp, role, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, full_name, email, phone, whatsapp, role, active`,
      [ctx.user.companyId, v.fullName, v.email ?? null, v.phone ?? null, v.whatsapp ?? null, v.role, v.password ? hashPassword(v.password) : null],
    );
    ctx.status = 201;
    return camel(row!);
  });
}
