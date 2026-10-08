import { connect as tcpConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

// Tunnel a TCP connection to host:port through an HTTP(S) CONNECT or SOCKS5 proxy.
// Shared by the Proxy Manager's health checks and the collector's HTTP client, so
// both judge a proxy by the same connection path. No third-party proxy agent.
export class ProxyConnectError extends Error {
  constructor(readonly kind: 'proxy_unreachable' | 'proxy_auth' | 'proxy_refused' | 'timeout' | 'protocol', message: string) { super(message); this.name = 'ProxyConnectError'; }
}
function reader(socket: Socket) {
  let buffer = Buffer.alloc(0); let waiting: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | undefined;
  const pump = () => { if (waiting && buffer.length >= waiting.n) { const out = buffer.subarray(0, waiting.n); buffer = buffer.subarray(waiting.n); const w = waiting; waiting = undefined; w.resolve(out); } };
  const onData = (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); pump(); };
  // A handshake can end by FIN, by error or by our own timeout destroy; all must settle the pending read.
  let closed: Error | undefined;
  const onEnd = (error?: Error) => { closed = error instanceof ProxyConnectError ? error : new ProxyConnectError('protocol', 'Proxy closed the connection'); waiting?.reject(closed); waiting = undefined; };
  const onError = (error: Error) => onEnd(error);
  const onClose = () => onEnd();
  socket.on('data', onData); socket.once('end', onEnd); socket.once('error', onError); socket.once('close', onClose);
  return { read: (n: number) => new Promise<Buffer>((resolve, reject) => { if (closed) return reject(closed); waiting = { n, resolve, reject }; pump(); }),
    done: () => { socket.off('data', onData); socket.off('end', onEnd); socket.off('error', onError); socket.off('close', onClose); if (buffer.length) socket.unshift(buffer); } };
}
/** The proxy's port; WHATWG URLs drop a scheme's default (https:443, http:80), which must not become 0. */
export function proxyPort(proxy: URL): number {
  return Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : proxy.protocol === 'http:' ? 80 : 1080);
}
function openTcp(host: string, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port });
    const abort = () => { socket.destroy(); reject(new ProxyConnectError('timeout', 'Proxy connect timed out')); };
    signal.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => { signal.removeEventListener('abort', abort); resolve(socket); });
    socket.once('error', () => { signal.removeEventListener('abort', abort); reject(new ProxyConnectError('proxy_unreachable', 'Proxy unreachable')); });
  });
}
async function socks5(proxy: URL, host: string, port: number, signal: AbortSignal): Promise<Socket> {
  const socket = await openTcp(proxy.hostname.replace(/^\[|\]$/g, ''), proxyPort(proxy), signal);
  const abort = () => socket.destroy(new ProxyConnectError('timeout', 'SOCKS5 handshake timed out'));
  signal.addEventListener('abort', abort, { once: true });
  const r = reader(socket);
  try {
    const user = decodeURIComponent(proxy.username), pass = decodeURIComponent(proxy.password);
    socket.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]));
    const [version, method] = await r.read(2);
    if (version !== 5) throw new ProxyConnectError('protocol', 'Not a SOCKS5 proxy');
    if (method === 2) {
      const u = Buffer.from(user), p = Buffer.from(pass);
      if (u.length > 255 || p.length > 255) throw new ProxyConnectError('proxy_auth', 'SOCKS5 credentials too long');
      socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      if ((await r.read(2))[1] !== 0) throw new ProxyConnectError('proxy_auth', 'SOCKS5 authentication rejected');
    } else if (method !== 0) throw new ProxyConnectError('proxy_auth', 'SOCKS5 requires an unsupported authentication method');
    const name = Buffer.from(host);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
    const [, reply, , type] = await r.read(4);
    if (reply !== 0) throw new ProxyConnectError('proxy_refused', `SOCKS5 connect refused (${reply})`);
    await r.read(type === 1 ? 6 : type === 4 ? 18 : (await r.read(1))[0]! + 2);
    return socket;
  } catch (error) { socket.destroy(); throw error instanceof ProxyConnectError ? error : new ProxyConnectError('protocol', 'SOCKS5 handshake failed'); }
  finally { r.done(); signal.removeEventListener('abort', abort); }
}
/** Marks an HTTPS proxy URL whose own certificate is not verified (see httpsProxyTls). */
export const INSECURE_TLS_FRAGMENT = '#insecure-tls';
/**
 * TLS options for the hop to an HTTPS proxy. Its certificate is verified unless the URL carries
 * INSECURE_TLS_FRAGMENT and no credentials, so nothing secret crosses an unverified hop; the
 * TLS to the target inside the tunnel is verified either way. IP hosts get no SNI.
 */
