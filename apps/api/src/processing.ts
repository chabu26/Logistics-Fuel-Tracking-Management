import {
  abnormalConsumptionAlert,
  buildBaseline,
  busLoadKg,
  DEFAULT_LOSS_RULES,
  detectFuelEvents,
  findDataGaps,
  findIdlePeriods,
  fuelAlerts,
  idlingAlerts,
  segmentTrip,
  type AlertDraft,
  type LossRules,
  type RefuelRecord,
} from '@fleetfuel/shared';
import { pool, query, queryOne, withTransaction, type Queryable } from './db';
import { SEGMENT_FIELDS, TELEMETRY_COLUMNS, toReading, toSegment } from './mappers';

interface VehicleRow {
  id: string;
  company_id: string;
  tank_capacity_l: number;
  max_load_kg: number | null;
  seats: number | null;
  kind: string;
}

/** A company's loss rules: the defaults, overridden by anything set in companies.settings.lossRules. */
export async function lossRules(companyId: string): Promise<LossRules> {
  const c = await queryOne<{ settings: { lossRules?: Partial<LossRules> } }>('SELECT settings FROM companies WHERE id = $1', [companyId]);
  return { ...DEFAULT_LOSS_RULES, ...(c?.settings?.lossRules ?? {}) };
}

/** Insert alerts, skipping any the analysis already raised before. Returns how many are new. */
export async function saveAlerts(companyId: string, vehicleId: string | null, drafts: AlertDraft[], db: Queryable): Promise<number> {
  let added = 0;
  for (const a of drafts) {
    const driver = vehicleId ? await driverAt(vehicleId, a.occurredAt, db) : null;
    const res = await db.query(
      `INSERT INTO alerts (company_id, vehicle_id, driver_id, type, severity, litres, occurred_at, lat, lon, details, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (company_id, dedupe_key) DO NOTHING`,
      [companyId, vehicleId, driver, a.type, a.severity, a.litres, a.occurredAt, a.lat ?? null, a.lon ?? null, JSON.stringify(a.details), a.dedupeKey],
    );
    added += res.rowCount ?? 0;
  }
  return added;
}

/** The driver of the trip running at that moment, or the last trip before it (for overnight events). */
async function driverAt(vehicleId: string, at: string, db: Queryable): Promise<string | null> {
  const row = await queryOne<{ driver_id: string | null }>(
    `SELECT driver_id FROM trips WHERE vehicle_id = $1 AND started_at <= $2 ORDER BY started_at DESC LIMIT 1`,
    [vehicleId, at],
    db,
  );
  return row?.driver_id ?? null;
}

async function loadReadings(vehicleId: string, from: Date | string, to: Date | string) {
  const rows = await query(`SELECT ${TELEMETRY_COLUMNS} FROM telemetry WHERE vehicle_id = $1 AND time BETWEEN $2 AND $3 ORDER BY time`, [vehicleId, from, to]);
  return rows.map(toReading);
}

/** Cut one closed trip into segments and store them. */
export async function segmentAndStoreTrip(tripId: string): Promise<{ segments: number; companyId: string; vehicleId: string }> {
  const trip = await queryOne(
    `SELECT t.*, r.surface FROM trips t LEFT JOIN routes r ON r.id = t.route_id WHERE t.id = $1`,
    [tripId],
  );
  if (!trip) throw new Error(`Trip ${tripId} not found`);
  if (!trip.ended_at) throw new Error(`Trip ${tripId} is still open`);
  const vehicle = (await queryOne<VehicleRow>('SELECT * FROM vehicles WHERE id = $1', [trip.vehicle_id]))!;

  const readings = await loadReadings(trip.vehicle_id, trip.started_at, trip.ended_at);
  const loadKg = trip.load_kg ?? (trip.passengers != null ? busLoadKg(trip.passengers) : undefined);
  const maxLoadKg = vehicle.max_load_kg ?? (vehicle.seats ? busLoadKg(vehicle.seats) : undefined);
  const segments = segmentTrip(readings, {
    tripId,
    vehicleId: trip.vehicle_id,
    driverId: trip.driver_id ?? undefined,
    routeId: trip.route_id ?? undefined,
    loadKg: loadKg ?? undefined,
    passengers: trip.passengers ?? undefined,
    maxLoadKg: maxLoadKg ?? undefined,
    surface: trip.surface ?? undefined,
    weather: trip.weather ?? undefined,
  });

  await withTransaction(async (db) => {
    await db.query('DELETE FROM trip_segments WHERE trip_id = $1', [tripId]);
    await insertSegments(trip.company_id, segments, db);
    await db.query(`UPDATE trips SET status = 'processed', processed_at = now() WHERE id = $1`, [tripId]);
  });
  return { segments: segments.length, companyId: trip.company_id, vehicleId: trip.vehicle_id };
}

