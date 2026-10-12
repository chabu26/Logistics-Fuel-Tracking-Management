import { z } from 'zod';
import { depotStock, type AlertDraft } from '@fleetfuel/shared';
import { CAN } from '../auth';
import { pool, query, queryOne } from '../db';
import { badRequest, HttpError, notFound, parse, type Router } from '../http';
import { camel } from '../mappers';
import { lossRules, saveAlerts } from '../processing';

const iso = z.string().datetime({ offset: true });

const TripStart = z
  .object({
    vehicleId: z.string().uuid(),
    driverId: z.string().uuid().optional(),
    routeId: z.string().uuid().optional(),
    startedAt: iso,
    loadKg: z.number().min(0).optional(),
    passengers: z.number().int().min(0).optional(),
    loadSource: z.enum(['sensor', 'manual', 'passengers']).optional(),
    weather: z.enum(['dry', 'rain']).optional(),
  })
  .refine((t) => !(t.loadKg !== undefined && t.passengers !== undefined), { message: 'Give either loadKg or passengers, not both' });

const TripClose = z.object({ endedAt: iso });

const Refuel = z
  .object({
    vehicleId: z.string().uuid(),
    driverId: z.string().uuid().optional(),
    source: z.enum(['depot', 'fuel_card', 'cash']),
    depotTankId: z.string().uuid().optional(),
    litres: z.number().positive(),
    pricePerL: z.number().positive().optional(),
    totalCost: z.number().positive().optional(),
    odometerKm: z.number().min(0).optional(),
    stationName: z.string().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    receiptPhotoUrl: z.string().url().optional(),
    cardTxnRef: z.string().optional(),
    pumpReading: z.number().optional(),
    occurredAt: iso,
  })
  .refine((r) => r.source !== 'depot' || r.depotTankId, { message: 'A depot refuel needs depotTankId', path: ['depotTankId'] });

const Tank = z.object({
  name: z.string().min(2),
  fuelType: z.enum(['diesel', 'petrol']).default('diesel'),
  capacityL: z.number().positive(),
  openingLevelL: z.number().min(0).default(0),
  openingAt: iso.optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
});

const Delivery = z.object({ supplier: z.string().optional(), litres: z.number().positive(), pricePerL: z.number().positive().optional(), deliveredAt: iso });
const Dip = z.object({ litres: z.number().min(0), measuredAt: iso });

