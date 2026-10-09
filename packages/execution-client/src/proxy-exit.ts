import type { ProxyExitResult } from '@crawlsystem/contracts';
import { proxiedFetch } from './proxy-connect.ts';

/**
 * The exit of a proxy as YouTube sees it (plan R2): YouTube's service-worker data names the
 * country it detected for the request and the client IP. The request is ~3 KB and carries no
 * session; a desktop browser user agent keeps YouTube from labelling the client a crawler.
 */
export const EXIT_CHECK_URL = 'https://www.youtube.com/sw.js_data';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';


/** Country (ISO 3166-1 alpha-2) and IP from a sw.js_data body (`)]}'` prefix, then nested arrays). */
export function parseSwJsData(text: string): { country: string; ip: string | null } | null {
  const body = text.startsWith(")]}'") ? text.slice(text.indexOf('\n') + 1) : text;
  let row: unknown;
  try { row = (JSON.parse(body) as unknown[][][][][])[0]?.[2]?.[0]?.[0]; } catch { return null; }
  if (!Array.isArray(row)) return null;
  const country = row[1], ip = row[3];
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) return null;
  return { country, ip: typeof ip === 'string' && ip.length <= 64 && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null };
}

/** Check one proxy (a proxiedFetch URL). Errors are short codes, never proxy URLs or response bodies. */
export async function checkProxyExit(proxyUrl: string, timeoutMs = 10_000, open = proxiedFetch): Promise<ProxyExitResult> {
  const transport = open(proxyUrl);
  try {
    const response = await transport.fetch(EXIT_CHECK_URL, { headers: { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const parsed = parseSwJsData((await response.text()).slice(0, 65_536));
    return parsed ? { ok: true, ...parsed } : { ok: false, error: 'unrecognised_response' };
  } catch (error) {
    const kind = (error as { kind?: string }).kind, name = (error as Error).name;
    return { ok: false, error: kind ? `proxy_${kind}` : name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
  } finally { await transport.close().catch(() => undefined); }
}
