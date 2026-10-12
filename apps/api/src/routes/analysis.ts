import { z } from 'zod';
import {
  CONDITION_DIMENSIONS,
  consumptionInsight,
  describeConditions,
  fuelBalance,
  summarizeConsumption,
  type ConditionDimension,
} from '@fleetfuel/shared';
import { CAN } from '../auth';
import { query, queryOne } from '../db';
import { badRequest, notFound, parse, type Router } from '../http';
import { camel, toSegment } from '../mappers';
import { processCompany } from '../processing';

/** Segment column for each condition a manager can filter or group by. */
const DIM_COLUMN: Record<ConditionDimension, string> = {
  speedBand: 'speed_band',
  gradient: 'gradient',
  traffic: 'traffic',
  roadShape: 'road_shape',
  timeOfDay: 'time_of_day',
  loadClass: 'load_class',
  surface: 'surface',
  weather: 'weather',
  routeId: 'route_id',
  driverId: 'driver_id',
};

function period(q: URLSearchParams) {
  const to = q.get('to') ?? new Date().toISOString();
  const from = q.get('from') ?? new Date(Date.parse(to) - 30 * 86400_000).toISOString();
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw badRequest('from and to must be ISO dates, e.g. 2026-10-01T00:00:00Z');
  return { from, to };
}

function dimensions(q: URLSearchParams, fallback: ConditionDimension[]): ConditionDimension[] {
  const raw = q.get('dims');
  if (!raw) return fallback;
  const dims = raw.split(',').map((d) => d.trim()).filter(Boolean);
  const bad = dims.filter((d) => !(CONDITION_DIMENSIONS as readonly string[]).includes(d));
  if (bad.length) throw badRequest(`Unknown condition: ${bad.join(', ')}. Use any of ${CONDITION_DIMENSIONS.join(', ')}`);
  return dims as ConditionDimension[];
}

