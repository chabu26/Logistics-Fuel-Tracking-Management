# Notes for working on this repo

- Monorepo with npm workspaces: `packages/shared` (analysis engine), `apps/api` (backend), `apps/simulator`.
- TypeScript everywhere, run with `tsx` (no build step). Tests use `node:test` via `tsx --test`.
- All analysis logic lives in `packages/shared` so the web and mobile apps can reuse it. Keep it free of database code.
- The API uses Node's built-in `http` with a small router (`apps/api/src/http.ts`), `pg` and `zod`. Every query on business tables must filter by `company_id` from the signed-in user.
- Alerts are written with a `dedupe_key` so re-running processing never duplicates them.
- Before finishing a change to analysis or processing, run `npm test`, `npm run typecheck`, and the end-to-end check: `npm run db:reset && npm run db:seed`, start the API, then `npm run simulate -- --days 14 --api http://localhost:4000 --process`. It must report that every staged incident was caught, with no new false alerts.
- Product requirements: Fleet Fuel Platform Requirements doc (configurable SaaS, Zambia first, trucks and buses, fleet managers as main users).
