const isProd = process.env.NODE_ENV === 'production';

function required(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`${name} must be set in production`);
  return devDefault;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL', 'postgres://fleetfuel:fleetfuel@localhost:5432/fleetfuel'),
  /** Secret used to sign sign-in tokens */
  authSecret: required('AUTH_SECRET', 'dev-only-secret-change-me'),
  /** Hours a sign-in token stays valid */
  tokenTtlHours: Number(process.env.TOKEN_TTL_HOURS ?? 12),
  /** Shared key trackers (or the simulator) send in the x-ingest-key header */
  ingestKey: required('INGEST_KEY', 'dev-ingest-key'),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  /** Telemetry batches can be large */
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 20 * 1024 * 1024),
};
