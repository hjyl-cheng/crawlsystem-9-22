import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import type { Principal } from '@crawlsystem/contracts';
import { StoreError } from '@crawlsystem/store';
import type { ConsoleSessionRepository } from '@crawlsystem/store/console-sessions';
import { AccountSchema, MAX_ACTIVE_SESSIONS, type AccountStore,type Account } from './console-auth.ts';

/** Pool for the `console` schema of the formal `crawler` database. It is separate
 * from the M1 fact pool, which must point at an isolated test database. */
export function createConsolePool(env: NodeJS.ProcessEnv = process.env): Pool {
  const connectionString = env.CONSOLE_DATABASE_URL;
  if (!connectionString) throw new Error('CONSOLE_DATABASE_URL is required');
  const url = new URL(connectionString);
  if ([...url.searchParams.keys()].some(key => key.startsWith('ssl'))) throw new Error('Use PG_CA_FILE instead of URL TLS overrides');
  if (!env.PG_CA_FILE) throw new Error('PG_CA_FILE is required for the console database');
  const max=Number(env.CONSOLE_PG_POOL_MAX ?? '1');
  if(!Number.isInteger(max)||max<1||max>2)throw new Error('CONSOLE_PG_POOL_MAX must be between 1 and 2');
  const pool = new Pool({ connectionString, max, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000,
    ssl: { ca: readFileSync(env.PG_CA_FILE, 'utf8'), rejectUnauthorized: true, servername: env.PG_TLS_SERVERNAME },
    application_name: 'crawlsystem-console', query_timeout: 5000,
  });
  pool.on('error', error => process.stderr.write(JSON.stringify({ event: 'console_database_idle_connection_lost', code: (error as { code?: string }).code ?? 'CONNECTION_LOST' }) + '\n'));
  return pool;
}

export class PgAccountStore implements AccountStore {
  constructor(private readonly pool: Pool,private readonly budget:Pick<ConsoleSessionRepository,'consumeAttempt'>) {}
  consumeAttempt(usernameHash:string){return this.budget.consumeAttempt('console.accounts.v1',usernameHash);}
  async findAccount(username: string) {
    const { rows } = await this.pool.query(
      `SELECT username, subject, workspace_id, role, password_salt AS salt, password_hash
         FROM console.accounts WHERE username = $1 AND disabled_at IS NULL`, [username]);
    return rows[0] ? AccountSchema.parse(rows[0]) : undefined;
  }
  async createSession(tokenHash: string, username: string, now: Date, expiresAt: Date,verified:Account) {
    // Bounded cleanup keeps the table at roughly the number of live sessions.
    await this.pool.query(
      `DELETE FROM console.sessions WHERE token_hash IN
         (SELECT token_hash FROM console.sessions WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    const client=await this.pool.connect();let discard=false;
    try {
      await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2s'");await client.query("SET LOCAL transaction_timeout='5s'");
      await client.query('SELECT pg_advisory_xact_lock(626202609)');
      const account=(await client.query('SELECT password_hash,password_salt,disabled_at FROM console.accounts WHERE username=$1 FOR UPDATE',[username])).rows[0];
      if(!account||account.disabled_at||account.password_hash!==verified.password_hash||account.password_salt!==verified.salt)throw new StoreError('UNAUTHENTICATED','Account changed; sign in again',401);
      const count=(await client.query('SELECT count(*)::int AS n FROM console.sessions WHERE expires_at>clock_timestamp()')).rows[0].n;
      if(count>=MAX_ACTIVE_SESSIONS){await client.query('COMMIT');return false;}
      await client.query(`INSERT INTO console.sessions(token_hash,username,created_at,expires_at)
        VALUES($1,$2,clock_timestamp(),clock_timestamp()+($3*interval '1 millisecond'))`,[tokenHash,username,expiresAt.getTime()-now.getTime()]);
      await client.query('COMMIT');return true;
    } catch(error) {
      discard=/connection|timeout/i.test((error as Error).message);if(!discard)await client.query('ROLLBACK').catch(()=>{discard=true;});throw error;
    } finally {client.release(discard);}
  }
  async sessionPrincipal(tokenHash: string, now: Date): Promise<Principal | undefined> {
    const { rows } = await this.pool.query(
      `SELECT a.subject, a.workspace_id, a.role FROM console.sessions s JOIN console.accounts a USING (username)
        WHERE s.token_hash = $1 AND s.expires_at > clock_timestamp() AND a.disabled_at IS NULL`, [tokenHash]);
    return rows[0];
  }
  async revokeSession(tokenHash: string) {
    await this.pool.query('DELETE FROM console.sessions WHERE token_hash = $1', [tokenHash]);
  }
}
