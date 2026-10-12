/**
 * Create the demo company: people, vehicles with trackers, Zambian routes and a depot tank.
 * Safe to run twice: it stops if the demo company already exists.
 */
import { haversineKm } from '@fleetfuel/shared';
import { DEMO_DEPOT, DEMO_PASSWORD, DEMO_ROUTES, DEMO_USERS, DEMO_VEHICLES } from '@fleetfuel/shared/demo';
import { hashPassword } from './auth';
import { pool, withTransaction } from './db';

const COMPANY = 'Demo Logistics Ltd';

async function main() {
  const existing = await pool.query('SELECT id FROM companies WHERE name = $1', [COMPANY]);
  if (existing.rowCount) {
    console.log(`"${COMPANY}" already exists (${existing.rows[0].id}). Run "npm run db:reset" first for a clean start.`);
    return;
  }
  const openingAt = process.env.SEED_OPENING_AT ?? new Date(Date.now() - 30 * 86400_000).toISOString();

  await withTransaction(async (db) => {
    const company = (
      await db.query(
        `INSERT INTO companies (name, country, currency, utc_offset_hours, settings) VALUES ($1, 'ZM', 'ZMW', 2, $2) RETURNING id`,
        [COMPANY, JSON.stringify({ lossRules: {} })],
      )
    ).rows[0].id as string;

    const hash = hashPassword(DEMO_PASSWORD);
    const userIds = new Map<string, string>();
    for (const u of DEMO_USERS) {
      const row = await db.query(
        `INSERT INTO users (company_id, full_name, email, phone, whatsapp, role, password_hash) VALUES ($1,$2,$3,$4,$4,$5,$6) RETURNING id`,
        [company, u.fullName, u.email, u.phone, u.role, hash],
      );
      userIds.set(u.email, row.rows[0].id);
    }

    for (const r of DEMO_ROUTES) {
      let km = 0;
      for (let i = 1; i < r.points.length; i++) km += haversineKm(r.points[i - 1].lat, r.points[i - 1].lon, r.points[i].lat, r.points[i].lon);
      await db.query(
        `INSERT INTO routes (company_id, code, name, distance_km, surface, path) VALUES ($1,$2,$3,$4,$5,$6)`,
        [company, r.code, r.name, Math.round(km * 1.12), r.surface, JSON.stringify(r.points.map((p) => [p.lon, p.lat]))],
      );
    }

    for (const v of DEMO_VEHICLES) {
      await db.query(
        `INSERT INTO vehicles (company_id, registration, kind, make, model, year, tank_capacity_l, expected_l_per_100km,
                               max_load_kg, seats, device_id, can_fuel_counter)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [company, v.registration, v.kind, v.make, v.model, v.year, v.tankCapacityL, v.expectedLPer100km, v.maxLoadKg ?? null, v.seats ?? null, v.deviceId, v.canFuelCounter],
      );
    }

    await db.query(
      `INSERT INTO depot_tanks (company_id, name, capacity_l, opening_level_l, opening_at, lat, lon) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [company, DEMO_DEPOT.name, DEMO_DEPOT.capacityL, DEMO_DEPOT.openingLevelL, openingAt, DEMO_DEPOT.lat, DEMO_DEPOT.lon],
    );
    console.log(`Created "${COMPANY}" with ${DEMO_USERS.length} people, ${DEMO_VEHICLES.length} vehicles and ${DEMO_ROUTES.length} routes.`);
    console.log(`Sign in as admin@demo.zm / ${DEMO_PASSWORD}`);
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
