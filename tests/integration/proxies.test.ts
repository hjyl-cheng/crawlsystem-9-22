import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { ProxyStore } from '@crawlsystem/store/proxies';
import { CredentialBox } from '@crawlsystem/store/credentials';
import type { Principal } from '@crawlsystem/contracts';
import { prepareDatabase } from './database-ready.ts';

const pool = createPool(), box = new CredentialBox(randomBytes(32)), store = new ProxyStore(pool, box);
before(async () => { await prepareDatabase(pool); });
after(async () => { await pool.end(); });
function people() {
  const workspace_id = `test-proxy-${randomUUID()}`;
  const as = (role: Principal['role'], server_id?: string) => ({ workspace_id, subject: `${role}-x`, role, ...(server_id ? { server_id } : {}) }) as Principal;
  return { operator: as('operator'), reader: as('reader'), worker: as('worker', 'a1'), nodeA: as('node', 'a1'), nodeB: as('node', 'a2') };
}
const entry = (host: string, extra: Record<string, unknown> = {}) => ({ protocol: 'http', host, port: 8080, username: 'user', password: 'secret-pass-1', provider: 'Vendor A', group: 'US Residential', country_code: 'US', ...extra });
const rejects = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, (e: unknown) => e instanceof StoreError && e.code === code);
const report = (seq: number, observations: object[], boot = 'boot-0000-a') => ({ node_boot_id: boot, report_sequence: seq, observed_at: new Date().toISOString(), observations });
const observation = (proxy_id: string, generation: number, requests: number, failures = 0, state = 'healthy') => ({ proxy_id, generation, state, cooldown_until: null,
  last_success_at: new Date().toISOString(), last_failure_at: null, last_error: null, requests_total: requests, failures_total: failures, latency_ms: 320 });

