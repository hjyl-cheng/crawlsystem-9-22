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
