import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTlsServer } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyYoutubePage, connectViaProxy, httpsProxyTls, INSECURE_TLS_FRAGMENT, probeYoutubeContent, ProxyConnectError, proxyPort } from '@crawlsystem/execution-client/proxy-connect';

// Servers are unref'd so lingering tunnels never keep the test process alive.
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => { server.unref(); resolve((server.address() as AddressInfo).port); }));
const echoServer = () => createServer(socket => socket.pipe(socket));
// Minimal SOCKS5 server (RFC 1928/1929) that only tunnels to 127.0.0.1.
function socksServer(user?: string, pass?: string) {
  return createServer(client => {
    client.once('data', greet => {
      const wantsAuth = !!user; client.write(Buffer.from([5, wantsAuth ? 2 : 0]));
      const request = (data: Buffer) => { const len = data[4]!; const port = data.readUInt16BE(5 + len); const upstream = connect(port, '127.0.0.1', () => { client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); client.pipe(upstream).pipe(client); }); upstream.on('error', () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]))); };
      if (!wantsAuth) return void client.once('data', request);
      client.once('data', auth => { const u = auth.subarray(2, 2 + auth[1]!).toString(), p = auth.subarray(3 + auth[1]!, 3 + auth[1]! + auth[2 + auth[1]!]!).toString();
        const ok = u === user && p === pass; client.write(Buffer.from([1, ok ? 0 : 1])); if (ok) client.once('data', request); else client.end(); });
      void greet;
    });
  });
}
function httpProxy(auth?: string) {
  return createServer(client => {
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1'); if (!head.includes('\r\n\r\n')) return;
      client.off('data', onData);
      if (auth && !head.includes(`Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}`)) return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      const port = Number(/^CONNECT [^:]+:(\d+)/.exec(head)?.[1]);
      const upstream = connect(port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection established\r\n\r\n'); client.pipe(upstream).pipe(client); });
    };
    client.on('data', onData);
  });
}
async function roundTrip(socket: Socket) { socket.write('ping'); const [data] = await Promise.race([new Promise<Buffer[]>(r => socket.once('data', d => r([d]))), new Promise<never>((_, j) => setTimeout(() => j(new Error('no echo')), 2000))]); socket.destroy(); return data!.toString(); }

