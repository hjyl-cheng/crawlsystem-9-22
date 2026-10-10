import { IdentityStore, IDENTITY_POLICY, type BrowserIdentity } from './identity.ts';
import type { ProxyLease } from './transport.ts';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
export class FingerprintError extends Error {
  constructor(readonly kind: 'gateway' | 'proxy_transport' | 'upstream_transient', readonly curlCode?: number) { super(`Fingerprint transport: ${kind}`); this.name = 'FingerprintError'; }
  get penalizeProxy() { return this.kind === 'proxy_transport' || [5, 7, 28, 35, 56, 97].includes(this.curlCode ?? -1); }
}
export interface BrowserTransport { identity: BrowserIdentity; fetch: typeof fetch; failureKind?: () => 'blocked' | 'network' | null; }
/** Profiles are used exclusively within this Worker, and snapshotted after each completed request. */
export class FingerprintClient {
  private locks = new Map<string, Promise<void>>();
  private active = new Map<string, { profile_id: string; created_at: string; saved_at: string; egress_country: string | null }>();
  private lastProfile: { profile_id: string; created_at: string; saved_at: string } | null = null;
  constructor(private base: string, private store: IdentityStore, private fetcher: typeof fetch = fetch) {
    const url = new URL(base);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Fingerprint gateway must use loopback');
  }
  private async configure(identity: BrowserIdentity) {
    const response = await this.fetcher(`${this.base}/v1/profiles/${encodeURIComponent(identity.profile_id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...identity, engine: 'youtubejs_chrome', impersonate_target: IDENTITY_POLICY.browser, max_connections: 2 }), signal: AbortSignal.timeout(5000) }).catch(() => { throw new FingerprintError('gateway'); });
    if (!response.ok) throw new FingerprintError('gateway');
  }
  async withProfile<T>(lease: ProxyLease, signal: AbortSignal, work: (transport: BrowserTransport) => Promise<T>): Promise<T> {
    const proxy = new URL(lease.proxy_url), networkKey = `${lease.proxy_id}:${proxy.protocol}//${proxy.host}`;
    const insecure = proxy.hash === '#insecure-tls' && !proxy.username && !proxy.password; proxy.hash = '';
    const previous = this.locks.get(networkKey) ?? Promise.resolve();
    let unlock!: () => void; const lock = new Promise<void>(resolve => { unlock = resolve; });
    const pending = previous.then(() => lock); this.locks.set(networkKey, pending);
    await previous;
    let identity: BrowserIdentity | undefined;
    try {
      signal.throwIfAborted(); identity = await this.store.load(networkKey);
      await this.configure(identity);
      const state = { profile_id: identity.profile_id, created_at: identity.created_at, saved_at: identity.saved_at, egress_country: lease.egress_country ?? null };
      this.active.set(networkKey, state);
      const profile = identity;
      let failureKind: 'blocked' | 'network' | null = null;
      const snapshot = async () => {
        const response = await this.fetcher(`${this.base}/v1/profiles/${encodeURIComponent(profile.profile_id)}/snapshot`, { signal: AbortSignal.timeout(5000) }).catch(() => { throw new FingerprintError('gateway'); });
        if (!response.ok) throw new FingerprintError('gateway');
        profile.cookie_state = await response.json() as BrowserIdentity['cookie_state']; profile.saved_at = new Date().toISOString();
        await this.store.save(networkKey, profile); state.saved_at = profile.saved_at;
      };
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init), now = Date.now();
        const timeout = Math.min(30_000, lease.expires_at - now - 1000);
        if (timeout <= 0) throw new FingerprintError('gateway');
        const abort = AbortSignal.any([signal, request.signal, AbortSignal.timeout(timeout)]);
        const headers = Object.fromEntries(request.headers.entries()); delete headers.cookie;
        const metadata = { 'x-fingerprint-url': encode(request.url), 'x-fingerprint-method': request.method, 'x-fingerprint-headers': encode(headers),
          'x-fingerprint-proxy': encode({ url: proxy.toString(), insecure_tls: insecure }), 'x-fingerprint-timeout-ms': String(Math.max(1000, timeout - 1000)), 'x-fingerprint-redirect': request.redirect };
        const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
        let response: Response;
        try { response = await this.fetcher(`${this.base}/v1/fetch/${encodeURIComponent(profile.profile_id)}`, { method: 'POST', headers: metadata, body, signal: abort }); }
        catch { if (signal.aborted) signal.throwIfAborted(); throw new FingerprintError('gateway'); }
        // A restarted sidecar lost its in-memory profiles. Restore the durable identity and retry once.
        if (response.status === 404) {
          await this.configure(profile);
          response = await this.fetcher(`${this.base}/v1/fetch/${encodeURIComponent(profile.profile_id)}`, { method: 'POST', headers: metadata, body, signal: abort }).catch(() => { throw new FingerprintError('gateway'); });
        }
        if (!response.ok) {
          const failure = await response.json().catch(() => ({})) as { failure_kind?: string; curl_code?: number };
          const error = new FingerprintError(failure.failure_kind === 'proxy_transport' ? 'proxy_transport' : failure.failure_kind === 'upstream_transient' ? 'upstream_transient' : 'gateway', failure.curl_code);
          if (error.penalizeProxy && failureKind !== 'blocked') failureKind = 'network';
          throw error;
        }
        const status = Number(response.headers.get('x-fingerprint-response-status'));
        if (!Number.isInteger(status) || status < 200 || status > 599) throw new FingerprintError('gateway');
        const targetHeaders = JSON.parse(Buffer.from(response.headers.get('x-fingerprint-response-headers') ?? '', 'base64url').toString()) as Record<string, string>;
        const bytes = await response.arrayBuffer();
        const rawBody = Buffer.from(bytes).toString(); let challenge = false;
        try { const payload = JSON.parse(rawBody); challenge = /not a bot|unusual traffic|não (?:é|sou) (?:um )?robô|captcha/i.test(String(payload.playabilityStatus?.reason ?? '')); }
        catch { challenge = /id=["']captcha-form|Our systems have detected unusual traffic/i.test(rawBody); }
        if (status === 429 || challenge) failureKind = 'blocked';
        await snapshot();
        return new Response([204, 205, 304].includes(status) || request.method === 'HEAD' ? null : bytes, { status, headers: targetHeaders });
      };
      return await work({ identity, fetch, failureKind: () => failureKind });
    } finally {
      if (identity) {
        this.lastProfile = { profile_id: identity.profile_id, created_at: identity.created_at, saved_at: identity.saved_at };
        await this.fetcher(`${this.base}/v1/profiles/${encodeURIComponent(identity.profile_id)}`, { method: 'DELETE', signal: AbortSignal.timeout(3000) }).catch(() => {});
      }
      this.active.delete(networkKey); unlock(); if (this.locks.get(networkKey) === pending) this.locks.delete(networkKey);
    }
  }
  async diagnostics(enforceBrazil: boolean) {
    const stats = await this.fetcher(`${this.base}/v1/stats`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok ? r.json() : null).catch(() => null) as { requests_last_hour?: number; blocked_last_hour?: number } | null;
    return { gateway: stats ? 'ready' as const : 'unavailable' as const, browser: IDENTITY_POLICY.browser,
      requests_last_hour: stats?.requests_last_hour ?? 0, blocked_last_hour: stats?.blocked_last_hour ?? 0,
      identity_policy: IDENTITY_POLICY.id, language: IDENTITY_POLICY.language, country: IDENTITY_POLICY.country, timezone: IDENTITY_POLICY.timezone,
      enforce_egress_country: enforceBrazil, active_leases: this.active.size,
      compliant_leases: [...this.active.values()].filter(p => p.egress_country === 'BR').length, last_profile: this.lastProfile };
  }
}
