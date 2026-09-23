import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { IdSchema, type Principal } from '@crawlsystem/contracts';
import { StoreError } from '@crawlsystem/store';

const derive = promisify(scrypt);
export const AccountSchema = z.strictObject({
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  subject: IdSchema, workspace_id: IdSchema, role: z.enum(['reader', 'operator']),
  salt: z.string().regex(/^[a-f0-9]{32}$/), password_hash: z.string().regex(/^[a-f0-9]{128}$/),
});
export type Account = z.infer<typeof AccountSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function passwordRecord(password: string) {
  if (password.length < 12 || password.length > 256) throw new Error('Password must be 12..256 characters');
  const salt = randomBytes(16).toString('hex');
  return { salt, password_hash: (await derive(password, salt, 64) as Buffer).toString('hex') };
}
export const MAX_ACTIVE_SESSIONS = 200;

/** Durable home of console accounts and sessions. Session keys are SHA-256
 * digests of the cookie secret; the secret itself is never stored. */
export interface AccountStore {
  findAccount(username: string): Promise<Account | undefined>;
  /** Returns false when the active-session capacity is reached. */
  createSession(tokenHash: string, username: string, now: Date, expiresAt: Date): Promise<boolean>;
  /** Resolves the current principal of an active session on an enabled account. */
  sessionPrincipal(tokenHash: string, now: Date): Promise<Principal | undefined>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
}

/** In-process store for tests and local development without a database. */
export class MemoryAccountStore implements AccountStore {
  private readonly accounts: Account[];
  private readonly sessions = new Map<string, { username: string; expires: number }>();
  constructor(accounts: unknown) { this.accounts = z.array(AccountSchema).max(100).parse(accounts); }
  async findAccount(username: string) { return this.accounts.find(a => a.username === username); }
  async createSession(tokenHash: string, username: string, now: Date, expiresAt: Date) {
    for (const [key, value] of this.sessions) if (value.expires <= now.getTime()) this.sessions.delete(key);
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) return false;
    this.sessions.set(tokenHash, { username, expires: expiresAt.getTime() });
    return true;
  }
  async sessionPrincipal(tokenHash: string, now: Date) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expires <= now.getTime()) return undefined;
    const account = this.accounts.find(a => a.username === session.username);
    return account && { subject: account.subject, workspace_id: account.workspace_id, role: account.role };
  }
  async revokeSession(tokenHash: string) { this.sessions.delete(tokenHash); }
}

/** Password login with opaque, revocable sessions that expire after 8 hours.
 * Login rate limits are per API process. */
export class ConsoleAuth {
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly dummy = { salt: randomBytes(16).toString('hex'), password_hash: randomBytes(64).toString('hex') };
  private inFlight = 0;
  readonly lifetimeMs = 8 * 60 * 60_000;
  readonly cookieName: string;
  constructor(private readonly store: AccountStore, private secure = true, private now = Date.now) {
    this.cookieName = secure ? '__Host-crawlsystem-session' : 'crawlsystem-session';
  }
  private cookieValue(header?: string) {
    const values = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(this.cookieName + '='));
    const value = values.length === 1 ? values[0]!.slice(this.cookieName.length + 1) : '';
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
  }
  private limit(key: string, max: number) {
    const now = this.now();
    for (const [k, value] of this.attempts) if (value.until <= now) this.attempts.delete(k);
    const entry = this.attempts.get(key) ?? { count: 0, until: now + 60_000 };
    if (entry.count >= max || (!this.attempts.has(key) && this.attempts.size >= 1000)) {
      throw new StoreError('UNAVAILABLE', 'Too many login attempts; try again in one minute', 429, true);
    }
    entry.count++; this.attempts.set(key, entry);
  }
  async login(username: string, password: string, previousCookie?: string) {
    this.limit('all', 60); this.limit('user:' + digest(username), 10);
    if (this.inFlight >= 2) throw new StoreError('UNAVAILABLE', 'Login capacity reached', 503, true);
    this.inFlight++;
    try {
      const account = await this.store.findAccount(username);
      const candidate = account ?? this.dummy;
      const actual = await derive(password, candidate.salt, 64) as Buffer;
      const matches = timingSafeEqual(actual, Buffer.from(candidate.password_hash, 'hex'));
      if (!account || !matches) throw new StoreError('UNAUTHENTICATED', 'Username or password is incorrect', 401);
      await this.revoke(previousCookie);
      const secret = randomBytes(32).toString('base64url'), now = this.now();
      if (!await this.store.createSession(digest(secret), account.username, new Date(now), new Date(now + this.lifetimeMs))) {
        throw new StoreError('UNAVAILABLE', 'Session capacity reached', 503, true);
      }
      const principal: Principal = { subject: account.subject, workspace_id: account.workspace_id, role: account.role };
      return { principal, cookie: this.cookie(secret, this.lifetimeMs / 1000) };
    } finally { this.inFlight--; }
  }
  async authenticate(header?: string): Promise<Principal> {
    const value = this.cookieValue(header);
    const principal = value ? await this.store.sessionPrincipal(digest(value), new Date(this.now())) : undefined;
    if (!principal) throw new StoreError('UNAUTHENTICATED', 'Session expired; sign in again', 401);
    return principal;
  }
  async revoke(header?: string) {
    const value = this.cookieValue(header);
    if (value) await this.store.revokeSession(digest(value), new Date(this.now()));
  }
  private cookie(value: string, seconds: number) {
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.secure ? '; Secure' : ''}`;
  }
  clearCookie() { return this.cookie('', 0); }
}
