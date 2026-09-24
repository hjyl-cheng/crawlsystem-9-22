import { createServer, type IncomingMessage, type Server } from 'node:http';
import { z } from 'zod';
import type { ProxyPool } from './pool.ts';

// Node-local API for Workers on this server. Reachable only through a Service with
// internalTrafficPolicy: Local and a NetworkPolicy admitting execution-worker Pods.
const Acquire = z.strictObject({ ttl_ms: z.number().int().min(5_000).max(600_000).default(120_000) });
const Release = z.strictObject({ lease_id: z.uuid(), outcome: z.enum(['success', 'failure', 'blocked', 'timeout']),
  latency_ms: z.number().int().nonnegative().max(600_000).optional(), error_class: z.string().max(60).regex(/^[a-z0-9_.-]+$/).optional() });
async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { size += (chunk as Buffer).length; if (size > 4096) throw new Error('too large'); chunks.push(chunk as Buffer); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
export function localServer(pool: ProxyPool): Server {
  return createServer(async (request, response) => {
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      if (request.method === 'GET' && request.url === '/healthz') return send(200, { status: 'ok', ...pool.stats() });
      if (request.method === 'POST' && request.url === '/v1/lease') {
        const { ttl_ms } = Acquire.parse(await body(request));
        const lease = pool.acquire(ttl_ms);
        return 'lease_id' in lease ? send(200, lease) : send(503, { error: { code: 'UNAVAILABLE', reason: lease.reason, wait_ms: lease.wait_ms } });
      }
      if (request.method === 'POST' && request.url === '/v1/release') {
        const input = Release.parse(await body(request));
        return send(pool.release(input.lease_id, input.outcome, input.latency_ms, input.error_class) ? 200 : 404, { released: true });
      }
      send(404, { error: { code: 'NOT_FOUND' } });
    } catch { send(400, { error: { code: 'INVALID_REQUEST' } }); }
  });
}