/** Route codes and driver names, to describe conditions in words. */
async function names(companyId: string) {
  const rows = await query<{ id: string; name: string }>(
    `SELECT id, code AS name FROM routes WHERE company_id = $1 UNION ALL SELECT id, full_name FROM users WHERE company_id = $1`,
    [companyId],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

const AlertUpdate = z.object({
  status: z.enum(['open', 'investigating', 'explained', 'confirmed_loss']),
  note: z.string().max(2000).optional(),
});

const ProcessRequest = z.object({
  vehicleId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export function analysisRoutes(r: Router) {
  /**
   * Where does this vehicle use the most and least fuel?
   * ?dims=gradient,speedBand,loadClass  picks the conditions to combine (default gradient + speed)
   * ?gradient=uphill&routeId=...         narrows to segments that match
   */
  r.get('/vehicles/:id/consumption', { roles: CAN.viewAnalysis }, async (ctx) => {
    const vehicle = await queryOne('SELECT id, registration, kind FROM vehicles WHERE id = $1 AND company_id = $2', [ctx.params.id, ctx.user.companyId]);
    if (!vehicle) throw notFound('Vehicle not found');
    const { from, to } = period(ctx.query);
    const dims = dimensions(ctx.query, ['gradient', 'speedBand']);
    const minDistanceKm = Number(ctx.query.get('minKm') ?? 10);

    const where = ['vehicle_id = $1', 'started_at BETWEEN $2 AND $3'];
    const params: unknown[] = [vehicle.id, from, to];
    const filters: Record<string, string> = {};
    for (const d of CONDITION_DIMENSIONS) {
      const v = ctx.query.get(d);
      if (!v) continue;
      params.push(v);
      where.push(`${DIM_COLUMN[d]}::text = $${params.length}`);
      filters[d] = v;
    }
    const segments = (await query(`SELECT * FROM trip_segments WHERE ${where.join(' AND ')}`, params)).map(toSegment);
    const insight = consumptionInsight(segments, dims, { minDistanceKm });
    const nameOf = await names(ctx.user.companyId);

    // one breakdown per condition, so the app can show each on its own
    const breakdowns = Object.fromEntries(
      CONDITION_DIMENSIONS.map((d) => [d, summarizeConsumption(segments, [d], { minDistanceKm }).sort((a, b) => (b.lPer100km ?? 0) - (a.lPer100km ?? 0))]),
    );

    // the same-kind fleet average over the same period, for comparison
    const fleet = await queryOne<{ km: number; l: number }>(
      `SELECT sum(s.distance_km) AS km, sum(s.fuel_used_l) AS l FROM trip_segments s JOIN vehicles v ON v.id = s.vehicle_id
        WHERE s.company_id = $1 AND v.kind = $2 AND s.kind = 'moving' AND s.started_at BETWEEN $3 AND $4`,
      [ctx.user.companyId, vehicle.kind, from, to],
    );

    const describe = (g: typeof insight.worst) => (g ? `${describeConditions(g.conditions, nameOf)}: ${g.lPer100km} L/100km` : null);
    return {
      vehicle: camel(vehicle),
      period: { from, to },
      dimensions: dims,
      filters,
      headline: {
        most: describe(insight.worst),
        least: describe(insight.best),
        average: insight.overall.lPer100km !== null ? `${insight.overall.lPer100km} L/100km over ${insight.overall.distanceKm} km` : null,
      },
      fleetAverageLPer100km: fleet?.km ? Math.round((fleet.l / fleet.km) * 1000) / 10 : null,
      ...insight,
      groups: insight.groups.map((g) => ({ ...g, label: describeConditions(g.conditions, nameOf) })),
      breakdowns,
      names: nameOf,
    };
  });

  /** Fuel in, used and left for one vehicle, and what can't be explained. */
  r.get('/vehicles/:id/fuel-balance', { roles: CAN.viewAnalysis }, async (ctx) => {
    const vehicle = await queryOne('SELECT id, registration, tank_capacity_l FROM vehicles WHERE id = $1 AND company_id = $2', [ctx.params.id, ctx.user.companyId]);
    if (!vehicle) throw notFound('Vehicle not found');
    const { from, to } = period(ctx.query);
    // the median of a few readings at each end keeps sensor noise out of the balance
    const level = async (order: 'ASC' | 'DESC') =>
      (
        await queryOne<{ level: number | null }>(
          `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fuel_level_l) AS level FROM (
             SELECT fuel_level_l FROM telemetry WHERE vehicle_id = $1 AND time BETWEEN $2 AND $3 ORDER BY time ${order} LIMIT 7) x`,
          [vehicle.id, from, to],
        )
      )?.level ?? null;
    const [startLevel, endLevel] = [await level('ASC'), await level('DESC')];
    if (startLevel === null || endLevel === null) return { vehicle: camel(vehicle), period: { from, to }, balance: null, note: 'No tracker readings in this period' };

    const sums = await queryOne<{ recorded: number; sensor: number; used: number; cost: number }>(
      `SELECT
         (SELECT COALESCE(sum(litres), 0) FROM refuels WHERE vehicle_id = $1 AND occurred_at BETWEEN $2 AND $3) AS recorded,
         (SELECT COALESCE(sum(total_cost), 0) FROM refuels WHERE vehicle_id = $1 AND occurred_at BETWEEN $2 AND $3) AS cost,
         (SELECT COALESCE(sum(litres), 0) FROM fuel_events WHERE vehicle_id = $1 AND type = 'rise' AND started_at BETWEEN $2 AND $3) AS sensor,
         (SELECT COALESCE(sum(fuel_used_l), 0) FROM trip_segments WHERE vehicle_id = $1 AND started_at BETWEEN $2 AND $3) AS used`,
      [vehicle.id, from, to],
    );
    const balance = fuelBalance({ startLevelL: startLevel, endLevelL: endLevel, refueledRecordedL: sums!.recorded, refueledSensorL: sums!.sensor, usedL: sums!.used });
    const bySource = await query(
      `SELECT source, count(*) AS refuels, sum(litres) AS litres, sum(sensor_litres) AS sensor_litres, sum(total_cost) AS cost
         FROM refuels WHERE vehicle_id = $1 AND occurred_at BETWEEN $2 AND $3 GROUP BY source ORDER BY source`,
      [vehicle.id, from, to],
    );
    return { vehicle: camel(vehicle), period: { from, to }, balance, refuelCost: sums!.cost, bySource: bySource.map(camel) };
  });

  /** One row per vehicle: distance, fuel, consumption against its expected rate, open alerts. */
  r.get('/fleet/summary', { roles: CAN.viewAnalysis }, async (ctx) => {
    const { from, to } = period(ctx.query);
    const rows = await query(
      `SELECT v.id, v.registration, v.kind, v.make, v.model, v.expected_l_per_100km,
              COALESCE(round(sum(s.distance_km) FILTER (WHERE s.kind = 'moving')::numeric, 1), 0) AS distance_km,
              COALESCE(round(sum(s.fuel_used_l) FILTER (WHERE s.kind = 'moving')::numeric, 1), 0) AS fuel_moving_l,
              COALESCE(round(sum(s.fuel_used_l) FILTER (WHERE s.kind = 'idle')::numeric, 1), 0) AS fuel_idle_l,
              COALESCE(round((sum(s.duration_s) FILTER (WHERE s.kind = 'idle') / 3600.0)::numeric, 1), 0) AS idle_hours,
              (SELECT count(*) FROM alerts a WHERE a.vehicle_id = v.id AND a.status IN ('open', 'investigating')) AS open_alerts
         FROM vehicles v LEFT JOIN trip_segments s ON s.vehicle_id = v.id AND s.started_at BETWEEN $2 AND $3
        WHERE v.company_id = $1 AND v.active
        GROUP BY v.id ORDER BY v.registration`,
      [ctx.user.companyId, from, to],
    );
    return {
      period: { from, to },
      vehicles: rows.map((r) => ({
        ...camel(r),
        lPer100km: r.distance_km > 0 ? Math.round((r.fuel_moving_l / r.distance_km) * 1000) / 10 : null,
      })),
    };
  });

  // ------------------------------------------------------------- alerts
  r.get('/alerts', { roles: CAN.viewAnalysis }, async (ctx) => {
    const statuses = (ctx.query.get('status') ?? 'open,investigating').split(',');
    const rows = await query(
      `SELECT a.*, v.registration, u.full_name AS driver_name FROM alerts a
         LEFT JOIN vehicles v ON v.id = a.vehicle_id LEFT JOIN users u ON u.id = a.driver_id
        WHERE a.company_id = $1 AND a.status = ANY($2) AND ($3::uuid IS NULL OR a.vehicle_id = $3) AND ($4::text IS NULL OR a.type = $4)
        ORDER BY a.occurred_at DESC LIMIT $5`,
      [ctx.user.companyId, statuses, ctx.query.get('vehicleId'), ctx.query.get('type'), Math.min(Number(ctx.query.get('limit') ?? 200), 1000)],
    );
    return rows.map((r) => {
      const { dedupe_key: _key, ...rest } = r;
      return camel(rest);
    });
  });

  r.patch('/alerts/:id', { roles: CAN.handleAlerts }, async (ctx) => {
    const { status, note } = parse(AlertUpdate, ctx.body);
    const done = status === 'explained' || status === 'confirmed_loss';
    const row = await queryOne(
      `UPDATE alerts SET status = $3, resolution_note = COALESCE($4, resolution_note), resolved_by = CASE WHEN $5 THEN $6::uuid ELSE NULL END
        WHERE id = $1 AND company_id = $2 RETURNING *`,
      [ctx.params.id, ctx.user.companyId, status, note ?? null, done, ctx.user.userId],
    );
    if (!row) throw notFound('Alert not found');
    return camel(row);
  });

  // ------------------------------------------------------------- processing
  /** Run the analysis now. In production a scheduled job calls this every few minutes. */
  r.post('/processing/run', { roles: CAN.runProcessing }, async (ctx) => {
    const p = parse(ProcessRequest, ctx.body);
    const report = await processCompany(ctx.user.companyId, {
      vehicleId: p.vehicleId,
      from: p.from ? new Date(p.from) : undefined,
      to: p.to ? new Date(p.to) : undefined,
    });
    return { vehicles: report };
  });
}
