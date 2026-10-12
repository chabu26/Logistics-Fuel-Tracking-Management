import { createServer } from 'node:http';
import { pool } from './db';
import { Router } from './http';
import { analysisRoutes } from './routes/analysis';
import { authRoutes } from './routes/auth';
import { fleetRoutes } from './routes/fleet';
import { operationsRoutes } from './routes/operations';

export function buildRouter() {
  const r = new Router();
  r.get('/health', { auth: 'none' }, async () => {
    await pool.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  });
  authRoutes(r);
  fleetRoutes(r);
  operationsRoutes(r);
  analysisRoutes(r);
  return r;
}

export function buildServer() {
  const router = buildRouter();
  return createServer((req, res) => {
    void router.handle(req, res);
  });
}
