# Fleet Fuel Platform

A SaaS platform for logistics and bus companies that shows **where, when and why each vehicle uses fuel**, accounts for every litre bought, used and left, and flags fuel that can't be explained.

It runs on GPS trackers and tank fuel-level sensors. Until real devices are installed, a built-in **tracker simulator** produces realistic data for a demo fleet on Zambian routes, including staged theft, so every part of the system can be built and tested now.

This repository is the **foundation**: database, backend API, analysis engine and simulator. The web dashboard and mobile app come next.

## What it does today

| Area | What's in place |
| --- | --- |
| Consumption analysis | Every trip is cut into ~1 km segments, each tagged with speed band, gradient, traffic, road shape, time of day, load, surface, weather, route and driver, plus the litres it used. Ask for any vehicle: where does it use the most, least and average fuel, under any combination of conditions. |
| Fuel management | Every refuel (depot, fuel card, cash) is matched to the rise the tank sensor saw. Fuel balance per vehicle: in, used, left, unexplained. Depot tank stock: deliveries, dispensing, dips. |
| Loss detection | Alerts for: fuel drop while parked, receipt bigger than what went in, refuel with no record, receipt bigger than the room in the tank, trip using far more than normal for its conditions and load, long idling, depot stock gap, tracker disconnected while moving. |
| Multi-company | Every table is scoped by company. Each company can override loss thresholds in `companies.settings.lossRules`. |
| Roles | Admin, fleet manager, owner, driver, depot attendant, each limited to what they need. |

## Quick start

Needs Node.js 20+ and Docker.

```bash
npm install
cp .env.example .env
npm run db:up        # PostgreSQL + TimescaleDB in Docker
npm run db:migrate
npm run db:seed      # demo company, 7 vehicles, 11 people, 5 Zambian routes, depot tank
npm run dev:api      # http://localhost:4000
```

In a second terminal, fill it with two weeks of simulated fleet data and run the analysis:

```bash
npm run simulate -- --days 14 --api http://localhost:4000 --process
```

This sends ~200,000 tracker readings, 128 trips and every refuel through the API, runs the analysis, and prints which staged incidents were caught. Every one should be.

Demo sign-in: `admin@demo.zm`, `fleet@demo.zm` or `owner@demo.zm`, password `demo1234`.

Start over at any time with `npm run db:reset && npm run db:seed`.

## Project layout

```
packages/shared     Analysis engine, shared by the API and (later) the web and mobile apps
  src/conditions.ts     Tagging rules: speed bands, gradient, traffic, time of day, load
  src/segmentation.ts   Trip → segments; tank rises and drops; idling; tracker data gaps
  src/consumption.ts    Most / least / average fuel by any combination of conditions
  src/reconciliation.ts Refuel matching, loss alerts, baselines, fuel balance, depot stock
  src/demo/             Demo company: Zambian routes, vehicles, people
  test/                 Unit tests (node:test)
apps/api            Backend API (Node.js, TypeScript, PostgreSQL)
  db/migrations/        SQL schema
  src/processing.ts     Runs the analysis on new data and stores segments and alerts
  src/routes/           HTTP endpoints
apps/simulator      Tracker simulator with vehicle physics and staged incidents
```

## How the analysis works

**Segments.** Each closed trip's readings are cut into ~1 km pieces. Litres per piece come from the engine's CAN fuel counter when the vehicle has one, otherwise from the tank sensor (smoothed, with signed differences so sensor noise cancels out instead of adding up). Long stops with the engine on become idle segments.

**Most / least fuel.** Moving segments are grouped by the conditions the manager picks (for example gradient + speed + load). A group needs at least 10 km of driving before its figure is trusted.

**Refuel matching.** Tank rises are found inside each stop, so a siphon at night and a refuel the next morning in the same stop are two separate events. Each refuel record is paired with the closest rise within 60 minutes and 3 km.

**Abnormal trips.** A trip is compared with what this vehicle normally uses on the same gradient, at the same speed, with a similar load (4-tonne bands), over the 90 days around it. A trip is only judged when the vehicle has at least 400 km of history and most of the trip's conditions and load have been seen before; otherwise it is left alone rather than guessed.

**Depot stock.** Each dip is compared with the previous dip plus deliveries minus dispensing since then, so a loss is flagged once, at the dip that first shows it.

## API

All endpoints except `/health`, `/auth/login` and `/ingest/telemetry` need `Authorization: Bearer <token>` from `/auth/login`.

