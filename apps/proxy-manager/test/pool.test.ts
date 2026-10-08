import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyPool, proxyUrl, type Lease } from '../src/pool.ts';
import type { ProxyAssignment } from '@crawlsystem/contracts';

const assignment = (id: string, extra: Partial<ProxyAssignment> = {}): ProxyAssignment => ({ proxy_id: id, generation: 1, protocol: 'socks5', host: '192.0.2.1', port: 1080, username: null, password: null, kind: 'static', max_concurrency: 2, tls_insecure: false, ...extra });
const P1 = '00000000-0000-4000-8000-000000000001', P2 = '00000000-0000-4000-8000-000000000002';
/** Two passing content probes in a row qualify a proxy for leasing (latency left unset). */
const qualify = (pool: ProxyPool, id: string) => { pool.probed(id, true, null); pool.probed(id, true, null); };
function setup(assignments = [assignment(P1)], { qualified = true } = {}) {
  let now = 1_000_000; const pool = new ProxyPool(() => now, () => 0);
  pool.apply(assignments, now + 300_000);
  if (qualified) for (const a of assignments) qualify(pool, a.proxy_id);
  return { pool, advance: (ms: number) => { now += ms; }, now: () => now };
}
const lease = (value: ReturnType<ProxyPool['acquire']>) => { assert.ok('lease_id' in value, JSON.stringify(value)); return value as Lease; };

