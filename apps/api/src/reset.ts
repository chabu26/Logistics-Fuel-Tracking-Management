/** Drop every table and re-run the migrations. Development only. */
import { execFileSync } from 'node:child_process';
import { env } from './env';
import { pool } from './db';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.end();
  console.log(`Emptied ${env.databaseUrl.replace(/:[^:@/]+@/, ':***@')}`);
  execFileSync(process.execPath, [...process.execArgv, new URL('./migrate.ts', import.meta.url).pathname], { stdio: 'inherit' });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
