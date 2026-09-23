import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { z } from 'zod';
import { IdSchema, type Principal } from '@crawlsystem/contracts';
import { StoreError } from '@crawlsystem/store';

const derive = promisify(scrypt);
const AccountSchema = z.strictObject({
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  subject: IdSchema, workspace_id: IdSchema, role: z.enum(['reader', 'operator']),
  salt: z.string().regex(/^[a-f0-9]{32}$/), password_hash: z.string().regex(/^[a-f0-9]{128}$/),
});
export const AccountsSchema = z.array(AccountSchema).min(1).max(100)
  .refine(accounts => new Set(accounts.map(a => a.username)).size === accounts.length, 'duplicate username');
type Account = z.infer<typeof AccountSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function passwordRecord(password: string) {
  if (password.length < 12 || password.length > 256) throw new Error('Password must be 12..256 characters');
  const salt = randomBytes(16).toString('hex');
  return { salt, password_hash: (await derive(password, salt, 64) as Buffer).toString('hex') };
}

/** Small internal-console account store. Passwords are salted scrypt hashes;
 * sessions are opaque, revocable, bounded, and expire on restart or after 8 hours. */
export class ConsoleAuth {
  private readonly accounts: Account[];
  private readonly sessions = new Map<string, { principal: Principal; expires: number }>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private inFlight = 0;
  readonly lifetimeMs = 8 * 60 * 60_000;
  readonly cookieName: string;
  constructor(accounts: unknown, private secure = true, private now = Date.now) {
    this.accounts = AccountsSchema.parse(accounts);
    this.cookieName = secure ? '__Host-crawlsystem-session' : 'crawlsystem-session';
  }
  static fromFile(path: string, secure = true) { return new ConsoleAuth(JSON.parse(readFileSync(path, 'utf8')), secure); }
  private cookieValue(header?: string) {
    const values = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(this.cookieName + '='));
    const value = values.length === 1 ? values[0]!.slice(this.cookieName.length + 1) : '';
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
  }
  private clean() {
    const now = this.now();
    for (const [key, value] of this.sessions) if (value.expires <= now) this.sessions.delete(key);
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
  }
  private limit(key: string, max: number) {
    const entry = this.attempts.get(key) ?? { count: 0, until: this.now() + 60_000 };
    if (entry.count >= max || (!this.attempts.has(key) && this.attempts.size >= 1000)) {
      throw new StoreError('UNAVAILABLE', 'Too many login attempts; try again in one minute', 429, true);
    }
    entry.count++; this.attempts.set(key, entry);
  }
  async login(username: string, password: string, previousCookie?: string) {
    this.clean(); this.limit('all', 60); this.limit('user:' + digest(username), 10);
    if (this.inFlight >= 2) throw new StoreError('UNAVAILABLE', 'Login capacity reached', 503, true);
    this.inFlight++;
    try {
      const account = this.accounts.find(a => a.username === username);
      const candidate = account ?? this.accounts[0]!;
      const actual = await derive(password, candidate.salt, 64) as Buffer;
      const matches = timingSafeEqual(actual, Buffer.from(candidate.password_hash, 'hex'));
      if (!account || !matches) throw new StoreError('UNAUTHENTICATED', 'Username or password is incorrect', 401);
      this.revoke(previousCookie);
      if (this.sessions.size >= 200) throw new StoreError('UNAVAILABLE', 'Session capacity reached', 503, true);
      const principal: Principal = { subject: account.subject, workspace_id: account.workspace_id, role: account.role };
      const secret = randomBytes(32).toString('base64url');
      this.sessions.set(digest(secret), { principal, expires: this.now() + this.lifetimeMs });
      return { principal, cookie: this.cookie(secret, this.lifetimeMs / 1000) };
    } finally { this.inFlight--; }
  }
  authenticate(header?: string): Principal {
    const value = this.cookieValue(header);
    const key = digest(value), session = value ? this.sessions.get(key) : undefined;
    if (!session || session.expires <= this.now()) {
      this.sessions.delete(key);
      throw new StoreError('UNAUTHENTICATED', 'Session expired; sign in again', 401);
    }
    return session.principal;
  }
  revoke(header?: string) { const value = this.cookieValue(header); if (value) this.sessions.delete(digest(value)); }
  private cookie(value: string, seconds: number) {
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.secure ? '; Secure' : ''}`;
  }
  clearCookie() { return this.cookie('', 0); }
}