const TelemetryBatch = z.object({
  deviceId: z.string().min(1),
  readings: z
    .array(
      z.object({
        time: iso,
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        altitudeM: z.number().optional(),
        speedKmh: z.number().min(0).max(250),
        headingDeg: z.number().min(0).max(360).optional(),
        ignition: z.boolean(),
        fuelLevelL: z.number().min(0).optional(),
        fuelUsedTotalL: z.number().min(0).optional(),
        odometerKm: z.number().min(0).optional(),
        harshAccel: z.boolean().optional(),
        harshBrake: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(20000),
});

async function ownVehicle(companyId: string, vehicleId: string) {
  const v = await queryOne('SELECT id, tank_capacity_l FROM vehicles WHERE id = $1 AND company_id = $2', [vehicleId, companyId]);
  if (!v) throw notFound('Vehicle not found');
  return v;
}

export function operationsRoutes(r: Router) {
  // ------------------------------------------------------------- trips
  r.post('/trips', { roles: CAN.logTrips }, async (ctx) => {
    const t = parse(TripStart, ctx.body);
    await ownVehicle(ctx.user.companyId, t.vehicleId);
    const driverId = t.driverId ?? (ctx.user.role === 'driver' ? ctx.user.userId : null);
    const loadSource = t.loadSource ?? (t.passengers !== undefined ? 'passengers' : t.loadKg !== undefined ? 'manual' : null);
    const row = await queryOne(
      `INSERT INTO trips (company_id, vehicle_id, driver_id, route_id, started_at, load_kg, passengers, load_source, weather)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [ctx.user.companyId, t.vehicleId, driverId, t.routeId ?? null, t.startedAt, t.loadKg ?? null, t.passengers ?? null, loadSource, t.weather ?? null],
    );
    ctx.status = 201;
    return camel(row!);
  });

  r.post('/trips/:id/close', { roles: CAN.logTrips }, async (ctx) => {
    const { endedAt } = parse(TripClose, ctx.body);
    const row = await queryOne(
      `UPDATE trips SET ended_at = $3, status = 'closed' WHERE id = $1 AND company_id = $2 AND status = 'open' AND started_at < $3 RETURNING *`,
      [ctx.params.id, ctx.user.companyId, endedAt],
    );
    if (!row) throw badRequest('Trip not found, already closed, or the end time is before the start');
    return camel(row);
  });

  r.get('/trips', {}, async (ctx) => {
    const rows = await query(
      `SELECT t.*, v.registration, u.full_name AS driver_name, r.code AS route_code,
              (SELECT round(sum(distance_km)::numeric, 1) FROM trip_segments s WHERE s.trip_id = t.id) AS distance_km,
              (SELECT round(sum(fuel_used_l)::numeric, 1) FROM trip_segments s WHERE s.trip_id = t.id) AS fuel_used_l
         FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
         LEFT JOIN users u ON u.id = t.driver_id LEFT JOIN routes r ON r.id = t.route_id
        WHERE t.company_id = $1 AND ($2::uuid IS NULL OR t.vehicle_id = $2)
        ORDER BY t.started_at DESC LIMIT $3`,
      [ctx.user.companyId, ctx.query.get('vehicleId'), Math.min(Number(ctx.query.get('limit') ?? 100), 500)],
    );
    return rows.map(camel);
  });

  // ------------------------------------------------------------- refuels
  r.post('/refuels', { roles: CAN.logRefuels }, async (ctx) => {
    const f = parse(Refuel, ctx.body);
    await ownVehicle(ctx.user.companyId, f.vehicleId);
    if (ctx.user.role === 'depot_attendant' && f.source !== 'depot') throw new HttpError(403, 'Depot attendants can only log depot refuels');
    if (ctx.user.role === 'driver' && f.source === 'depot') throw new HttpError(403, 'Depot refuels are logged by the depot attendant');
    const driverId = f.driverId ?? (ctx.user.role === 'driver' ? ctx.user.userId : null);
    const total = f.totalCost ?? (f.pricePerL ? Math.round(f.pricePerL * f.litres * 100) / 100 : null);
    const row = await queryOne(
      `INSERT INTO refuels (company_id, vehicle_id, driver_id, source, depot_tank_id, litres, price_per_l, total_cost, odometer_km,
                            station_name, lat, lon, receipt_photo_url, card_txn_ref, pump_reading, occurred_at, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [ctx.user.companyId, f.vehicleId, driverId, f.source, f.depotTankId ?? null, f.litres, f.pricePerL ?? null, total, f.odometerKm ?? null,
        f.stationName ?? null, f.lat ?? null, f.lon ?? null, f.receiptPhotoUrl ?? null, f.cardTxnRef ?? null, f.pumpReading ?? null, f.occurredAt, ctx.user.userId],
    );
    ctx.status = 201;
    return camel(row!);
  });

  r.get('/refuels', {}, async (ctx) => {
    const rows = await query(
      `SELECT f.*, v.registration, u.full_name AS driver_name FROM refuels f
         JOIN vehicles v ON v.id = f.vehicle_id LEFT JOIN users u ON u.id = f.driver_id
        WHERE f.company_id = $1 AND ($2::uuid IS NULL OR f.vehicle_id = $2)
        ORDER BY f.occurred_at DESC LIMIT $3`,
      [ctx.user.companyId, ctx.query.get('vehicleId'), Math.min(Number(ctx.query.get('limit') ?? 100), 500)],
    );
    return rows.map(camel);
  });

  // ------------------------------------------------------------- depot tanks
  r.get('/depot-tanks', {}, async (ctx) => (await query('SELECT * FROM depot_tanks WHERE company_id = $1 ORDER BY name', [ctx.user.companyId])).map(camel));

  r.post('/depot-tanks', { roles: CAN.manageFleet }, async (ctx) => {
    const t = parse(Tank, ctx.body);
    const row = await queryOne(
      `INSERT INTO depot_tanks (company_id, name, fuel_type, capacity_l, opening_level_l, opening_at, lat, lon)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()),$7,$8) RETURNING *`,
      [ctx.user.companyId, t.name, t.fuelType, t.capacityL, t.openingLevelL, t.openingAt ?? null, t.lat ?? null, t.lon ?? null],
    );
    ctx.status = 201;
    return camel(row!);
  });

  const tankOf = async (companyId: string, id: string) => {
    const t = await queryOne('SELECT * FROM depot_tanks WHERE id = $1 AND company_id = $2', [id, companyId]);
    if (!t) throw notFound('Depot tank not found');
    return t;
  };

  r.post('/depot-tanks/:id/deliveries', { roles: CAN.manageDepot }, async (ctx) => {
    const d = parse(Delivery, ctx.body);
    await tankOf(ctx.user.companyId, ctx.params.id);
    const row = await queryOne(
      `INSERT INTO depot_deliveries (company_id, tank_id, supplier, litres, price_per_l, delivered_at, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ctx.user.companyId, ctx.params.id, d.supplier ?? null, d.litres, d.pricePerL ?? null, d.deliveredAt, ctx.user.userId],
    );
    ctx.status = 201;
    return camel(row!);
  });

  /**
   * Stock expected at `at`, counted from the last dip before it (or the opening stock). Counting from the
   * last dip means a loss is flagged once, at the dip that first shows it, not again at every dip after.
   */
  const stockAt = async (tank: Record<string, any>, at: string, dipL: number | null) => {
    const prev = await queryOne<{ litres: number; measured_at: Date }>(
      'SELECT litres, measured_at FROM depot_dips WHERE tank_id = $1 AND measured_at < $2 ORDER BY measured_at DESC LIMIT 1',
      [tank.id, at],
    );
    const since = prev?.measured_at ?? tank.opening_at;
    const sums = await queryOne<{ delivered: number; dispensed: number }>(
      `SELECT
         (SELECT COALESCE(sum(litres), 0) FROM depot_deliveries WHERE tank_id = $1 AND delivered_at > $2 AND delivered_at <= $3) AS delivered,
         (SELECT COALESCE(sum(litres), 0) FROM refuels WHERE depot_tank_id = $1 AND occurred_at > $2 AND occurred_at <= $3) AS dispensed`,
      [tank.id, since, at],
    );
    return {
      countedFrom: prev ? 'last dip' : 'opening stock',
      since: since instanceof Date ? since.toISOString() : since,
      ...depotStock({ openingL: prev?.litres ?? tank.opening_level_l, deliveredL: sums!.delivered, dispensedL: sums!.dispensed, dipL }),
    };
  };

  // A dip is the physical check: compare it with deliveries minus dispensing and flag any gap
  r.post('/depot-tanks/:id/dips', { roles: CAN.manageDepot }, async (ctx) => {
    const d = parse(Dip, ctx.body);
    const tank = await tankOf(ctx.user.companyId, ctx.params.id);
    await query(`INSERT INTO depot_dips (company_id, tank_id, litres, measured_at, measured_by) VALUES ($1,$2,$3,$4,$5)`, [
      ctx.user.companyId, tank.id, d.litres, d.measuredAt, ctx.user.userId,
    ]);
    const stock = await stockAt(tank, d.measuredAt, d.litres);
    const rules = await lossRules(ctx.user.companyId);
    const allowed = Math.max(rules.minLitres, tank.capacity_l * 0.005);
    if (stock.gapL !== null && stock.gapL > allowed) {
      const alert: AlertDraft = {
        type: 'depot_stock_gap',
        severity: stock.gapL >= rules.criticalLitres ? 'critical' : 'warning',
        litres: stock.gapL,
        occurredAt: d.measuredAt,
        lat: tank.lat,
        lon: tank.lon,
        dedupeKey: `depot:${tank.id}:${d.measuredAt}`,
        details: { tankId: tank.id, tankName: tank.name, ...stock },
      };
      await saveAlerts(ctx.user.companyId, null, [alert], pool);
    }
    ctx.status = 201;
    return stock;
  });

  r.get('/depot-tanks/:id/stock', {}, async (ctx) => {
    const tank = await tankOf(ctx.user.companyId, ctx.params.id);
    const at = ctx.query.get('at') ?? new Date().toISOString();
    const lastDip = await queryOne('SELECT litres, measured_at FROM depot_dips WHERE tank_id = $1 AND measured_at <= $2 ORDER BY measured_at DESC LIMIT 1', [tank.id, at]);
    return { tank: camel(tank), at, ...(await stockAt(tank, at, null)), lastDip: lastDip ? camel(lastDip) : null };
  });

  // ------------------------------------------------------------- tracker data intake
  r.post('/ingest/telemetry', { auth: 'ingest' }, async (ctx) => {
    const { deviceId, readings } = parse(TelemetryBatch, ctx.body);
    const v = await queryOne('SELECT id, company_id FROM vehicles WHERE device_id = $1', [deviceId]);
    if (!v) throw notFound(`No vehicle has device ${deviceId}`);
    const col = <K extends keyof (typeof readings)[number]>(k: K) => readings.map((x) => x[k] ?? null);
    const res = await pool.query(
      `INSERT INTO telemetry (time, company_id, vehicle_id, lat, lon, altitude_m, speed_kmh, heading_deg, ignition,
                              fuel_level_l, fuel_used_total_l, odometer_km, harsh_accel, harsh_brake)
       SELECT t.time, $1, $2, t.lat, t.lon, t.alt, t.speed, t.heading, t.ign, t.level, t.used, t.odo,
              COALESCE(t.ha, false), COALESCE(t.hb, false)
         FROM unnest($3::timestamptz[], $4::float8[], $5::float8[], $6::real[], $7::real[], $8::real[], $9::bool[],
                     $10::real[], $11::float8[], $12::float8[], $13::bool[], $14::bool[])
              AS t(time, lat, lon, alt, speed, heading, ign, level, used, odo, ha, hb)
       ON CONFLICT (vehicle_id, time) DO NOTHING`,
      [v.company_id, v.id, col('time'), col('lat'), col('lon'), col('altitudeM'), col('speedKmh'), col('headingDeg'), col('ignition'),
        col('fuelLevelL'), col('fuelUsedTotalL'), col('odometerKm'), col('harshAccel'), col('harshBrake')],
    );
    ctx.status = 202;
    return { received: readings.length, stored: res.rowCount };
  });
}
