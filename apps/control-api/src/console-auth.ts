import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { IdSchema, type ConsoleAccount, type ConsoleAccountList, type Principal } from '@crawlsystem/contracts';
import { StoreError } from '@crawlsystem/store';
import type { ConsoleSessionRepository } from '@crawlsystem/store/console-sessions';
import { contentHash } from '@crawlsystem/contracts/hash';

const derive = promisify(scrypt);
export const AccountSchema = z.strictObject({
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  subject: IdSchema, workspace_id: IdSchema, role: z.enum(['reader', 'operator']),
  salt: z.string().regex(/^[a-f0-9]{32}$/), password_hash: z.string().regex(/^[a-f0-9]{128}$/),
});
export type Account = z.infer<typeof AccountSchema>;
export const AccountsSchema=z.array(AccountSchema).min(1).max(100).refine(accounts=>new Set(accounts.map(a=>a.username)).size===accounts.length,'duplicate username');
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
  createSession(tokenHash: string, username: string, now: Date, expiresAt: Date, verified:Account): Promise<boolean>;
  /** Resolves the current principal of an active session on an enabled account. */
  sessionPrincipal(tokenHash: string, now: Date): Promise<Principal | undefined>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  consumeAttempt?(usernameHash:string):Promise<boolean>;
  /** Accounts of one workspace without password material, for the user management page. */
  listAccounts?(workspaceId:string,now:Date):Promise<Omit<ConsoleAccountList,'observed_at'>>;
}
const MAX_LISTED_ACCOUNTS=500;

/** In-process store for tests and local development without a database. */
export class MemoryAccountStore implements AccountStore {
  private readonly accounts: Account[];
  private readonly sessions = new Map<string, { username: string; expires: number }>();
  constructor(accounts: unknown) { this.accounts = AccountsSchema.parse(accounts); }
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
  async listAccounts(workspaceId: string, now: Date) {
    const live = [...this.sessions.values()].filter(s => s.expires > now.getTime());
    return { source: 'MEMORY' as const, items: this.accounts.filter(a => a.workspace_id === workspaceId).slice(0, MAX_LISTED_ACCOUNTS).map((a): ConsoleAccount => ({
      username: a.username, subject: a.subject, role: a.role, status: 'ACTIVE', created_at: null, updated_at: null,
      active_sessions: live.filter(s => s.username === a.username).length, latest_session_at: null,
    })) };
  }
}

/** File accounts remain supported for isolated M1 runs, using shared PG state. */
class FixedAccounts implements AccountStore {
  private accounts:Account[];private authority:string;
  constructor(accounts:unknown,private repository:ConsoleSessionRepository){
    this.accounts=AccountsSchema.parse(accounts);this.authority=contentHash([...this.accounts].sort((a,b)=>a.username.localeCompare(b.username)));
  }
  async findAccount(username:string){return this.accounts.find(a=>a.username===username);}
  async createSession(hash:string,_username:string,now:Date,expires:Date,verified:Account){
    return this.repository.save(this.authority,hash,{subject:verified.subject,workspace_id:verified.workspace_id,role:verified.role},expires.getTime()-now.getTime());
  }
  async sessionPrincipal(hash:string){return this.repository.find(this.authority,hash);}
  async revokeSession(hash:string){await this.repository.revoke(this.authority,hash);}
  async consumeAttempt(hash:string){return this.repository.consumeAttempt(this.authority,hash);}
  // Sessions are keyed by token only, so per-account session figures are unknown here.
  async listAccounts(workspaceId:string){
    return {source:'FILE' as const,items:this.accounts.filter(a=>a.workspace_id===workspaceId).slice(0,MAX_LISTED_ACCOUNTS).map((a):ConsoleAccount=>({
      username:a.username,subject:a.subject,role:a.role,status:'ACTIVE',created_at:null,updated_at:null,active_sessions:null,latest_session_at:null}))};
  }
}

/** Production stores share session and login-budget state through PostgreSQL. */
export class ConsoleAuth {
  private readonly store:AccountStore;
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly dummy = { salt: randomBytes(16).toString('hex'), password_hash: randomBytes(64).toString('hex') };
  private inFlight = 0;
  readonly lifetimeMs = 8 * 60 * 60_000;
  readonly cookieName: string;
  constructor(accountsOrStore:unknown,private secure=true,private now=Date.now,repository?:ConsoleSessionRepository) {
    this.store=Array.isArray(accountsOrStore)?(repository?new FixedAccounts(accountsOrStore,repository):new MemoryAccountStore(accountsOrStore)):accountsOrStore as AccountStore;
    this.cookieName = secure ? '__Host-crawlsystem-session' : 'crawlsystem-session';
  }
  static fromFile(path:string,secure:boolean,repository:ConsoleSessionRepository){return new ConsoleAuth(new FixedAccounts(JSON.parse(readFileSync(path,'utf8')),repository),secure);}
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
    if(this.store.consumeAttempt){if(!await this.store.consumeAttempt(digest(username)))throw new StoreError('UNAVAILABLE','Too many login attempts; try again in one minute',429,true);}
    else {this.limit('all',60);this.limit('user:'+digest(username),10);}
    if (this.inFlight >= 2) throw new StoreError('UNAVAILABLE', 'Login capacity reached', 503, true);
    this.inFlight++;
    try {
      const account = await this.store.findAccount(username);
      const candidate = account ?? this.dummy;
      const actual = await derive(password, candidate.salt, 64) as Buffer;
      const matches = timingSafeEqual(actual, Buffer.from(candidate.password_hash, 'hex'));
      if (!account || !matches) throw new StoreError('UNAUTHENTICATED', 'Username or password is incorrect', 401);
      const secret = randomBytes(32).toString('base64url'), now = this.now();
      if (!await this.store.createSession(digest(secret), account.username, new Date(now), new Date(now + this.lifetimeMs),account)) {
        throw new StoreError('UNAVAILABLE', 'Session capacity reached', 503, true);
      }
      await this.revoke(previousCookie);
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
  /** Lists the caller's own workspace only; Worker identities never see console accounts. */
  async listAccounts(principal: Principal): Promise<ConsoleAccountList> {
    if (principal.role !== 'reader' && principal.role !== 'operator') throw new StoreError('FORBIDDEN', 'This role cannot perform the operation', 403);
    if (!this.store.listAccounts) throw new StoreError('DEPENDENCY_NOT_IMPLEMENTED', 'Account listing is not available for this account source', 503);
    const now = new Date(this.now());
    return { observed_at: now.toISOString(), ...await this.store.listAccounts(principal.workspace_id, now) };
  }
  private cookie(value: string, seconds: number) {
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.secure ? '; Secure' : ''}`;
  }
  clearCookie() { return this.cookie('', 0); }
}
