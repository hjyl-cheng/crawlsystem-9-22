import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

export function createPool(env: NodeJS.ProcessEnv = process.env): Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const url = new URL(connectionString);
  if (!/^crawlsystem_m1_[a-z0-9_]+_test$/.test(url.pathname.slice(1))) throw new Error('M1 requires an isolated crawlsystem_m1_*_test database');
  if ([...url.searchParams.keys()].some(key=>key.startsWith('ssl'))) throw new Error('Use PG_CA_FILE instead of URL TLS overrides');
  const max = Number(env.PG_POOL_MAX ?? '4');
  if (!Number.isInteger(max) || max < 1 || max > 8) throw new Error('PG_POOL_MAX must be between 1 and 8');
  if (!env.PG_CA_FILE && env.M1_ALLOW_LOCAL_PG_PLAINTEXT !== '1') throw new Error('PG_CA_FILE is required');
  if (!env.PG_CA_FILE && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Plaintext development PG must be local');
  const pool = new Pool({ connectionString, max, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000,
    ssl: env.PG_CA_FILE ? { ca: readFileSync(env.PG_CA_FILE, 'utf8'), rejectUnauthorized: true, servername: env.PG_TLS_SERVERNAME } : undefined,
    application_name: 'crawlsystem-m1', query_timeout: 5000,
  });
  // pg evicts failed idle connections before emitting error. Handle the event so
  // a database restart does not terminate the API process or expose credentials.
  pool.on('error',error=>process.stderr.write(JSON.stringify({event:'database_idle_connection_lost',code:(error as {code?:string}).code ?? 'CONNECTION_LOST'})+'\n'));
  return pool;
}
