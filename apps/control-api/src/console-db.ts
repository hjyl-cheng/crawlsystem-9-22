import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import type { Principal } from '@crawlsystem/contracts';
import { AccountSchema, MAX_ACTIVE_SESSIONS, type AccountStore } from './console-auth.ts';

/** Pool for the `console` schema of the formal `crawler` database. It is separate
 * from the M1 fact pool, which must point at an isolated test database. */
export function createConsolePool(env: NodeJS.ProcessEnv = process.env): Pool {
  const connectionString = env.CONSOLE_DATABASE_URL;
  if (!connectionString) throw new Error('CONSOLE_DATABASE_URL is required');
  const url = new URL(connectionString);
  if ([...url.searchParams.keys()].some(key => key.startsWith('ssl'))) throw new Error('Use PG_CA_FILE instead of URL TLS overrides');
  if (!env.PG_CA_FILE) throw new Error('PG_CA_FILE is required for the console database');
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000,
    ssl: { ca: readFileSync(env.PG_CA_FILE, 'utf8'), rejectUnauthorized: true, servername: env.PG_TLS_SERVERNAME },
    application_name: 'crawlsystem-console', query_timeout: 5000,
  });
  pool.on('error', error => process.stderr.write(JSON.stringify({ event: 'console_database_idle_connection_lost', code: (error as { code?: string }).code ?? 'CONNECTION_LOST' }) + '\n'));
  return pool;
}

export class PgAccountStore implements AccountStore {
  constructor(private readonly pool: Pool) {}
  async findAccount(username: string) {
    const { rows } = await this.pool.query(
      `SELECT username, subject, workspace_id, role, password_salt AS salt, password_hash
         FROM console.accounts WHERE username = $1 AND disabled_at IS NULL`, [username]);
    return rows[0] ? AccountSchema.parse(rows[0]) : undefined;
  }
  async createSession(tokenHash: string, username: string, now: Date, expiresAt: Date) {
    // Bounded cleanup keeps the table at roughly the number of live sessions.
    await this.pool.query(
      `DELETE FROM console.sessions WHERE token_hash IN
         (SELECT token_hash FROM console.sessions WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100)`, [now]);
    const result = await this.pool.query(
      `INSERT INTO console.sessions (token_hash, username, created_at, expires_at)
       SELECT $1, $2, $3, $4 WHERE (SELECT count(*) FROM console.sessions WHERE expires_at > $3) < $5`,
      [tokenHash, username, now, expiresAt, MAX_ACTIVE_SESSIONS]);
    return result.rowCount === 1;
  }
  async sessionPrincipal(tokenHash: string, now: Date): Promise<Principal | undefined> {
    const { rows } = await this.pool.query(
      `SELECT a.subject, a.workspace_id, a.role FROM console.sessions s JOIN console.accounts a USING (username)
        WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.disabled_at IS NULL`, [tokenHash, now]);
    return rows[0];
  }
  async revokeSession(tokenHash: string) {
    await this.pool.query('DELETE FROM console.sessions WHERE token_hash = $1', [tokenHash]);
  }
}
