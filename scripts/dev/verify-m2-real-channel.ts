/**
 * M2 acceptance (step 6): one real YouTube channel end to end on the resident preview
 * stack, with interruptions, using the default frozen scope (30 videos / 90 days / 20
 * Top comments):
 *  1. the Worker Pod is replaced while VIDEO batches are being collected;
 *  2. the Profile Agent is down when AGENT starts and comes back later.
 * The plan must complete with ABOUT, VIDEO and AGENT applied, every logical batch
 * applied exactly once and the video targets frozen once.
 *
 * Proxies: uses the healthy proxies already bound to the Worker's node. With
 * --public-proxies and none available, it imports a few probed public SOCKS5 proxies
 * for the run and deletes them afterwards (public lists are unstable; testing only).
 *
 *   node --env-file=.runtime/main.env --import tsx scripts/dev/verify-m2-real-channel.ts [--channel UC…] [--public-proxies]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { AgentResultSchema, ChannelDetailSchema, PlanDetailSchema, PlanSchema, ProxyOverviewSchema, type PlanDetail } from '@crawlsystem/contracts';
import { issueToken, loadSigningKey } from '@crawlsystem/http/auth';
import { probeProxy } from '@crawlsystem/execution-client/proxy-connect';

const { values: args } = parseArgs({ options: { channel: { type: 'string', default: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' }, 'public-proxies': { type: 'boolean', default: false } } });
const kubectl = (...a: string[]) => execFileSync('kubectl', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const base = `http://${kubectl('-n', 'control', 'get', 'svc', 'control-api-preview', '-o', 'jsonpath={.spec.clusterIP}')}:18100`;
const token = await issueToken({ subject: 'm2-acceptance', workspace_id: 'm1-main', role: 'operator' }, loadSigningKey(), 3600);
const api = async (path: string, body?: unknown) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(data)}`);
  return data;
};
const plan = async (id: string) => PlanDetailSchema.parse(await api(`/v1/plans/${id}`));
async function until(id: string, done: (p: PlanDetail) => boolean, seconds: number, label: string) {
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await delay(2000)) { const p = await plan(id); if (done(p)) return p; if (['FAILED', 'CANCELLED'].includes(p.plan.status)) break; }
  const last = await plan(id); throw new Error(`${label}: plan ${id} at ${last.plan.status}; last events ${JSON.stringify(last.events.slice(0, 5).map(e => `${e.kind} ${e.phase} ${e.message}`))}`);
}
const step = (m: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const checks: string[] = [];
const pass = (check: string) => { checks.push(check); process.stdout.write(`PASS ${check}\n`); };
const TAG = 'm2-acceptance-temporary';
const node = kubectl('-n', 'crawler', 'get', 'pod', 'execution-worker-0', '-o', 'jsonpath={.spec.nodeName}');
const proxies = async () => ProxyOverviewSchema.parse(await api('/v1/proxies')).items;
const usable = async () => (await proxies()).filter(p => p.enabled && !p.retired && p.server_id === node && ['healthy', 'degraded'].includes(p.state));
const profileReplicas = () => kubectl('-n', 'crawler', 'get', 'deployment', 'profile-agent', '-o', 'jsonpath={.spec.replicas}');

async function importPublicProxies() {
  const list = (await (await fetch('https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt')).text()).split('\n').map(l => l.trim()).filter(l => /^[\d.]+:\d+$/.test(l));
  const good: string[] = [];
  for (let i = 0; i < Math.min(list.length, 900) && good.length < 6; i += 60)
    for (const { hp, r } of await Promise.all(list.slice(i, i + 60).map(async hp => ({ hp, r: await probeProxy(`socks5://${hp}`, { timeoutMs: 8000 }) })))) if (r.ok && good.length < 6) good.push(hp);
  if (!good.length) throw new Error('No public SOCKS5 proxy passed the probe');
  await api('/v1/proxies/import', { entries: good.map(hp => ({ protocol: 'socks5', host: hp.split(':')[0], port: Number(hp.split(':')[1]), provider: TAG, group: TAG, max_concurrency: 2 })) });
  for (const p of (await proxies()).filter(p => p.provider === TAG)) await api(`/v1/proxies/${p.proxy_id}`, { expected_version: p.version, server_id: node });
  step(`imported ${good.length} temporary public proxies bound to ${node}`);
}
async function removeTemporaryProxies() {
  for (const p of (await proxies()).filter(p => p.provider === TAG)) {
    const disabled = p.enabled ? await api(`/v1/proxies/${p.proxy_id}`, { expected_version: p.version, enabled: false }) as { version: number } : p;
    await api(`/v1/proxies/${p.proxy_id}/delete`, { expected_version: disabled.version });
  }
}

const originalReplicas = profileReplicas();
let temporary = false;
try {
  // 0. Proxies on the Worker's node.
  if (!(await usable()).length) {
    if (!args['public-proxies']) throw new Error(`No healthy proxy is bound to ${node}; add one in IP management or pass --public-proxies`);
    temporary = true; await importPublicProxies();
    for (let i = 0; i < 24 && !(await usable()).length; i++) await delay(5000);
  }
  const ready = await usable();
  assert.ok(ready.length, `a proxy on ${node} must turn healthy`);
  pass(`${ready.length} usable proxies bound to the Worker node ${node}${temporary ? ' (temporary public, removed afterwards)' : ''}`);

  // 1. The Profile Agent is down before the plan starts; it returns once the plan reaches AGENT.
  kubectl('-n', 'crawler', 'scale', 'deployment/profile-agent', '--replicas=0');
  kubectl('-n', 'crawler', 'wait', '--for=delete', 'pod', '-l', 'app.kubernetes.io/name=profile-agent', '--timeout=60s');
  step('profile-agent scaled to 0');

  // 2. A real plan with the default scope; replace the Worker Pod once the first VIDEO batch is applied.
  const created = PlanSchema.parse(await api('/v1/plans', { request_id: randomUUID(), source_mode: 'youtube', channel_id: args.channel }));
  const started = Date.now(), id = created.plan_id;
  assert.deepEqual(created.required_domains, ['ABOUT', 'VIDEO', 'AGENT']);
  step(`plan ${id} created for ${args.channel}`);
  const firstBatch = await until(id, p => p.receipts.some(r => r.logical_batch_key.startsWith('video:batch:')), 900, 'first VIDEO batch');
  const targets = firstBatch.video_targets ?? [], batches = Math.ceil(targets.length / 10);
  const oldUid = kubectl('-n', 'crawler', 'get', 'pod', 'execution-worker-0', '-o', 'jsonpath={.metadata.uid}');
  const beforeReplace = new Set(firstBatch.receipts.map(r => r.logical_batch_key));
  step(`first batch applied (${targets.length} targets, ${batches} batches); replacing Worker Pod ${oldUid.slice(0, 8)}`);
  kubectl('-n', 'crawler', 'delete', 'pod', 'execution-worker-0', '--wait=true', '--timeout=90s');
  kubectl('-n', 'crawler', 'wait', '--for=condition=Ready', 'pod/execution-worker-0', '--timeout=180s');
  const newUid = kubectl('-n', 'crawler', 'get', 'pod', 'execution-worker-0', '-o', 'jsonpath={.metadata.uid}');
  assert.notEqual(newUid, oldUid);
  const replaced = await plan(id);
  const videoDoneAtReplace = replaced.domains.find(d => d.domain === 'VIDEO')!.state === 'APPLIED';
  pass(`Worker Pod replaced during collection (${oldUid.slice(0, 8)} → ${newUid.slice(0, 8)}); ${[...beforeReplace].filter(k => k.startsWith('video:batch:')).length}/${batches} batches applied before replacement${videoDoneAtReplace ? ' (drain finished VIDEO)' : ''}`);

  // 3. With VIDEO applied, AGENT fails visibly (retryable) while the Profile Agent is down.
  const waiting = await until(id, p => p.events.some(e => e.phase === 'AGENT' && e.kind === 'ERROR'), 900, 'AGENT unavailable error');
  assert.ok(['RUNNING', 'WAITING'].includes(waiting.plan.status));
  assert.equal(waiting.domains.find(d => d.domain === 'AGENT')!.state, 'PENDING');
  const agentError = waiting.events.find(e => e.phase === 'AGENT' && e.kind === 'ERROR')!;
  assert.match(agentError.message, /UNAVAILABLE; retryable=true/);
  pass(`AGENT reported "${agentError.message}" while the Profile Agent was down; plan stayed ${waiting.plan.status}`);
  kubectl('-n', 'crawler', 'scale', 'deployment/profile-agent', `--replicas=${originalReplicas}`);
  kubectl('-n', 'crawler', 'rollout', 'status', 'deployment/profile-agent', '--timeout=120s');
  step('profile-agent restored');

  // 4. Completion: every domain applied, each logical batch exactly once, targets frozen once.
  const done = await until(id, p => p.plan.status === 'COMPLETED', 600, 'completion');
  assert.ok(done.domains.every(d => d.state === 'APPLIED'));
  const keys = done.receipts.map(r => r.logical_batch_key);
  assert.equal(new Set(keys).size, keys.length, 'no logical batch is applied twice');
  const expected = ['about:channel', 'video:targets', ...Array.from({ length: batches }, (_, i) => `video:batch:${i}`)];
  for (const key of expected) assert.ok(keys.includes(key), `missing receipt ${key}`);
  assert.equal(keys.filter(k => k.startsWith('agent:profile:')).length, 1);
  assert.equal(keys.length, expected.length + 1);
  assert.deepEqual(done.video_targets, targets, 'targets stay frozen across the interruption');
  assert.equal(done.events.filter(e => e.phase === 'TARGETS' && e.kind === 'PROGRESS').length, 1, 'targets are listed once');
  for (let i = 0; i < batches; i++) assert.ok(done.events.filter(e => e.phase === 'VIDEO' && e.kind === 'PROGRESS' && e.message.startsWith(`Batch ${i + 1}/`)).length <= 1);
  const seconds = Math.round((Date.now() - started) / 1000);
  pass(`plan COMPLETED in ${seconds}s: ABOUT, VIDEO, AGENT applied; ${keys.length} receipts, each logical batch once; ${targets.length} targets frozen once`);

  // 5. The channel page's data: facts, videos with comments, and the profile bound to the final input.
  const channel = ChannelDetailSchema.parse(await api(`/v1/channels/${args.channel}`));
  const agent = AgentResultSchema.parse(channel.agent);
  const videos = channel.videos.filter(v => targets.includes(v.source_content_id));
  assert.equal(videos.length, targets.length);
  const withComments = videos.filter(v => !('unavailable' in v) && v.comments_first_page && v.comments_first_page.returned_count > 0).length;
  const unavailable = videos.filter(v => 'unavailable' in v).length;
  assert.ok(channel.about && channel.latest_plan.plan_id === id);
  pass(`channel data: ${targets.length - unavailable} videos (${unavailable} unavailable, ${withComments} with Top comments); profile ${agent.facts.channel_categories.value.level_1} / ${agent.facts.creator_language.value}, input ${agent.input_hash.slice(7, 19)}`);

  const workers = [...new Set(done.events.map(e => e.worker_id))];
  const report = { result: 'PASSED', checked_at: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), channel: args.channel, plan_id: id,
    scope: done.input.source_mode === 'youtube' ? done.input.scope : null, duration_seconds: seconds, targets: targets.length, batches, receipts: keys, worker_pods: { before: oldUid, after: newUid }, event_workers: workers,
    events: [...done.events].reverse().map(e => ({ at: e.created_at, kind: e.kind, phase: e.phase, message: e.message })), temporary_public_proxies: temporary, checks };
  writeFileSync('docs/m2/reports/real-channel-acceptance.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: 'PASSED', checks: checks.length }));
} finally {
  if (profileReplicas() !== originalReplicas) { kubectl('-n', 'crawler', 'scale', 'deployment/profile-agent', `--replicas=${originalReplicas}`); step('profile-agent restored after failure'); }
  if (temporary) { await removeTemporaryProxies(); step('temporary proxies removed'); }
}
