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