/**
 * Compare trips with what this vehicle normally uses in the same conditions, over its other trips in the
 * 90 days around them. Run after segmenting a batch, so every trip is judged against the full history
 * rather than only the trips that happened to be processed before it.
 */
export async function judgeTrips(vehicleId: string, tripIds: string[]): Promise<number> {
  if (tripIds.length === 0) return 0;
  const vehicle = (await queryOne<VehicleRow>('SELECT * FROM vehicles WHERE id = $1', [vehicleId]))!;
  const rules = await lossRules(vehicle.company_id);
  const range = await queryOne<{ first: Date; last: Date }>('SELECT min(started_at) AS first, max(started_at) AS last FROM trips WHERE id = ANY($1)', [tripIds]);
  const all = (
    await query(
      `SELECT * FROM trip_segments WHERE vehicle_id = $1 AND kind = 'moving'
         AND started_at BETWEEN $2::timestamptz - interval '90 days' AND $3::timestamptz + interval '1 day'`,
      [vehicleId, range!.first, range!.last],
    )
  ).map(toSegment);
  const drafts: AlertDraft[] = [];
  for (const id of tripIds) {
    const mine = all.filter((s) => s.tripId === id);
    const baseline = buildBaseline(all.filter((s) => s.tripId !== id));
    const alert = abnormalConsumptionAlert(mine, baseline, rules);
    if (alert) drafts.push(alert);
  }
  return saveAlerts(vehicle.company_id, vehicleId, drafts, pool);
}

async function insertSegments(companyId: string, segments: ReturnType<typeof segmentTrip>, db: Queryable) {
  const cols = ['company_id', ...SEGMENT_FIELDS.map(([c]) => c)];
  for (let i = 0; i < segments.length; i += 500) {
    const chunk = segments.slice(i, i + 500);
    const values: unknown[] = [];
    const rows = chunk.map((s) => {
      const vals = [companyId, ...SEGMENT_FIELDS.map(([, k]) => s[k] ?? null)];
      const ph = vals.map((v) => {
        values.push(v);
        return `$${values.length}`;
      });
      return `(${ph.join(',')})`;
    });
    await db.query(`INSERT INTO trip_segments (${cols.join(',')}) VALUES ${rows.join(',')}`, values);
  }
}

/**
 * Scan a vehicle's readings over a period: find refuels and drops, match refuels to records,
 * look for data gaps and long idling, and raise alerts.
 */
