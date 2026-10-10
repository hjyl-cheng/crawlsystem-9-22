import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { ChannelDetailSchema, PlanSchema, PlanDetailSchema } from '@crawlsystem/contracts';
import { issueToken, loadSigningKey } from '@crawlsystem/http/auth';
import { MinioStore } from '../../apps/execution-worker/src/raw-archive.ts';

/** One manual update after full acceptance, without changing scheduler switches or channel policy. */
const kube = (...args: string[]) => execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
assert.equal(kube('-n','control','get','deployment','intent-dispatcher','-o','jsonpath={.spec.template.spec.containers[0].env[?(@.name=="UPDATE_SCHEDULER_ENABLED")].value}'), 'false');
const full = JSON.parse(readFileSync('.runtime/r2/preview-evidence.json','utf8'));
assert.equal(full.result, 'PASSED');
const channelId = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const base = `http://${kube('-n','control','get','svc','control-api-preview','-o','jsonpath={.spec.clusterIP}')}:18100`;
const token = await issueToken({ subject: 'r2-update-acceptance', workspace_id: 'm1-main', role: 'operator' }, loadSigningKey(), 1800);
async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok, `Update acceptance API HTTP ${response.status}`); return response.json();
}
const before = ChannelDetailSchema.parse(await api(`/v1/channels/${channelId}`));
assert.equal(before.management.state, 'managed', 'Use the already managed acceptance channel');
const id = process.argv[2] ?? PlanSchema.parse(await api(`/v1/channels/${channelId}/update`, { request_id: randomUUID(), expected_version: before.management.version, domains: ['VIDEO'] })).plan_id;
writeFileSync('.runtime/r2/update-plan', id); console.log(JSON.stringify({ phase: 'created', plan_id: id }));
let completed = false;
for (const end = Date.now() + 20 * 60_000; Date.now() < end; await delay(10_000)) {
  const detail = PlanDetailSchema.parse(await api(`/v1/plans/${id}`));
  console.log(JSON.stringify({ phase: 'progress', status: detail.plan.status, last_event: detail.events[0]?.message }));
  assert.ok(!['FAILED','CANCELLED'].includes(detail.plan.status), 'Manual update must complete');
  if (detail.plan.status !== 'COMPLETED') continue;
  assert.equal(detail.input.source_mode, 'youtube');
  if (detail.input.source_mode !== 'youtube') throw new Error('Unexpected input');
  assert.equal(detail.input.plan_kind, 'UPDATE'); assert.ok(detail.domains.every(d => d.state === 'APPLIED'));
  assert.deepEqual(detail.video_targets, [], 'No new upload is expected immediately after freezing the full plan');
  const secret = JSON.parse(kube('-n','crawler','get','secret','minio-crawl-worker','-o','json')).data;
  const store = new MinioStore(`http://${kube('-n','storage','get','svc','minio','-o','jsonpath={.spec.clusterIP}')}:9000`, 'crawl-raw', Buffer.from(secret.access_key,'base64').toString(), Buffer.from(secret.secret_key,'base64').toString());
  const prefix = `v1/m1-main/${id}/${detail.plan.execution_epoch}/TARGETS/`, signal = new AbortController().signal;
  const raw = await store.get(prefix + 'uploads.json.gz', signal), manifestRaw = await store.get(prefix + '_manifest.json.gz', signal);
  assert.ok(raw); assert.ok(manifestRaw);
  const unit = JSON.parse(gunzipSync(raw).toString()), manifest = JSON.parse(gunzipSync(manifestRaw).toString());
  assert.equal(unit.result.stop_reason, 'anchor_matched'); assert.ok(detail.input.discovery_anchor_ids?.includes(unit.result.matched_anchor_id));
  assert.equal(manifest.units.length, 1); assert.equal(manifest.units[0].sha256, createHash('sha256').update(raw).digest('hex'));
  const after = ChannelDetailSchema.parse(await api(`/v1/channels/${channelId}`));
  assert.deepEqual(after.videos.map(v => v.source_content_id).sort(), before.videos.map(v => v.source_content_id).sort(), 'An empty discovery must not duplicate entities');
  const evidence = { result: 'PASSED', plan_id: id, full_plan_id: full.plan_id, verified_at: new Date().toISOString(), targets: detail.video_targets,
    stop_reason: unit.result.stop_reason, matched_anchor_id: unit.result.matched_anchor_id, pages: unit.result.pages, scanned: unit.result.scanned,
    sampling_selected: detail.input.recent_sampling?.video_ids.length ?? 0, receipts: detail.receipts.map(r => r.logical_batch_key), raw_manifest_verified: true, video_entities_unchanged: true };
  writeFileSync('.runtime/r2/update-evidence.json', JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence)); completed = true; break;
}
assert.ok(completed, 'Update timed out; resume using the recorded plan ID');
