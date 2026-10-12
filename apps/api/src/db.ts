import pg from 'pg';
import { env } from './env';

// Return numeric columns as JS numbers (safe for litres, km and money at our scale)
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v: string) => parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => parseInt(v, 10));

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });

export type Queryable = Pick<pg.Pool, 'query'>;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], db: Queryable = pool) {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], db: Queryable = pool) {
  const rows = await query<T>(text, params, db);
  return rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
