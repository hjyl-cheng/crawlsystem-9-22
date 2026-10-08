import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { CONTRACT_VERSION, type Domain, type Plan, type Principal, type Submission, type YoutubeFrozenInput } from '@crawlsystem/contracts';
import { fixtureChannel, fixtureVideo } from '@crawlsystem/contracts/fixtures';
import { stableSubmissionId, submissionHash } from '@crawlsystem/contracts/hash';
import { prepareDatabase } from './database-ready.ts';

/** The console's Agent tasks and Data API pages read real plans, domains, events and quota permits. */
const pool = createPool(), store = new Store(pool);
before(async () => { await prepareDatabase(pool); });
after(async () => { await pool.end(); });
const model = JSON.parse(readFileSync(new URL('../../apps/profile-agent/tests/expected-profile.json', import.meta.url), 'utf8'));
function people() {
  const workspace_id = `test-ops-${randomUUID()}`;
  const as = (role: Principal['role']): Principal => ({ workspace_id, subject: role, role });
  return { op: as('operator'), reader: as('reader'), worker: as('worker') };
}
function submit(plan: Plan, domain: Domain, key: string, payload: unknown, domain_complete: boolean): Submission {
  const body = { schema_version: CONTRACT_VERSION, submission_id: stableSubmissionId(plan.plan_id, plan.execution_epoch, domain, key), plan_id: plan.plan_id,
    execution_epoch: plan.execution_epoch, input_hash: plan.input_hash, logical_batch_key: key, domain, payload, domain_complete };
  return { ...body, payload_hash: submissionHash(body as never) } as Submission;
}
const channelId = () => 'UC' + randomUUID().replaceAll('-', '').slice(0, 22);
async function plan(p: ReturnType<typeof people>, channel: string, domains: Domain[]) {
  return store.createPlan(p.op, { request_id: randomUUID(), source_mode: 'youtube', channel_id: channel, required_domains: domains } as never);
}
async function collect(p: ReturnType<typeof people>, created: Plan, channel: string) {
  const input = (await store.getInput(p.worker, created.plan_id)).input as YoutubeFrozenInput, id = randomUUID().replaceAll('-', '').slice(0, 11);
  await store.apply(p.worker, submit(created, 'ABOUT', 'about:channel', { ...structuredClone(fixtureChannel), channel_id: channel, channel_url: `https://www.youtube.com/channel/${channel}`, observed_at: new Date().toISOString() }, true));
  await store.apply(p.worker, submit(created, 'VIDEO', 'video:targets', { kind: 'targets', channel_id: channel, video_ids: [id], listed_at: new Date().toISOString(),
    window_start: new Date(Date.parse(input.reference_time) - input.scope.max_age_days * 86_400_000).toISOString(), exhausted: true, source: 'test' }, false));
  await store.apply(p.worker, submit(created, 'VIDEO', 'video:batch:0', { kind: 'videos', items: [{ ...structuredClone(fixtureVideo), channel_id: channel, source_content_id: id, url: `https://www.youtube.com/watch?v=${id}` }] }, true));
}

test('Agent tasks are waiting, running, completed or failed, with summary counts and model versions', async () => {
  const p = people();
  const waiting = channelId(), running = channelId(), done = channelId(), failed = channelId();
  await plan(p, waiting, ['ABOUT', 'VIDEO', 'AGENT']);
  await collect(p, await plan(p, running, ['ABOUT', 'VIDEO', 'AGENT']), running);
  const finished = await plan(p, done, ['ABOUT', 'VIDEO', 'AGENT']);
  await collect(p, finished, done);
  const snapshot = await store.agentInput(p.worker, finished.plan_id);
  const { diagnostics: _diagnostics, ...profile } = model;
  await store.apply(p.worker, submit(finished, 'AGENT', 'agent', { channel_id: done, input_hash: snapshot.input_hash, ...profile }, true));
  const cancelled = await plan(p, failed, ['ABOUT', 'VIDEO', 'AGENT']);
  await store.cancel(p.op, cancelled.plan_id, { command_id: randomUUID(), expected_version: cancelled.version });
  await plan(p, channelId(), ['ABOUT', 'VIDEO']);

  const tasks = (await store.agentTasks(p.reader, 20)).items;
  assert.deepEqual(tasks.map(t => [t.channel_id, t.state]).sort(), [[waiting, 'waiting'], [running, 'running'], [done, 'completed'], [failed, 'failed']].sort(), 'plans without AGENT are not tasks');
  assert.deepEqual(tasks.find(t => t.channel_id === waiting)!.waiting_on, ['ABOUT', 'VIDEO']);
  assert.equal(tasks[0]!.state, 'running', 'active tasks first');
  assert.ok(tasks.every(t => t.trigger === 'first'));
  assert.deepEqual((await store.agentTasks(p.reader, 20, 0, 'completed')).items.map(t => t.channel_id), [done]);
  const summary = await store.agentSummary(p.reader);
  assert.deepEqual([summary.waiting, summary.running, summary.completed_24h, summary.failed_24h, summary.profiled_channels], [1, 1, 1, 1, 1]);
  assert.equal(summary.model_versions[0]!.model_version, model.model_version);
  await assert.rejects(() => store.agentTasks(p.worker), (e: unknown) => e instanceof StoreError && e.code === 'FORBIDDEN');
});

test('Data API calls are counted per hour and endpoint, and failures by reason', async () => {
  const p = people(), created = await plan(p, channelId(), ['ABOUT']);
  const owner = { plan_id: created.plan_id, execution_epoch: created.execution_epoch, input_hash: created.input_hash };
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  await store.dataApiPermit(p.worker, { request_id: ids[0], ...owner, endpoint: 'channels' });
  await store.dataApiPermit(p.worker, { request_id: ids[1], ...owner, endpoint: 'videos' });
  await store.dataApiPermit(p.worker, { request_id: ids[2], ...owner });
  assert.deepEqual(await store.dataApiFailure(p.worker, { request_id: ids[1], ...owner, reason: 'quota' }), { recorded: true });
  assert.deepEqual(await store.dataApiFailure(p.worker, { request_id: ids[1], ...owner, reason: 'quota' }), { recorded: false }, 'once per request');
  await assert.rejects(() => store.dataApiFailure(p.worker, { request_id: ids[0], ...owner, execution_epoch: 9, reason: 'invalid' }), (e: unknown) => e instanceof StoreError && e.code === 'STALE_EXECUTION');
  const summary = await store.dataApiSummary(p.reader);
  assert.equal(summary.used_units, 3);
  assert.equal(summary.hourly.reduce((n, h) => n + h.calls, 0), 3);
  assert.equal(summary.hourly.at(-1)!.failures, 1, 'this hour');
  assert.deepEqual(summary.endpoints.map(e => [e.endpoint, e.calls, e.failures]).sort(), [['channels', 1, 0], ['unknown', 1, 0], ['videos', 1, 1]]);
  assert.deepEqual(summary.failures_by_reason, [{ reason: 'quota', count: 1 }]);
  assert.deepEqual(summary.recent_failures.map(f => [f.endpoint, f.reason, f.plan_id]), [['videos', 'quota', created.plan_id]]);
});