| Method | Path | Who | What |
| --- | --- | --- | --- |
| POST | `/auth/login` | anyone | Email + password → token |
| GET | `/me` | signed in | Current user and company |
| GET, POST | `/vehicles` | POST: admin, fleet manager | List or add vehicles |
| GET, PATCH | `/vehicles/:id` | PATCH: admin, fleet manager | One vehicle; update it |
| GET, POST | `/routes` | POST: admin, fleet manager | Routes |
| GET, POST | `/users` | GET: managers, owner; POST: admin | People and roles |
| POST | `/trips` | admin, fleet manager, driver | Start a trip with load or passengers |
| POST | `/trips/:id/close` | admin, fleet manager, driver | End a trip |
| GET | `/trips` | signed in | Trips with distance and fuel |
| POST, GET | `/refuels` | drivers: card and cash; depot attendant: depot | Log a refuel; list them |
| GET, POST | `/depot-tanks` | POST: admin, fleet manager | Depot tanks |
| POST | `/depot-tanks/:id/deliveries` | depot staff, managers | Fuel delivered into a tank |
| POST | `/depot-tanks/:id/dips` | depot staff, managers | Physical dip; flags any stock gap |
| GET | `/depot-tanks/:id/stock` | signed in | Expected stock now |
| POST | `/ingest/telemetry` | trackers (`x-ingest-key`) | Up to 20,000 readings per call |
| GET | `/vehicles/:id/consumption` | managers, owner | Most / least / average fuel by conditions |
| GET | `/vehicles/:id/fuel-balance` | managers, owner | Fuel in, used, left, unexplained |
| GET | `/fleet/summary` | managers, owner | One row per vehicle |
| GET | `/alerts` | managers, owner | Alerts, newest first |
| PATCH | `/alerts/:id` | admin, fleet manager | Mark investigating, explained or confirmed loss |
| POST | `/processing/run` | admin, fleet manager | Run the analysis now |

`/vehicles/:id/consumption` takes `from`, `to` (ISO dates, default last 30 days), `dims` (conditions to combine, default `gradient,speedBand`) and any condition as a filter, for example:

```
GET /vehicles/<id>/consumption?dims=gradient,speedBand,loadClass&routeId=<id>&weather=rain
```

```json
{
  "headline": {
    "most": "uphill, 20–40 km/h, full load: 117.7 L/100km",
    "least": "downhill, 40–60 km/h, empty: 14.7 L/100km",
    "average": "43 L/100km over 10623.5 km"
  },
  "fleetAverageLPer100km": 38.9,
  "idling": { "durationS": 62141, "fuelUsedL": 70.2, "lPerHour": 4.07, "periods": 610 },
  "groups": [ ... ],
  "breakdowns": { "speedBand": [ ... ], "traffic": [ ... ], "loadClass": [ ... ] }
}
```

## Simulator

`npm run simulate -- [options]`

| Option | Default | |
| --- | --- | --- |
| `--days` | 14 | Days to simulate |
| `--start` | so it ends yesterday | First day, `YYYY-MM-DD` |
| `--seed` | 42 | Same seed, same history |
| `--api` | (none) | Send through this API instead of writing files |
| `--process` | off | Run the analysis afterwards and check every staged incident was caught |
| `--no-incidents` | off | A clean fleet with no staged theft |
| `--out` | `sim-output` | Folder for JSON output when `--api` is not given |

Vehicles are modelled with mass, load, drag, rolling resistance, engine power and efficiency on routes with real gradients (the Zambezi escarpment to Chirundu, the Luangwa valley on the Great East Road), town traffic, police checkpoints, rain, and drivers with different habits. The tank sensor is noisy and fuel sloshes when braking, as on real vehicles.

Staged incidents: inflated cash receipt, overnight siphoning, fuel card used for another vehicle, tracker unplugged on the road, refuel with no receipt, faulty injector, 45-minute idling, and fuel taken from the depot tank.

## Development

```bash
npm test             # unit tests
npm run typecheck
```

GitHub Actions runs type checks, unit tests and the full simulated end-to-end check on every push.

## Next steps

1. Web dashboard (Next.js): vehicle view with the conditions grid, fuel balance, alerts inbox, reports
2. Mobile app (React Native): manager alerts; driver cash refuels with receipt photo, load and passengers; depot attendant dispensing
3. Scheduled processing and WhatsApp / email alert delivery
4. Reports: vehicle consumption, fuel stock and reconciliation, driver figures, fuel cost
5. Connect the chosen tracker brand to `/ingest/telemetry`
6. Phase 2: maintenance warnings from rising consumption; trip fuel allocation (the `expectedFuel` function already does the calculation)