test('import is operator-only, upserts by endpoint and never returns credentials', async () => {
  const p = people();
  await rejects(() => store.importProxies(p.reader, { entries: [entry('198.51.100.1')] }), 'FORBIDDEN');
  await rejects(() => store.importProxies(p.operator, { entries: [entry('198.51.100.1'), entry('198.51.100.1')] }), 'INVALID_REQUEST');
  assert.deepEqual(await store.importProxies(p.operator, { entries: [entry('198.51.100.1'), entry('198.51.100.2', { username: null, password: null })] }), { created: 2, updated: 0 });
  assert.deepEqual(await store.importProxies(p.operator, { entries: [entry('198.51.100.1', { group: 'Moved', password: null })] }), { created: 0, updated: 1 });
  const overview = await store.overview(p.reader);
  assert.equal(overview.items.length, 2); assert.equal(overview.by_state.unassigned, 2);
  const first = overview.items.find(i => i.host === '198.51.100.1')!;
  assert.equal(first.group, 'Moved'); assert.equal(first.has_password, true, 'omitted password keeps the stored one');
  assert.doesNotMatch(JSON.stringify(overview), /secret-pass|v1\./);
  const stored = (await pool.query('SELECT credential FROM m1.proxies WHERE workspace_id=$1 AND proxy_id=$2', [p.operator.workspace_id, first.proxy_id])).rows[0].credential as string;
  assert.doesNotMatch(stored, /secret-pass/);
  assert.throws(() => box.open(stored, `proxy:${p.operator.workspace_id}:${randomUUID()}`), 'the ciphertext is bound to its own row');
  await rejects(() => new ProxyStore(pool).importProxies(p.operator, { entries: [entry('198.51.100.3')] }), 'DEPENDENCY_NOT_IMPLEMENTED');
});
test('a node receives only its own enabled assignments, with credentials and a renewed lease', async () => {
  const p = people();
  await store.importProxies(p.operator, { entries: [entry('203.0.113.1'), entry('203.0.113.2'), entry('203.0.113.3')] });
  const [x, y, z] = (await store.overview(p.operator)).items;
  await store.update(p.operator, x!.proxy_id, { expected_version: x!.version, server_id: 'a1' });
  await store.update(p.operator, y!.proxy_id, { expected_version: y!.version, server_id: 'a2' });
  const zAssigned = await store.update(p.operator, z!.proxy_id, { expected_version: z!.version, server_id: 'a1' });
  await store.update(p.operator, z!.proxy_id, { expected_version: zAssigned.version, enabled: false });
  await rejects(() => store.update(p.operator, x!.proxy_id, { expected_version: x!.version, enabled: false }), 'CONFLICT');
  await rejects(() => store.sync(p.worker, report(1, [])), 'FORBIDDEN');
  await rejects(() => store.sync({ ...p.nodeA, server_id: undefined }, report(1, [])), 'FORBIDDEN');
  const synced = await store.sync(p.nodeA, report(1, []));
  assert.equal(synced.server_id, 'a1');
  assert.deepEqual(synced.assignments.map(a => a.host), ['203.0.113.1'], 'other servers and disabled proxies are withheld');
  assert.equal(synced.assignments[0]!.password, 'secret-pass-1'); assert.equal(synced.assignments[0]!.generation, 1);
  assert.ok(Date.parse(synced.lease_expires_at) > Date.now() + 200_000);
  const states = Object.fromEntries((await store.overview(p.reader)).items.map(i => [i.host, i.state]));
  assert.deepEqual(states, { '203.0.113.1': 'unknown', '203.0.113.2': 'unknown', '203.0.113.3': 'disabled' });
});
test('reports update state; counters count deltas once and restart with a new boot or assignment', async () => {
  const p = people();
  await store.importProxies(p.operator, { entries: [entry('192.0.2.10')] });
  const proxy = (await store.overview(p.operator)).items[0]!;
  const assigned = await store.update(p.operator, proxy.proxy_id, { expected_version: proxy.version, server_id: 'a1' });
  await store.sync(p.nodeA, report(1, [observation(proxy.proxy_id, 1, 10, 1)]));
  await store.sync(p.nodeA, report(1, [observation(proxy.proxy_id, 1, 10, 1)]));   // duplicate delivery
  await store.sync(p.nodeA, report(2, [observation(proxy.proxy_id, 1, 25, 2)]));
  await store.sync(p.nodeA, report(3, [observation(proxy.proxy_id, 1, 4, 0)], 'boot-0000-b')); // restarted node
  let view = (await store.overview(p.reader)).items[0]!;
  assert.equal(view.state, 'healthy'); assert.equal(view.latency_ms, 320);
  assert.equal(view.requests_today, 29); assert.equal(view.failures_today, 2);
  // Reassigned elsewhere: the old server's reports (old generation) are ignored and the state is unknown until the new server reports.
  await store.update(p.operator, proxy.proxy_id, { expected_version: assigned.version, server_id: 'a2' });
  await store.sync(p.nodeA, report(4, [observation(proxy.proxy_id, 1, 100, 0, 'failed')], 'boot-0000-b'));
  view = (await store.overview(p.reader)).items[0]!;
  assert.equal(view.state, 'unknown'); assert.equal(view.requests_today, 29);
  const toB = await store.sync(p.nodeB, report(1, [observation(proxy.proxy_id, 2, 3, 3, 'cooldown')], 'boot-0000-c'));
  assert.equal(toB.assignments[0]!.generation, 2);
  view = (await store.overview(p.reader)).items[0]!;
  assert.equal(view.state, 'cooldown'); assert.equal(view.requests_today, 32); assert.equal(view.failures_today, 5);
  const overview = await store.overview(p.reader);
  assert.equal(overview.availability_7d.at(-1)!.requests, 32); assert.equal(overview.providers[0]!.requests_today, 32);
});
test('a subscription source adds, spreads, retires after N misses, restores, and never re-enables operator decisions', async () => {
  const p = people();
  const source = await store.createSource(p.operator, { name: 'free socks', url: `https://lists.example.test/${randomUUID()}.txt`, protocol: 'socks5', provider: 'Public', group: 'Public SOCKS5', retire_after_misses: 2, server_ids: ['a1', 'a2'] });
  await rejects(() => store.createSource(p.operator, { name: 'dup', url: source.url, protocol: 'socks5', provider: 'P', group: 'G' }), 'CONFLICT');
  await rejects(() => store.createSource(p.reader, { name: 'x', url: `https://lists.example.test/${randomUUID()}`, protocol: 'socks5', provider: 'P', group: 'G' }), 'FORBIDDEN');
  const claimOurs = () => store.claimDueSource(120, p.operator.workspace_id);
  const refresh = async (body: string) => { await pool.query('UPDATE m1.proxy_sources SET next_fetch_at=clock_timestamp() WHERE source_id=$1', [source.source_id]); const c = await claimOurs(); assert.ok(c); return store.applySourceFetch(c, { status: 'ok', body, etag: '"v"' }); };
  assert.deepEqual(await refresh('192.0.2.1:1080\n192.0.2.2:1080\n192.0.2.3:1080\n192.0.2.4:1080'), { added: 4, retired: 0, restored: 0, assigned: 4, count: 4 });
  let items = (await store.overview(p.reader)).items;
  assert.deepEqual(items.map(i => i.server_id).sort(), ['a1', 'a1', 'a2', 'a2'], 'spread evenly');
  assert.ok(items.every(i => i.source === 'free socks' && i.protocol === 'socks5' && i.group === 'Public SOCKS5'));
  // Operator disables .4 by hand; the source must not undo that.
  const four = items.find(i => i.host === '192.0.2.4')!;
  await store.update(p.operator, four.proxy_id, { expected_version: four.version, enabled: false });
  assert.deepEqual(await refresh('192.0.2.1:1080\n192.0.2.4:1080'), { added: 0, retired: 0, restored: 0, assigned: 0, count: 2 }, 'first miss only counts');
  assert.deepEqual(await refresh('192.0.2.1:1080\n192.0.2.4:1080'), { added: 0, retired: 2, restored: 0, assigned: 0, count: 2 });
  items = (await store.overview(p.reader)).items;
  const byHost = Object.fromEntries(items.map(i => [i.host, i]));
  assert.equal(byHost['192.0.2.2']!.retired, true); assert.equal(byHost['192.0.2.2']!.state, 'disabled'); assert.equal(byHost['192.0.2.2']!.server_id, null);
  assert.equal(byHost['192.0.2.4']!.enabled, false); assert.equal(byHost['192.0.2.4']!.retired, false);
  assert.deepEqual(await refresh('192.0.2.1:1080\n192.0.2.2:1080\n192.0.2.4:1080'), { added: 0, retired: 0, restored: 1, assigned: 1, count: 3 });
  items = (await store.overview(p.reader)).items;
  assert.equal(items.find(i => i.host === '192.0.2.2')!.enabled, true); assert.equal(items.find(i => i.host === '192.0.2.4')!.enabled, false, 'operator disable persists');
  const views = await store.listSources(p.reader);
  assert.equal(views[0]!.last_status, 'ok'); assert.equal(views[0]!.last_count, 3); assert.equal(views[0]!.active_proxies, 3); assert.equal(views[0]!.retired_proxies, 1);
  // A failing fetch keeps the inventory and retries within 10 minutes.
  await pool.query('UPDATE m1.proxy_sources SET next_fetch_at=clock_timestamp() WHERE source_id=$1', [source.source_id]);
  const c = await claimOurs(); assert.ok(c);
  assert.equal(await store.claimDueSource(120, p.operator.workspace_id), null, 'a leased source is not claimed twice');
  await store.applySourceFetch(c, { status: 'error', error: 'HTTP 503' });
  const failed = (await store.listSources(p.reader))[0]!;
  assert.equal(failed.last_status, 'error'); assert.equal(failed.active_proxies, 3);
  assert.ok(Date.parse(failed.next_fetch_at) <= Date.now() + 10 * 60_000 + 5000);
  // Test sources share the preview database: leave them disabled so nothing ever fetches them.
  await store.updateSource(p.operator, source.source_id, { expected_version: failed.version, enabled: false });
});
test('a proxy its server reports failed is retired as unhealthy and withheld at once; enabling clears it', async () => {
  const p = people();
  await store.importProxies(p.operator, { entries: [entry('198.51.100.40'), entry('198.51.100.41')] });
  const [x, y] = (await store.overview(p.operator)).items;
  await store.update(p.operator, x!.proxy_id, { expected_version: x!.version, server_id: 'a1' });
  await store.update(p.operator, y!.proxy_id, { expected_version: y!.version, server_id: 'a1' });
  const synced = await store.sync(p.nodeA, report(1, [observation(x!.proxy_id, 1, 5, 5, 'failed'), observation(y!.proxy_id, 1, 0, 0, 'trial')]));
  assert.deepEqual(synced.assignments.map(a => a.host), ['198.51.100.41']);
  const overview = await store.overview(p.reader);
  const byHost = Object.fromEntries(overview.items.map(i => [i.host, i]));
  const retired = byHost['198.51.100.40']!;
  assert.equal(retired.retired, true); assert.equal(retired.retire_reason, 'unhealthy'); assert.equal(retired.server_id, null); assert.equal(retired.state, 'disabled');
  assert.equal(byHost['198.51.100.41']!.state, 'trial'); assert.equal(byHost['198.51.100.41']!.retire_reason, null); assert.equal(overview.by_state.trial, 1);
  // A late report of the old generation neither revives nor double-counts it.
  await store.sync(p.nodeA, report(2, [observation(x!.proxy_id, 1, 9, 9, 'healthy')]));
  assert.equal((await store.overview(p.reader)).items.find(i => i.host === '198.51.100.40')!.retired, true);
  const back = await store.update(p.operator, x!.proxy_id, { expected_version: retired.version, enabled: true });
  assert.equal(back.retired, false); assert.equal(back.retire_reason, null); assert.equal(back.enabled, true);
});
test('a subscription offers an unhealthy endpoint again only after the quarantine; missing ones carry their own reason', async () => {
  const p = people();
  const source = await store.createSource(p.operator, { name: 'free http', url: `https://lists.example.test/${randomUUID()}.txt`, protocol: 'http', provider: 'Public', group: 'Public HTTP', retire_after_misses: 2, server_ids: ['a1'] });
  const refresh = async (body: string) => { await pool.query('UPDATE m1.proxy_sources SET next_fetch_at=clock_timestamp() WHERE source_id=$1', [source.source_id]); const c = await store.claimDueSource(120, p.operator.workspace_id); assert.ok(c); return store.applySourceFetch(c, { status: 'ok', body }); };
  const list = '192.0.2.50:8080\n192.0.2.51:8080';
  await refresh(list);
  const bad = (await store.overview(p.reader)).items.find(i => i.host === '192.0.2.50')!;
  await store.sync(p.nodeA, report(1, [observation(bad.proxy_id, 1, 9, 9, 'failed')]));
  assert.deepEqual(await refresh(list), { added: 0, retired: 0, restored: 0, assigned: 0, count: 2 }, 'still listed, but in quarantine');
  await pool.query(`UPDATE m1.proxies SET retired_at=clock_timestamp()-interval '25 hours' WHERE workspace_id=$1 AND proxy_id=$2`, [p.operator.workspace_id, bad.proxy_id]);
  assert.deepEqual(await refresh(list), { added: 0, retired: 0, restored: 1, assigned: 1, count: 2 });
  const again = (await store.overview(p.reader)).items.find(i => i.host === '192.0.2.50')!;
  assert.equal(again.retired, false); assert.equal(again.server_id, 'a1'); assert.equal(again.state, 'unknown', 'a new generation: its server starts a new trial');
  await refresh('192.0.2.50:8080');
  assert.equal((await refresh('192.0.2.50:8080')).retired, 1);
  assert.equal((await store.overview(p.reader)).items.find(i => i.host === '192.0.2.51')!.retire_reason, 'source_missing');
  const view = (await store.listSources(p.reader))[0]!;
  await store.updateSource(p.operator, source.source_id, { expected_version: view.version, enabled: false });
});
test('a server holds at most 500 enabled proxies, so a sync always fits the contract', async () => {
  const p = people();
  await store.importProxies(p.operator, { entries: Array.from({ length: 500 }, (_, i) => entry(`10.77.${i >> 8}.${i & 255}`)) });
  await pool.query(`UPDATE m1.proxies SET server_id='a1', generation=1 WHERE workspace_id=$1`, [p.operator.workspace_id]);
  await store.importProxies(p.operator, { entries: [entry('10.78.0.1')] });
  const extra = (await store.overview(p.reader)).items.find(i => i.host === '10.78.0.1')!;
  await rejects(() => store.update(p.operator, extra.proxy_id, { expected_version: extra.version, server_id: 'a1' }), 'BUDGET_EXHAUSTED');
  assert.equal((await store.overview(p.reader)).items.find(i => i.host === '10.78.0.1')!.server_id, null, 'the assignment rolled back');
  assert.equal((await store.sync(p.nodeA, report(1, []))).assignments.length, 500);
  await pool.query(`UPDATE m1.proxies SET enabled=false WHERE workspace_id=$1 AND host='10.77.0.0'`, [p.operator.workspace_id]);
  const bound = await store.update(p.operator, extra.proxy_id, { expected_version: extra.version, server_id: 'a1' });
  assert.equal(bound.server_id, 'a1', 'a disabled endpoint frees its slot');
});
test('only disabled proxies can be deleted, with a version check', async () => {
  const p = people();
  await store.importProxies(p.operator, { entries: [entry('203.0.113.77')] });
  const proxy = (await store.overview(p.operator)).items[0]!;
  await rejects(() => store.remove(p.operator, proxy.proxy_id, proxy.version), 'CONFLICT');
  const disabled = await store.update(p.operator, proxy.proxy_id, { expected_version: proxy.version, enabled: false });
  await rejects(() => store.remove(p.reader, proxy.proxy_id, disabled.version), 'FORBIDDEN');
  await rejects(() => store.remove(p.operator, proxy.proxy_id, proxy.version), 'CONFLICT');
  await store.remove(p.operator, proxy.proxy_id, disabled.version);
  assert.equal((await store.overview(p.reader)).items_total, 0);
});
