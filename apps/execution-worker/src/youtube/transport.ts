import { connect as tlsConnect } from 'node:tls';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { connectViaProxy, ProxyConnectError } from '@crawlsystem/execution-client/proxy-connect';

// Every scrape goes through a proxy leased from this node's Proxy Manager and is
// released with its outcome, so the manager's concurrency, cooldown and health apply.
export type Outcome = 'success' | 'failure' | 'blocked' | 'timeout';
export interface ProxyLease { lease_id: string; proxy_url: string; expires_at: number; }
export class ProxyUnavailable extends Error {
  constructor(readonly reason: string, readonly waitMs: number) { super(`No proxy available: ${reason}`); this.name = 'ProxyUnavailable'; }
}
export class LeaseClient {
  constructor(private base: string, private fetcher: typeof fetch = fetch) {}
  async acquire(ttlMs = 180_000): Promise<ProxyLease> {
    let response: Response;
    try { response = await this.fetcher(`${this.base}/v1/lease`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ttl_ms: ttlMs }), signal: AbortSignal.timeout(5000) }); }
    catch { throw new ProxyUnavailable('manager_unreachable', 10_000); }
    const body = await response.json().catch(() => ({})) as { lease_id?: string; proxy_url?: string; expires_at?: number; error?: { reason?: string; wait_ms?: number } };
    if (response.ok && body.lease_id && body.proxy_url && body.expires_at) return { lease_id: body.lease_id, proxy_url: body.proxy_url, expires_at: body.expires_at };
    throw new ProxyUnavailable(body.error?.reason ?? `http_${response.status}`, body.error?.wait_ms ?? 10_000);
  }
  async release(lease: ProxyLease, outcome: Outcome, latencyMs?: number, errorClass?: string): Promise<void> {
    await this.fetcher(`${this.base}/v1/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ lease_id: lease.lease_id, outcome, ...(latencyMs !== undefined ? { latency_ms: Math.round(latencyMs) } : {}), ...(errorClass ? { error_class: errorClass } : {}) }) }).catch(() => {});
  }
}
/** A fetch whose every connection is tunnelled through `proxyUrl` (TLS to the target on top). */
export function proxiedFetch(proxyUrl: string): { fetch: typeof fetch; close: () => Promise<void> } {
  const agent = new Agent({ connections: 4, connectTimeout: 15_000, connect: (options, callback) => {
    const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80);
    connectViaProxy(proxyUrl, options.hostname, port, AbortSignal.timeout(15_000)).then(socket => {
      if (options.protocol !== 'https:') return callback(null, socket);
      const tls = tlsConnect({ socket, servername: options.servername || options.hostname, ALPNProtocols: ['http/1.1'] }, () => callback(null, tls));
      tls.once('error', error => callback(error, null));
    }, (error: ProxyConnectError) => callback(error, null));
  } } as Agent.Options);
  // Callers (youtubei.js) may pass a Request built by Node's own fetch; undici's fetch does not
  // accept another realm's Request, so it is unpacked into URL + init first.
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof input === 'object' && 'url' in input && !(input instanceof URL)) {
      const request = input as Request;
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
      init = { method: request.method, headers: request.headers, body, redirect: request.redirect, signal: request.signal, ...init };
      input = request.url;
    }
    return undiciFetch(input as never, { ...(init as object), dispatcher: agent as Dispatcher } as never);
  }) as unknown as typeof fetch;
  return { fetch: f, close: () => agent.close() };
}
