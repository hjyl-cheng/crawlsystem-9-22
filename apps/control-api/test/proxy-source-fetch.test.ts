import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchProxySource, isPublicAddress } from '../src/proxy-source-fetch.ts';
import { parseProxyList } from '@crawlsystem/store/proxies';

test('only public addresses may be fetched', () => {
  for (const address of ['8.8.8.8', '185.199.108.133', '2606:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  for (const address of ['10.43.0.1', '127.0.0.1', '169.254.169.254', '172.20.1.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip'])
    assert.equal(isPublicAddress(address), false, address);
});
test('sources resolving to internal addresses, plain HTTP and embedded credentials are refused before any request', async () => {
  const internal = ((_host: string, _options: object, callback: (e: Error | null, a: { address: string; family: number }[]) => void) => callback(null, [{ address: '10.43.0.1', family: 4 }])) as never;
  assert.deepEqual(await fetchProxySource('https://proxies.example.test/list.txt', null, { lookup: internal }), { status: 'error', error: 'Source resolves to a non-public address' });
  const mixed = ((_host: string, _options: object, callback: (e: Error | null, a: { address: string; family: number }[]) => void) => callback(null, [{ address: '203.0.113.9', family: 4 }, { address: '127.0.0.1', family: 4 }])) as never;
  assert.deepEqual(await fetchProxySource('https://proxies.example.test/list.txt', null, { lookup: mixed }), { status: 'error', error: 'Source resolves to a non-public address' });
  assert.equal((await fetchProxySource('http://proxies.example.test/list.txt', null)).status, 'error');
  assert.equal((await fetchProxySource('https://user:pw@proxies.example.test/list.txt', null)).status, 'error');
});
test('list parsing accepts host:port and URLs, applies the source protocol and skips junk', () => {
  const { entries, invalid } = parseProxyList('# comment\n185.179.188.54:1080\r\n\nsocks5://u:p%40ss@203.0.113.5:1080\n185.179.188.54:1080\nnot a proxy\n1.2.3.4:99999\nhttp://198.51.100.1:8080/path', 'socks5');
  assert.deepEqual(entries.map(e => `${e.protocol}://${e.host}:${e.port}`), ['socks5://185.179.188.54:1080', 'socks5://203.0.113.5:1080']);
  assert.deepEqual([entries[1]!.username, entries[1]!.password], ['u', 'p@ss']);
  assert.equal(invalid, 3);
});
test('Clash configs: only credential-free http/socks5 entries of the proxies list, TLS mapped to https', () => {
  const body = [
    '# Clash 配置文件', 'mixed-port: 7890', 'proxies:',
    '- name: "\\U0001F1F3\\U0001F1F1 NL_0005"', '  server: 84.17.47.125', '  port: 9002', '  type: http', '  tls: true', '  skip-cert-verify: true', '  udp: true',
    '- name: with-account', '  server: 84.17.47.126', '  port: 9002', '  type: http', '  password: shared-secret', '  tls: true',
    '- name: ss node', '  server: 198.51.100.9', '  port: 8388', '  type: ss', '  cipher: aes-128-gcm',
    '- name: socks', '  type: socks5', '  server: 203.0.113.7', '  port: "1080"  # quoted port',
    '- name: ws', '  type: http', '  server: 203.0.113.8', '  port: 8080', '  ws-opts:', '    path: /x', '    headers:', '      server: nested.example.test',
    '  - {name: flow, server: 203.0.113.9, port: 443, type: http, tls: true, plugin-opts: {mode: websocket, host: a.b}}',
    '- {name: flow-auth, server: 203.0.113.10, port: 443, type: socks5, username: u, password: "p, q"}',
    '- {name: flow-plain, server: 203.0.113.11, port: 3128, type: http}',
    'proxy-groups:', '- name: auto', '  type: url-test', '  proxies: [a]', '  server: 192.0.2.99', '  port: 1',
  ].join('\n');
  const { entries, invalid, skipped } = parseProxyList(body, 'socks5');
  assert.deepEqual(entries.map(e => `${e.protocol}://${e.host}:${e.port}${e.tls_insecure ? ' insecure' : ''}`),
    ['https://84.17.47.125:9002 insecure', 'socks5://203.0.113.7:1080', 'http://203.0.113.8:8080', 'http://203.0.113.11:3128']);
  assert.ok(entries.every(e => e.username === null && e.password === null));
  assert.equal(skipped, 3, 'credentialed http, ss and credentialed flow socks5');
  assert.equal(invalid, 0);
});
test('Clash flow-style items in a top-level list are read; nested maps never override item keys', () => {
  const { entries } = parseProxyList('proxies:\n  - {name: a, server: 192.0.2.1, port: 443, type: http, tls: true, skip-cert-verify: false}\n  - {name: b, type: socks5, server: 192.0.2.2, port: 1080, ws-opts: {server: 10.0.0.1}}\n', 'http');
  assert.deepEqual(entries.map(e => `${e.protocol}://${e.host}:${e.port}${e.tls_insecure ? ' insecure' : ''}`), ['https://192.0.2.1:443', 'socks5://192.0.2.2:1080']);
  assert.equal(parseProxyList('mixed-port: 7890\nrules:\n- MATCH,DIRECT\n', 'http').entries.length, 0, 'a config without proxies is not read as lines');
  const nulls = parseProxyList('proxies:\n- name: a\n  server: 192.0.2.3\n  port: 443\n  type: http\n  tls: true\n  username: null\n  password: ~\n- {name: b, server: 192.0.2.4, port: 1080, type: socks5, username: "", password: null}\n', 'http');
  assert.deepEqual(nulls.entries.map(e => e.host), ['192.0.2.3', '192.0.2.4'], 'YAML null or empty credentials mean none');
});