test('per-proxy concurrency is enforced across all callers on the node', () => {
  const { pool } = setup();
  const a = lease(pool.acquire()), b = lease(pool.acquire());
  assert.deepEqual(pool.acquire(), { wait_ms: 5_000, reason: 'all_busy_or_cooling' });
  pool.release(a.lease_id, 'success', 300);
  assert.equal(lease(pool.acquire()).proxy_id, b.proxy_id);
});
test('three failures cool a proxy down with growing backoff; blocked cools for ten minutes', () => {
  const { pool, advance } = setup();
  for (let i = 0; i < 3; i++) pool.release(lease(pool.acquire()).lease_id, 'failure', undefined, 'connect_refused');
  assert.equal(pool.observations()[0]!.state, 'cooldown');
  assert.equal((pool.acquire() as { reason: string }).reason, 'all_busy_or_cooling');
  advance(60_001);
  for (let i = 0; i < 3; i++) pool.release(lease(pool.acquire()).lease_id, 'failure');
  const second = Date.parse(pool.observations()[0]!.cooldown_until!);
  advance(120_001); pool.release(lease(pool.acquire()).lease_id, 'blocked', undefined, 'http_429');
  const obs = pool.observations()[0]!;
  assert.equal(obs.state, 'failed', 'three cooldowns in a row mark the proxy failed');
  assert.ok(Date.parse(obs.cooldown_until!) - second > 590_000);
  assert.equal(obs.requests_total, 7); assert.equal(obs.failures_total, 7); assert.equal(obs.last_error, 'http_429');
});
test('a success resets the streak and latency is smoothed; unreturned leases expire as timeouts', () => {
  const { pool, advance } = setup();
  pool.release(lease(pool.acquire()).lease_id, 'failure');
  pool.release(lease(pool.acquire()).lease_id, 'success', 400);
  pool.release(lease(pool.acquire()).lease_id, 'success', 200);
  let obs = pool.observations()[0]!;
  assert.equal(obs.state, 'healthy'); assert.equal(obs.latency_ms, 340);
  lease(pool.acquire(10_000)); advance(10_001); pool.expire();
  obs = pool.observations()[0]!;
  assert.equal(obs.state, 'degraded'); assert.equal(obs.last_error, 'lease_expired'); assert.equal(pool.stats().leases, 0);
});
test('without a valid central lease nothing is handed out, and leases never outlive it', () => {
  const { pool, advance, now } = setup();
  const l = lease(pool.acquire(600_000));
  assert.equal(l.expires_at, now() + 300_000, 'bounded by the central lease');
  advance(300_001);
  assert.deepEqual(pool.acquire(), { wait_ms: 30_000, reason: 'unauthorized' });
});
test('reassignment (new generation) resets health; unobserved proxies are not reported', () => {
  const { pool, now } = setup([assignment(P1), assignment(P2, { host: '192.0.2.2' })], { qualified: false });
  for (let i = 0; i < 3; i++) pool.probed(P1, false, null, 'proxy_unreachable');
  assert.deepEqual(pool.observations().map(o => o.state), ['cooldown']);
  pool.apply([assignment(P1, { generation: 2 })], now() + 300_000);
  assert.deepEqual(pool.observations(), []);
  pool.probed(P1, true, 250);
  assert.deepEqual(pool.observations().map(o => [o.state, o.generation, o.latency_ms]), [['trial', 2, 250]], 'a new generation starts a new trial');
  pool.probed(P1, true, 240);
  assert.deepEqual(pool.observations().map(o => o.state), ['healthy']);
});
test('only a credential-free HTTPS assignment marked insecure gets the insecure fragment', () => {
  assert.equal(proxyUrl(assignment('x', { protocol: 'https', port: 9002, tls_insecure: true })), 'https://192.0.2.1:9002#insecure-tls');
  assert.equal(proxyUrl(assignment('x', { protocol: 'https', port: 9002, tls_insecure: true, username: 'u', password: 'p' })), 'https://u:p@192.0.2.1:9002');
  assert.equal(proxyUrl(assignment('x', { protocol: 'socks5', tls_insecure: true })), 'socks5://192.0.2.1:1080');
});
test('proxy URLs carry encoded credentials and bracket IPv6 hosts', () => {
  assert.equal(proxyUrl(assignment('x', { protocol: 'http', username: 'a@b', password: 'p:w' })), 'http://a%40b:p%3Aw@192.0.2.1:1080');
  assert.equal(proxyUrl(assignment('x', { host: '2001:db8::1' })), 'socks5://[2001:db8::1]:1080');
});
test('new proxies are leased only after two content probes in a row pass', () => {
  const { pool } = setup([assignment(P1)], { qualified: false });
  assert.deepEqual(pool.acquire(), { wait_ms: 30_000, reason: 'in_trial' });
  assert.deepEqual(pool.observations(), [], 'unprobed proxies are not reported');
  pool.probed(P1, true, 300);
  assert.equal(pool.observations()[0]!.state, 'trial');
  pool.probed(P1, false, null, 'no_data');
  pool.probed(P1, true, 300);
  assert.deepEqual(pool.acquire(), { wait_ms: 30_000, reason: 'in_trial' }, 'a failed probe restarts the count');
  pool.probed(P1, true, 300);
  assert.equal(lease(pool.acquire()).proxy_id, P1);
  assert.deepEqual(pool.stats(), { assigned: 1, qualified: 1, leases: 1, authorized: true });
});
test('only qualified proxies are leased while others are still in trial', () => {
  const { pool } = setup([assignment(P1), assignment(P2, { host: '192.0.2.2' })], { qualified: false });
  qualify(pool, P2);
  assert.equal(lease(pool.acquire()).proxy_id, P2);
  assert.equal(lease(pool.acquire()).proxy_id, P2);
  assert.equal((pool.acquire() as { reason: string }).reason, 'all_busy_or_cooling');
});
test('a block from YouTube cools the proxy down and sends it back to trial', () => {
  const { pool, advance, now } = setup();
  pool.release(lease(pool.acquire()).lease_id, 'blocked', undefined, 'bot_check');
  assert.equal(pool.observations()[0]!.state, 'cooldown');
  advance(10 * 60_000 + 1);
  pool.apply([assignment(P1)], now() + 300_000); // the central lease was renewed meanwhile; same generation keeps health
  assert.equal(pool.observations()[0]!.state, 'trial');
  assert.equal((pool.acquire() as { reason: string }).reason, 'in_trial');
  qualify(pool, P1);
  assert.equal(pool.observations()[0]!.state, 'healthy');
  assert.equal(lease(pool.acquire()).proxy_id, P1);
});
test('blocked probes also cool down, and three cooldowns without a success report failed', () => {
  const { pool, advance } = setup([assignment(P1)], { qualified: false });
  for (let i = 0; i < 3; i++) { if (i) advance(10 * 60_000 + 1); pool.probed(P1, false, null, 'blocked_429', true); }
  const obs = pool.observations()[0]!;
  assert.equal(obs.state, 'failed'); assert.equal(obs.last_error, 'blocked_429');
  assert.equal(obs.requests_total, 0, 'probes are not Worker requests');
});
test('proxies in trial are probed more often than qualified ones', () => {
  const { pool, advance } = setup([assignment(P1), assignment(P2, { host: '192.0.2.2' })], { qualified: false });
  qualify(pool, P2); pool.probed(P1, true, null);
  advance(60_001);
  assert.deepEqual(pool.probeCandidates(300_000, 10, 60_000).map(a => a.proxy_id), [P1]);
  advance(240_000);
  assert.deepEqual(pool.probeCandidates(300_000, 10, 60_000).map(a => a.proxy_id).sort(), [P1, P2]);
});