export function httpsProxyTls(proxy: URL): { host: string; servername?: string; rejectUnauthorized: boolean } {
  const host = proxy.hostname.replace(/^\[|\]$/g, '');
  const insecure = proxy.hash === INSECURE_TLS_FRAGMENT && !proxy.username && !proxy.password;
  // `host` is what the certificate is checked against; SNI may only carry a name, never an IP.
  return { host, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: !insecure };
}
async function httpConnect(proxy: URL, host: string, port: number, signal: AbortSignal): Promise<Socket> {
  const raw = await openTcp(proxy.hostname.replace(/^\[|\]$/g, ''), proxyPort(proxy), signal);
  const socket: Socket = proxy.protocol === 'https:' ? await new Promise<TLSSocket>((resolve, reject) => {
    const tls = tlsConnect({ socket: raw, ...httpsProxyTls(proxy) }, () => resolve(tls)); tls.once('error', () => reject(new ProxyConnectError('proxy_unreachable', 'Proxy TLS failed')));
  }) : raw;
  const abort = () => socket.destroy(new ProxyConnectError('timeout', 'CONNECT timed out'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n` : '';
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    const head = await new Promise<Buffer>((resolve, reject) => {
      let data = Buffer.alloc(0);
      const onData = (chunk: Buffer) => { data = Buffer.concat([data, chunk]); const end = data.indexOf('\r\n\r\n'); if (end >= 0) { socket.off('data', onData); if (data.length > end + 4) socket.unshift(data.subarray(end + 4)); resolve(data.subarray(0, end)); } else if (data.length > 16384) reject(new ProxyConnectError('protocol', 'Oversized CONNECT response')); };
      const fail = (error?: Error) => reject(error instanceof ProxyConnectError ? error : new ProxyConnectError('protocol', 'Proxy closed during CONNECT'));
      socket.on('data', onData); socket.once('end', () => fail()); socket.once('error', fail); socket.once('close', () => fail());
    });
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'))?.[1]);
    if (status === 407) throw new ProxyConnectError('proxy_auth', 'Proxy authentication required');
    if (status !== 200) throw new ProxyConnectError('proxy_refused', `CONNECT refused (${status || 'invalid response'})`);
    return socket;
  } catch (error) { socket.destroy(); throw error instanceof ProxyConnectError ? error : new ProxyConnectError('protocol', 'CONNECT failed'); }
  finally { signal.removeEventListener('abort', abort); }
}
/** Returns a TCP socket to host:port tunnelled through the proxy (plain TCP; wrap with TLS as needed). */
export function connectViaProxy(proxyUrl: string, host: string, port: number, signal: AbortSignal): Promise<Socket> {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol === 'socks5:') return socks5(proxy, host, port, signal);
  if (proxy.protocol === 'http:' || proxy.protocol === 'https:') return httpConnect(proxy, host, port, signal);
  return Promise.reject(new ProxyConnectError('protocol', 'Unsupported proxy protocol'));
}
/** Health check: TLS to host through the proxy and expect HTTP 204 from /generate_204. */
export async function probeProxy(proxyUrl: string, { host = 'www.youtube.com', path = '/generate_204', timeoutMs = 10_000 } = {}): Promise<{ ok: true; latency_ms: number } | { ok: false; error: string }> {
  const started = Date.now(), signal = AbortSignal.timeout(timeoutMs);
  let socket: Socket | undefined;
  try {
    socket = await connectViaProxy(proxyUrl, host, 443, signal);
    const tls = await new Promise<TLSSocket>((resolve, reject) => { const s = tlsConnect({ socket, servername: host }, () => resolve(s)); s.once('error', () => reject(new ProxyConnectError('protocol', 'TLS to target failed'))); s.once('close', () => reject(new ProxyConnectError('timeout', 'TLS to target timed out'))); signal.addEventListener('abort', () => s.destroy(), { once: true }); });
    tls.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`);
    const status = await new Promise<number>((resolve, reject) => {
      let data = '';
      tls.on('data', chunk => { data += chunk.toString('latin1'); const m = /^HTTP\/1\.[01] (\d{3})/.exec(data); if (m) resolve(Number(m[1])); });
      tls.once('end', () => reject(new ProxyConnectError('protocol', 'Target closed before responding')));
      tls.once('close', () => reject(new ProxyConnectError('timeout', 'Target response timed out')));
    });
    tls.destroy();
    return status === 204 ? { ok: true, latency_ms: Date.now() - started } : { ok: false, error: status === 429 ? 'blocked_429' : `http_${status}` };
  } catch (error) {
    socket?.destroy();
    return { ok: false, error: error instanceof ProxyConnectError ? error.kind : 'probe_error' };
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

// Content probe: a connectable proxy is not necessarily one YouTube serves data to. The probe
// loads a public channel page through the same proxied fetch the collector uses and accepts it
// only if the page carries channel data and no bot check or rate-limit interstitial.
export type ContentProbeResult = { ok: true; latency_ms: number } | { ok: false; error: string; blocked: boolean };
const PROBE_URL = 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw/about';
const PROBE_HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9', cookie: 'SOCS=CAI' }; // SOCS skips the EU consent interstitial, which is not a block
/** Classify a YouTube page response; `blocked` marks YouTube refusing this egress (bot check, rate limit), not a proxy fault. */
export function classifyYoutubePage(status: number, location: string, body: string): { ok: true } | { ok: false; error: string; blocked: boolean } {
  if (status === 429 || /google\.[a-z.]+\/sorry/i.test(location)) return { ok: false, error: 'blocked_429', blocked: true };
  if (status >= 300 && status < 400) return { ok: false, error: /consent\./i.test(location) ? 'consent_redirect' : `redirect_${status}`, blocked: false };
  if (status === 403) return { ok: false, error: 'http_403', blocked: true };
  if (status !== 200) return { ok: false, error: `http_${status}`, blocked: false };
  if (/confirm you(?:'|’|&#39;|\\u0027)re not a bot|unusual traffic from your computer/i.test(body)) return { ok: false, error: 'bot_check', blocked: true };
  if (!body.includes('ytInitialData')) return { ok: false, error: 'no_data', blocked: false };
  return { ok: true };
}
export async function probeYoutubeContent(proxyUrl: string, { url = PROBE_URL, timeoutMs = 20_000 } = {}): Promise<ContentProbeResult> {
  const started = Date.now(), transport = proxiedFetch(proxyUrl);
  try {
    const response = await transport.fetch(url, { headers: PROBE_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const body = response.status === 200 ? await response.text() : (await response.body?.cancel(), '');
    const verdict = classifyYoutubePage(response.status, response.headers.get('location') ?? '', body);
    return verdict.ok ? { ok: true, latency_ms: Date.now() - started } : verdict;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof ProxyConnectError) return { ok: false, error: cause.kind, blocked: false };
    const name = (error as Error).name;
    return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'probe_error', blocked: false };
  } finally { await transport.close().catch(() => {}); }
}
