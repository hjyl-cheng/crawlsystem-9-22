import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import type { SourceFetchResult } from '@crawlsystem/store/proxies';

// Proxy source URLs are operator-supplied, and the fetch runs inside the cluster, so it
// must not become a way to reach internal services: HTTPS only, no redirects, and every
// resolved address must be public (checked at connect time, so DNS rebinding cannot swap it).
const blocked = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) blocked.addSubnet(net, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  const mapped = family === 6 ? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] : undefined;
  if (mapped) return isPublicAddress(mapped);
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
type Lookup = typeof dnsLookup;
export interface FetchOptions { maxBytes?: number; timeoutMs?: number; lookup?: Lookup; }
export async function fetchProxySource(raw: string, etag: string | null, options: FetchOptions = {}): Promise<SourceFetchResult> {
  const url = new URL(raw), maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  if (url.protocol !== 'https:' || url.username || url.password) return { status: 'error', error: 'Source must be an HTTPS URL without credentials' };
  const resolve = options.lookup ?? dnsLookup;
  const guardedLookup = ((hostname: string, lookupOptions: object, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      const list = addresses as LookupAddress[];
      if (!list.length || list.some(a => !isPublicAddress(a.address))) return callback(new Error('Source resolves to a non-public address'), '');
      const all = (lookupOptions as { all?: boolean }).all;
      return all ? callback(null, list) : callback(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as Lookup;
  return new Promise(resolvePromise => {
    const done = (result: SourceFetchResult) => resolvePromise(result);
    const call = request(url, { method: 'GET', lookup: guardedLookup, timeout: options.timeoutMs ?? 20_000,
      headers: { 'user-agent': 'crawlsystem-proxy-source/1', accept: 'text/plain, */*', ...(etag ? { 'if-none-match': etag } : {}) } }, response => {
      const status = response.statusCode ?? 0;
      if (status === 304) { response.resume(); return done({ status: 'not_modified' }); }
      if (status !== 200) { response.resume(); return done({ status: 'error', error: `HTTP ${status}${status >= 300 && status < 400 ? ' (redirects are not followed)' : ''}` }); }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { call.destroy(); done({ status: 'error', error: `Source larger than ${maxBytes} bytes` }); } else chunks.push(chunk);
      });
      response.on('end', () => { if (size <= maxBytes) done({ status: 'ok', body: Buffer.concat(chunks).toString('utf8'), etag: typeof response.headers.etag === 'string' ? response.headers.etag : null }); });
      response.on('error', () => done({ status: 'error', error: 'Source response interrupted' }));
    });
    call.on('timeout', () => { call.destroy(); done({ status: 'error', error: 'Source fetch timed out' }); });
    call.on('error', error => done({ status: 'error', error: /non-public/.test(error.message) ? error.message : 'Source unreachable' }));
    call.end();
  });
}
