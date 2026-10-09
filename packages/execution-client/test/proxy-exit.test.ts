import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProxyExit, parseSwJsData } from '../src/proxy-exit.ts';
import { proxyUrlOf, ProxyConnectError } from '../src/proxy-connect.ts';

// A real sw.js_data body shape (2026-10-09), shortened: [hl, gl, null, ip, …, visitorData, ua, …].
const body = (gl: unknown, ip: unknown) => `)]}'\n${JSON.stringify([['yt.sw.adr', null, [[['en', gl, null, ip, null, null, null, null, null, null, null, '', '', 'Cgt4', 'Mozilla/5.0', 1]]]]])}`;
const transport = (respond: () => Promise<Response>) => () => ({ fetch: (() => respond()) as unknown as typeof fetch, close: async () => undefined });

test('the exit country and IP come from YouTube\'s service-worker data', () => {
  assert.deepEqual(parseSwJsData(body('BR', '200.1.2.3')), { country: 'BR', ip: '200.1.2.3' });
  assert.deepEqual(parseSwJsData(body('US', '2001:db8::1')), { country: 'US', ip: '2001:db8::1' });
  assert.deepEqual(parseSwJsData(body('BR', '<script>')), { country: 'BR', ip: null }, 'an IP is kept only if it looks like one');
  for (const bad of [body('br', '1.1.1.1'), body(null, '1.1.1.1'), ")]}'\nnot json", '[]', '']) assert.equal(parseSwJsData(bad), null);
});

test('a check reports short error codes, never URLs or bodies', async () => {
  assert.deepEqual(await checkProxyExit('https://p:1', 1000, transport(async () => new Response(body('BR', '200.1.2.3')))), { ok: true, country: 'BR', ip: '200.1.2.3' });
  assert.deepEqual(await checkProxyExit('https://p:1', 1000, transport(async () => new Response('nope', { status: 429 }))), { ok: false, error: 'http_429' });
  assert.deepEqual(await checkProxyExit('https://p:1', 1000, transport(async () => new Response('<html>consent</html>'))), { ok: false, error: 'unrecognised_response' });
  assert.deepEqual(await checkProxyExit('https://p:1', 1000, transport(async () => { throw new ProxyConnectError('proxy_unreachable', 'down'); })), { ok: false, error: 'proxy_proxy_unreachable' });
  assert.deepEqual(await checkProxyExit('https://p:1', 1000, transport(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); })), { ok: false, error: 'timeout' });
});

test('proxy URLs carry credentials only when present and mark unverified TLS only without them', () => {
  const base = { protocol: 'https' as const, host: 'p.example', port: 443, username: null, password: null, tls_insecure: false };
  assert.equal(proxyUrlOf(base), 'https://p.example:443');
  assert.equal(proxyUrlOf({ ...base, tls_insecure: true }), 'https://p.example:443#insecure-tls');
  assert.equal(proxyUrlOf({ ...base, tls_insecure: true, username: 'u s', password: 'p@ss' }), 'https://u%20s:p%40ss@p.example:443');
  assert.equal(proxyUrlOf({ ...base, protocol: 'socks5', host: '2001:db8::2', port: 1080 }), 'socks5://[2001:db8::2]:1080');
});