export async function processFuel(vehicleId: string, from: Date, to: Date) {
  const vehicle = (await queryOne<VehicleRow>('SELECT * FROM vehicles WHERE id = $1', [vehicleId]))!;
  const rules = await lossRules(vehicle.company_id);
  const readings = await loadReadings(vehicleId, from, to);
  if (readings.length < 3) return { events: 0, matched: 0, alerts: 0 };

  const events = detectFuelEvents(readings);
  const gaps = findDataGaps(readings);
  // records slightly outside the window can still belong to a rise inside it
  const refuelRows = await query(
    `SELECT id, source, litres, occurred_at, lat, lon FROM refuels
      WHERE vehicle_id = $1 AND occurred_at BETWEEN $2::timestamptz - interval '2 hours' AND $3::timestamptz + interval '2 hours'`,
    [vehicleId, from, to],
  );
  const refuels: RefuelRecord[] = refuelRows.map((r) => ({
    id: r.id,
    source: r.source,
    litres: r.litres,
    occurredAt: (r.occurred_at as Date).toISOString(),
    lat: r.lat,
    lon: r.lon,
  }));
  const { alerts, matching } = fuelAlerts({ vehicleId, tankCapacityL: vehicle.tank_capacity_l, refuels, events, gaps, rules });
  // idling is checked over all readings, not only trips: drivers often idle at a terminus between trips
  alerts.push(...idlingAlerts(vehicleId, findIdlePeriods(readings), rules));
  const rises = events.filter((e) => e.type === 'rise');

  return withTransaction(async (db) => {
    const eventIds = new Map<string, number>();
    for (const e of events) {
      const row = await db.query<{ id: number }>(
        `INSERT INTO fuel_events (company_id, vehicle_id, type, started_at, ended_at, litres, lat, lon)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (vehicle_id, type, started_at) DO UPDATE SET ended_at = EXCLUDED.ended_at, litres = EXCLUDED.litres
         RETURNING id`,
        [vehicle.company_id, vehicleId, e.type, e.startedAt, e.endedAt, e.litres, e.lat, e.lon],
      );
      eventIds.set(`${e.type}:${e.startedAt}`, row.rows[0].id);
    }
    for (const m of matching.matches) {
      const rise = rises[m.riseIndex];
      await db.query('UPDATE refuels SET sensor_litres = $2, matched_at = now() WHERE id = $1', [m.refuelId, m.sensorL]);
      await db.query('UPDATE fuel_events SET refuel_id = $2 WHERE id = $1', [eventIds.get(`rise:${rise.startedAt}`), m.refuelId]);
    }
    for (const r of matching.unmatchedRefuels) {
      await db.query('UPDATE refuels SET sensor_litres = 0, matched_at = now() WHERE id = $1', [r.id]);
    }
    const added = await saveAlerts(vehicle.company_id, vehicleId, alerts, db);
    return { events: events.length, matched: matching.matches.length, alerts: added };
  });
}

/**
 * Process everything waiting for a company: closed trips, then the fuel scan for each vehicle
 * over the period those trips (and the nights between them) cover.
 */
export async function processCompany(companyId: string, opts: { vehicleId?: string; from?: Date; to?: Date } = {}) {
  const vehicles = await query<{ id: string; registration: string }>(
    `SELECT id, registration FROM vehicles WHERE company_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY registration`,
    [companyId, opts.vehicleId ?? null],
  );
  const report = [];
  for (const v of vehicles) {
    const trips = await query<{ id: string }>(
      `SELECT id FROM trips WHERE vehicle_id = $1 AND status = 'closed' ORDER BY started_at`,
      [v.id],
    );
    let segments = 0;
    for (const t of trips) segments += (await segmentAndStoreTrip(t.id)).segments;
    const alerts = await judgeTrips(v.id, trips.map((t) => t.id));
    const range = await queryOne<{ first: Date | null; last: Date | null }>(
      'SELECT min(time) AS first, max(time) AS last FROM telemetry WHERE vehicle_id = $1',
      [v.id],
    );
    const from = opts.from ?? range?.first;
    const to = opts.to ?? range?.last;
    const fuel = from && to ? await processFuel(v.id, from, to) : { events: 0, matched: 0, alerts: 0 };
    report.push({ vehicleId: v.id, registration: v.registration, tripsProcessed: trips.length, segments, fuelEvents: fuel.events, refuelsMatched: fuel.matched, newAlerts: alerts + fuel.alerts });
  }
  return report;
}
