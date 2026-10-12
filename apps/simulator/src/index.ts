/**
 * Tracker simulator.
 *
 *   npm run simulate -- --days 14                     write JSON files to sim-output/
 *   npm run simulate -- --days 14 --api http://localhost:4000 --process
 *                                                     send everything through the API, run the analysis,
 *                                                     and check every staged incident raised its alert
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEMO_PASSWORD, DEMO_VEHICLES } from '@fleetfuel/shared/demo';
import { simulateFleet, type Incident, type SimOutput } from './simulate';

const { values: args } = parseArgs({
  options: {
    days: { type: 'string', default: '14' },
    start: { type: 'string' },
    seed: { type: 'string', default: '42' },
    out: { type: 'string', default: 'sim-output' },
    api: { type: 'string' },
    email: { type: 'string', default: 'admin@demo.zm' },
    password: { type: 'string', default: DEMO_PASSWORD },
    'ingest-key': { type: 'string', default: process.env.INGEST_KEY ?? 'dev-ingest-key' },
    process: { type: 'boolean', default: false },
    'no-incidents': { type: 'boolean', default: false },
  },
});

const days = Number(args.days);
// default: finish yesterday, so the data looks recent
const start = args.start ?? new Date(Date.now() - (days + 1) * 86400_000).toISOString().slice(0, 10);

async function main() {
  console.log(`Simulating ${DEMO_VEHICLES.length} vehicles for ${days} days from ${start} (seed ${args.seed})...`);
  const t0 = Date.now();
  const sim = simulateFleet({ startDate: start, days, seed: Number(args.seed), vehicles: DEMO_VEHICLES, incidents: !args['no-incidents'] });
  const readings = [...sim.telemetry.values()].reduce((a, r) => a + r.length, 0);
  console.log(
    `  ${sim.trips.length} trips, ${sim.refuels.length} refuels, ${sim.deliveries.length} depot deliveries, ${sim.dips.length} dips, ` +
      `${readings.toLocaleString()} tracker readings, ${sim.incidents.length} staged incidents (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
  );

  if (!args.api) {
    await writeFiles(sim);
    return;
  }
  const api = await Api.login(args.api, args.email!, args.password!, args['ingest-key']!);
  await send(api, sim);
  if (args.process) await processAndCheck(api, sim.incidents);
}

async function writeFiles(sim: SimOutput) {
  const dir = args.out!;
  await mkdir(join(dir, 'telemetry'), { recursive: true });
  const { telemetry, ...rest } = sim;
  await writeFile(join(dir, 'scenario.json'), JSON.stringify(rest, null, 2));
  for (const [device, rows] of telemetry) await writeFile(join(dir, 'telemetry', `${device}.json`), JSON.stringify(rows));
  console.log(`Wrote ${dir}/scenario.json and one telemetry file per device.`);
}

class Api {
  private constructor(
    private base: string,
    private token: string,
    private ingestKey: string,
  ) {}

  static async login(base: string, email: string, password: string, ingestKey: string) {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (!res.ok) throw new Error(`Sign-in failed (${res.status}): ${await res.text()}. Did you run npm run db:seed?`);
    const body = (await res.json()) as { token: string };
    return new Api(base, body.token, ingestKey);
  }

  async call<T = any>(method: string, path: string, body?: unknown, ingest = false): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (ingest) headers['x-ingest-key'] = this.ingestKey;
    else headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
    return text ? JSON.parse(text) : (undefined as T);
  }
}

async function send(api: Api, sim: SimOutput) {
  const vehicles = await api.call<{ id: string; registration: string }[]>('GET', '/vehicles');
  const routes = await api.call<{ id: string; code: string }[]>('GET', '/routes');
  const users = await api.call<{ id: string; email: string }[]>('GET', '/users');
  const [tank] = await api.call<{ id: string }[]>('GET', '/depot-tanks');
  const vehicleId = new Map(vehicles.map((v) => [v.registration, v.id]));
  const routeId = new Map(routes.map((r) => [r.code, r.id]));
  const userId = new Map(users.map((u) => [u.email, u.id]));
  const need = <T>(m: Map<string, T>, k: string, what: string) => {
    const v = m.get(k);
    if (!v) throw new Error(`${what} "${k}" is not in the database. Run npm run db:reset && npm run db:seed first.`);
    return v;
  };

  let n = 0;
  for (const [deviceId, rows] of sim.telemetry) {
    for (let i = 0; i < rows.length; i += 5000) {
      await api.call('POST', '/ingest/telemetry', { deviceId, readings: rows.slice(i, i + 5000) }, true);
      n += Math.min(5000, rows.length - i);
    }
    process.stdout.write(`\r  sent ${n.toLocaleString()} tracker readings`);
  }
  console.log();

  for (const t of sim.trips) {
    const trip = await api.call<{ id: string }>('POST', '/trips', {
      vehicleId: need(vehicleId, t.registration, 'Vehicle'),
      driverId: need(userId, t.driverEmail, 'Driver'),
      routeId: need(routeId, t.routeCode, 'Route'),
      startedAt: t.startedAt,
      loadKg: t.loadKg,
      passengers: t.passengers,
      weather: t.weather,
    });
    await api.call('POST', `/trips/${trip.id}/close`, { endedAt: t.endedAt });
  }
  console.log(`  sent ${sim.trips.length} trips`);

  // refuels, deliveries and dips in time order, so each dip is checked against what came before it
  type Ev = { at: string; run: () => Promise<unknown> };
  const events: Ev[] = [
    ...sim.refuels.map((r) => ({
      at: r.occurredAt,
      run: () =>
        api.call('POST', '/refuels', {
          vehicleId: need(vehicleId, r.registration, 'Vehicle'),
          driverId: need(userId, r.driverEmail, 'Driver'),
          source: r.source,
          depotTankId: r.source === 'depot' ? tank.id : undefined,
          litres: r.litres,
          pricePerL: r.pricePerL,
          odometerKm: r.odometerKm,
          stationName: r.stationName,
          lat: r.lat,
          lon: r.lon,
          cardTxnRef: r.cardTxnRef,
          pumpReading: r.pumpReading,
          occurredAt: r.occurredAt,
        }),
    })),
    ...sim.deliveries.map((d) => ({ at: d.deliveredAt, run: () => api.call('POST', `/depot-tanks/${tank.id}/deliveries`, d) })),
    ...sim.dips.map((d) => ({ at: d.measuredAt, run: () => api.call('POST', `/depot-tanks/${tank.id}/dips`, d) })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const e of events) await e.run();
  console.log(`  sent ${sim.refuels.length} refuels, ${sim.deliveries.length} deliveries, ${sim.dips.length} dips`);
}

async function processAndCheck(api: Api, incidents: Incident[]) {
  console.log('Running the analysis...');
  const t0 = Date.now();
  const { vehicles } = await api.call<{ vehicles: any[] }>('POST', '/processing/run', {});
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.table(vehicles.map((v) => ({ vehicle: v.registration, trips: v.tripsProcessed, segments: v.segments, refuelsMatched: v.refuelsMatched, tankEvents: v.fuelEvents, newAlerts: v.newAlerts })));

  const alerts = await api.call<any[]>('GET', '/alerts?status=open,investigating,explained,confirmed_loss&limit=1000');
  const used = new Set<string>();
  const rows = incidents.map((inc) => {
    const type = inc.expectedAlert.split(' ')[0];
    const hit = alerts.find(
      (a) =>
        !used.has(a.id) &&
        a.type === type &&
        (inc.registration === null || a.registration === inc.registration) &&
        Math.abs(Date.parse(a.occurredAt) - Date.parse(inc.at)) < 12 * 3600_000,
    );
    if (hit) used.add(hit.id);
    return { incident: inc.kind, vehicle: inc.registration ?? 'depot', expected: type, caught: hit ? 'yes' : 'NO', alertLitres: hit?.litres ?? '', severity: hit?.severity ?? '' };
  });
  console.log('\nStaged incidents and the alerts they raised:');
  console.table(rows);
  const others = alerts.filter((a) => !used.has(a.id));
  const byType = others.reduce<Record<string, number>>((acc, a) => ((acc[a.type] = (acc[a.type] ?? 0) + 1), acc), {});
  console.log(`Other alerts from normal driving: ${others.length}`, byType);
  const missed = rows.filter((r) => r.caught !== 'yes').length;
  if (missed) {
    console.log(`\n${missed} staged incident(s) were not caught.`);
    process.exitCode = 1;
  } else {
    console.log('\nEvery staged incident was caught.');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
