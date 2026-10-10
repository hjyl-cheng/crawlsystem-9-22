// The proxied fetch lives with the tunnel code so the Proxy Manager's content probe uses the same path.
export { proxiedFetch } from '@crawlsystem/execution-client/proxy-connect';

// Every scrape goes through a proxy leased from this node's Proxy Manager and is
// released with its outcome, so the manager's concurrency, cooldown and health apply.
export type Outcome = 'success' | 'failure' | 'blocked' | 'timeout';
export interface ProxyLease { lease_id: string; proxy_id?: string; generation?: number; proxy_url: string; expires_at: number; egress_country?: string | null; }
export class ProxyUnavailable extends Error {
  constructor(readonly reason: string, readonly waitMs: number) { super(`No proxy available: ${reason}`); this.name = 'ProxyUnavailable'; }
}
export class LeaseClient {
  constructor(private base: string, private fetcher: typeof fetch = fetch) {}
  async acquire(ttlMs = 180_000, requiredCountry?: string): Promise<ProxyLease> {
    let response: Response;
    try { response = await this.fetcher(`${this.base}/v1/lease`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ttl_ms: ttlMs, ...(requiredCountry ? { required_egress_country: requiredCountry } : {}) }), signal: AbortSignal.timeout(5000) }); }
    catch { throw new ProxyUnavailable('manager_unreachable', 10_000); }
    const body = await response.json().catch(() => ({})) as { lease_id?: string; proxy_url?: string; expires_at?: number; error?: { reason?: string; wait_ms?: number } };
    if (response.ok && body.lease_id && body.proxy_url && body.expires_at) return body as ProxyLease;
    throw new ProxyUnavailable(body.error?.reason ?? `http_${response.status}`, body.error?.wait_ms ?? 10_000);
  }
  async release(lease: ProxyLease, outcome: Outcome, latencyMs?: number, errorClass?: string): Promise<void> {
    await this.fetcher(`${this.base}/v1/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ lease_id: lease.lease_id, outcome, ...(latencyMs !== undefined ? { latency_ms: Math.round(latencyMs) } : {}), ...(errorClass ? { error_class: errorClass } : {}) }) }).catch(() => {});
  }
}