test('tunnels through SOCKS5 with and without credentials, and reports bad credentials', async () => {
  const echo = echoServer(), target = await listen(echo), open = socksServer(), authed = socksServer('alice', 's3cret');
  const [p1, p2] = [await listen(open), await listen(authed)];
  try {
    assert.equal(await roundTrip(await connectViaProxy(`socks5://127.0.0.1:${p1}`, 'localhost', target, AbortSignal.timeout(3000))), 'ping');
    assert.equal(await roundTrip(await connectViaProxy(`socks5://alice:s3cret@127.0.0.1:${p2}`, 'localhost', target, AbortSignal.timeout(3000))), 'ping');
    await assert.rejects(connectViaProxy(`socks5://alice:wrong@127.0.0.1:${p2}`, 'localhost', target, AbortSignal.timeout(3000)), (e: unknown) => e instanceof ProxyConnectError && e.kind === 'proxy_auth');
  } finally { open.close(); authed.close(); echo.close(); }
});
test('tunnels through HTTP CONNECT; 407 is an auth error and an unreachable proxy is classified', async () => {
  const echo = echoServer(), target = await listen(echo), proxy = httpProxy('bob:pw'), port = await listen(proxy);
  try {
    assert.equal(await roundTrip(await connectViaProxy(`http://bob:pw@127.0.0.1:${port}`, 'localhost', target, AbortSignal.timeout(3000))), 'ping');
    await assert.rejects(connectViaProxy(`http://127.0.0.1:${port}`, 'localhost', target, AbortSignal.timeout(3000)), (e: unknown) => e instanceof ProxyConnectError && e.kind === 'proxy_auth');
    await assert.rejects(connectViaProxy('http://127.0.0.1:1', 'localhost', target, AbortSignal.timeout(3000)), (e: unknown) => e instanceof ProxyConnectError && e.kind === 'proxy_unreachable');
  } finally { proxy.close(); echo.close(); }
});
test('a proxy that accepts but never answers is abandoned at the deadline instead of hanging', async () => {
  const silent = createServer(() => { /* accept, never reply */ }), port = await listen(silent);
  try {
    const started = Date.now();
    for (const scheme of ['socks5', 'http']) await assert.rejects(connectViaProxy(`${scheme}://127.0.0.1:${port}`, 'localhost', 9, AbortSignal.timeout(300)), (e: unknown) => e instanceof ProxyConnectError);
    assert.ok(Date.now() - started < 2000);
  } finally { silent.close(); }
});
test('YouTube page classification separates blocks from proxy faults and missing data', () => {
  assert.deepEqual(classifyYoutubePage(200, '', '<script>var ytInitialData = {};</script>'), { ok: true });
  assert.deepEqual(classifyYoutubePage(429, '', ''), { ok: false, error: 'blocked_429', blocked: true });
  assert.deepEqual(classifyYoutubePage(302, 'https://www.google.com/sorry/index?continue=x', ''), { ok: false, error: 'blocked_429', blocked: true });
  assert.deepEqual(classifyYoutubePage(302, 'https://consent.youtube.com/m?continue=x', ''), { ok: false, error: 'consent_redirect', blocked: false });
  assert.deepEqual(classifyYoutubePage(403, '', ''), { ok: false, error: 'http_403', blocked: true });
  assert.deepEqual(classifyYoutubePage(200, '', 'ytInitialData Sign in to confirm you’re not a bot'), { ok: false, error: 'bot_check', blocked: true });
  assert.deepEqual(classifyYoutubePage(200, '', '<html>captive portal</html>'), { ok: false, error: 'no_data', blocked: false });
  assert.deepEqual(classifyYoutubePage(502, '', ''), { ok: false, error: 'http_502', blocked: false });
});
test('content probe loads the page through the proxy and reports blocks and dead proxies', async () => {
  const pages: Record<string, [number, string]> = { '/ok': [200, 'ytInitialData = {"x":1}'], '/bot': [200, "Sign in to confirm you're not a bot"], '/limited': [429, ''] };
  const site = createHttpServer((request, response) => { const [status, body] = pages[request.url!] ?? [404, '']; response.writeHead(status).end(body); });
  const sitePort = await listen(site as unknown as Server), proxyPort = await listen(socksServer());
  const via = (path: string) => probeYoutubeContent(`socks5://127.0.0.1:${proxyPort}`, { url: `http://127.0.0.1:${sitePort}${path}`, timeoutMs: 5000 });
  const ok = await via('/ok');
  assert.equal(ok.ok, true);
  assert.deepEqual(await via('/bot'), { ok: false, error: 'bot_check', blocked: true });
  assert.deepEqual(await via('/limited'), { ok: false, error: 'blocked_429', blocked: true });
  const dead = createServer(); const deadPort = await listen(dead); dead.close();
  assert.deepEqual(await probeYoutubeContent(`socks5://127.0.0.1:${deadPort}`, { url: `http://127.0.0.1:${sitePort}/ok`, timeoutMs: 5000 }), { ok: false, error: 'proxy_unreachable', blocked: false });
});
test('HTTPS proxy certificates are verified unless the URL is marked insecure and carries no credentials', () => {
  assert.deepEqual(httpsProxyTls(new URL('https://198.51.100.7:9002')), { host: '198.51.100.7', rejectUnauthorized: true }, 'no SNI for an IP');
  assert.deepEqual(httpsProxyTls(new URL(`https://198.51.100.7:9002${INSECURE_TLS_FRAGMENT}`)), { host: '198.51.100.7', rejectUnauthorized: false });
  assert.deepEqual(httpsProxyTls(new URL(`https://u:p@198.51.100.7:9002${INSECURE_TLS_FRAGMENT}`)), { host: '198.51.100.7', rejectUnauthorized: true }, 'credentials never cross an unverified hop');
  assert.deepEqual(httpsProxyTls(new URL('https://proxy.example.test:443#other')), { host: 'proxy.example.test', servername: 'proxy.example.test', rejectUnauthorized: true });
});
test('an HTTPS proxy with a self-signed certificate is reachable only through an insecure, credential-free URL', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-tls-'));
  try { execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=proxy.example.test',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' }); }
  catch { rmSync(dir, { recursive: true, force: true }); return t.skip('openssl unavailable'); }
  const proxy = createTlsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, client => {
    client.once('data', head => {
      const port = Number(/^CONNECT [^:]+:(\d+)/.exec(head.toString('latin1'))?.[1]);
      const upstream = connect(port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection established\r\n\r\n'); client.pipe(upstream).pipe(client); });
    });
  });
  rmSync(dir, { recursive: true, force: true });
  const proxyPort = await listen(proxy as unknown as Server), echoPort = await listen(echoServer());
  const through = (url: string) => connectViaProxy(url, '127.0.0.1', echoPort, AbortSignal.timeout(5000));
  await assert.rejects(through(`https://127.0.0.1:${proxyPort}`), (e: unknown) => e instanceof ProxyConnectError && e.kind === 'proxy_unreachable');
  await assert.rejects(through(`https://u:p@127.0.0.1:${proxyPort}${INSECURE_TLS_FRAGMENT}`), (e: unknown) => e instanceof ProxyConnectError);
  const socket = await through(`https://127.0.0.1:${proxyPort}${INSECURE_TLS_FRAGMENT}`);
  const echoed = await new Promise<string>(resolve => { socket.once('data', d => resolve(d.toString())); socket.write('ping'); });
  socket.destroy();
  assert.equal(echoed, 'ping');
});
test('a proxy on its scheme default port keeps that port (URLs drop it)', () => {
  assert.equal(new URL('https://198.51.100.7:443').port, '', 'the WHATWG URL quirk this guards against');
  assert.equal(proxyPort(new URL('https://198.51.100.7:443#insecure-tls')), 443);
  assert.equal(proxyPort(new URL('http://198.51.100.7:80')), 80);
  assert.equal(proxyPort(new URL('socks5://198.51.100.7:1080')), 1080);
  assert.equal(proxyPort(new URL('https://198.51.100.7:9002')), 9002);
});
