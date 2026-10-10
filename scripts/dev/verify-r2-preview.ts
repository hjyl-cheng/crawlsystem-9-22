import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { PlanDetailSchema, PlanSchema, WorkerSchema, ChannelDetailSchema, pageSchema } from '@crawlsystem/contracts';
import { issueToken, loadSigningKey } from '@crawlsystem/http/auth';
/** A bounded real plan through the resident Worker. No database reset and no automatic scheduling. */
const kubectl = (...args: string[]) => execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const base = `http://${kubectl('-n', 'control', 'get', 'svc', 'control-api-preview', '-o', 'jsonpath={.spec.clusterIP}')}:18100`;
const token = await issueToken({ subject: 'r2-acceptance', workspace_id: 'm1-main', role: 'operator' }, loadSigningKey(), 1800);
const api = async (path: string, body?: unknown) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`Acceptance API HTTP ${response.status}`);
  return response.json();
};
for (const [ns, deployment, name] of [['control', 'control-api-preview', 'QUERY_RUNS_ENABLED'], ['control', 'control-api-preview', 'QUERY_AUTO_ADMIT'], ['control', 'intent-dispatcher', 'UPDATE_SCHEDULER_ENABLED']])
  assert.equal(kubectl('-n', ns!, 'get', 'deployment', deployment!, '-o', `jsonpath={.spec.template.spec.containers[0].env[?(@.name=="${name}")].value}`), 'false');
const id = process.argv[2] ?? PlanSchema.parse(await api('/v1/plans', { request_id: randomUUID(), source_mode: 'youtube', channel_id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
  required_domains: ['ABOUT', 'VIDEO', 'AGENT'], scope: { video_limit: 2, comments_per_video: 5 } })).plan_id;
mkdirSync('.runtime/r2', { recursive: true }); writeFileSync('.runtime/r2/current-plan', id);
console.log(JSON.stringify({ phase: 'created', plan_id: id }));
let done = false;
for (const end = Date.now() + 20 * 60_000; Date.now() < end; await delay(10_000)) {
  const plan = PlanDetailSchema.parse(await api(`/v1/plans/${id}`));
  console.log(JSON.stringify({ phase: 'progress', status: plan.plan.status, domains: plan.domains.map(d => `${d.domain}:${d.state}`), last_event: plan.events[0]?.message }));
  if (['FAILED', 'CANCELLED'].includes(plan.plan.status)) throw new Error(`Real plan ${plan.plan.status}`);
  if (plan.plan.status !== 'COMPLETED') continue;
  assert.equal(plan.video_targets?.length, 2);
  assert.ok(plan.domains.every(d => d.state === 'APPLIED'));
  const workers = pageSchema(WorkerSchema).parse(await api('/v1/workers?limit=100')).items;
  const worker = workers.find(w => w.worker_id === 'execution-worker-0');
  assert.equal(worker?.collector?.gateway, 'ready'); assert.equal(worker?.collector?.enforce_egress_country, false);
  const channel = ChannelDetailSchema.parse(await api(`/v1/channels/${plan.plan.channel_id}`));
  assert.equal(channel.about?.source, 'youtubei:channel_about');
  const videos = channel.videos.filter(v => plan.video_targets!.includes(v.source_content_id));
  assert.equal(videos.length, 2);
  const evidence = { result: 'PASSED', plan_id: id, verified_at: new Date().toISOString(), revision: worker!.build_version,
    targets: plan.video_targets, about_source: channel.about!.source, videos: videos.map(v => ({ id: v.source_content_id, access: v.access_status,
      ...(!('unavailable' in v) ? { source: v.extractor_version, published_precision: v.published_at_precision, comments: v.comments_first_page?.returned_count ?? null } : {}) })), collector: worker!.collector,
    receipts: plan.receipts.map(r => r.logical_batch_key), notes: plan.events.filter(e => e.phase === 'COLLECTOR').map(e => e.message) };
  writeFileSync('.runtime/r2/preview-evidence.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence)); done = true; break;
}
assert.ok(done, 'Real plan did not settle before acceptance timeout; resume by passing the recorded plan ID');
