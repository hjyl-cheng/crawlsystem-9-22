import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

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
  const socket = await openTcp(proxy.hostname.replace(/^\[|\]$/g, ''), Number(proxy.port), signal);
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
async function httpConnect(proxy: URL, host: string, port: number, signal: AbortSignal): Promise<Socket> {
  const raw = await openTcp(proxy.hostname.replace(/^\[|\]$/g, ''), Number(proxy.port), signal);
  const socket: Socket = proxy.protocol === 'https:' ? await new Promise<TLSSocket>((resolve, reject) => {
    const tls = tlsConnect({ socket: raw, servername: proxy.hostname }, () => resolve(tls)); tls.once('error', () => reject(new ProxyConnectError('proxy_unreachable', 'Proxy TLS failed')));
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
