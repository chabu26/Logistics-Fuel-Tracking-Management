import { buildServer } from './app';
import { pool } from './db';
import { env } from './env';

const server = buildServer();
server.listen(env.port, () => console.log(`Fleet fuel API listening on http://localhost:${env.port}`));

const shutdown = () => {
  server.close(() => void pool.end().then(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
