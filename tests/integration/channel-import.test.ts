import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { CONTRACT_VERSION, UpdateLimitsSchema, type Domain, type Plan, type Principal, type Submission, type YoutubeFrozenInput } from '@crawlsystem/contracts';
import { fixtureChannel, fixtureVideo } from '@crawlsystem/contracts/fixtures';
import { stableSubmissionId, submissionHash } from '@crawlsystem/contracts/hash';
import { prepareDatabase } from './database-ready.ts';

/** Plan step B1: channels imported in bulk are queued, then admitted into first collections under the scheduler's limits. */
const pool = createPool();
before(async () => { await prepareDatabase(pool); });
after(async () => { await pool.end(); });
const model = JSON.parse(readFileSync(new URL('../../apps/profile-agent/tests/expected-profile.json', import.meta.url), 'utf8'));
function setup(limits = {}) {
  const workspace_id = `test-import-${randomUUID()}`;
  const as = (role: Principal['role']): Principal => ({ workspace_id, subject: role, role });
  return { store: new Store(pool, UpdateLimitsSchema.parse(limits)), op: as('operator'), reader: as('reader'), worker: as('worker') };
}
const channelId = () => 'UC' + randomUUID().replaceAll('-', '').slice(0, 22);
function submit(plan: Plan, domain: Domain, key: string, payload: unknown, domain_complete: boolean): Submission {
  const body = { schema_version: CONTRACT_VERSION, submission_id: stableSubmissionId(plan.plan_id, plan.execution_epoch, domain, key), plan_id: plan.plan_id,
    execution_epoch: plan.execution_epoch, input_hash: plan.input_hash, logical_batch_key: key, domain, payload, domain_complete };
  return { ...body, payload_hash: submissionHash(body as never) } as Submission;
}
const importLines = (t: ReturnType<typeof setup>, lines: string[]) => t.store.importChannels(t.op, { request_id: randomUUID(), lines });
async function completeFirstCollection(t: ReturnType<typeof setup>, plan: Plan) {
  const channel = plan.channel_id, input = (await t.store.getInput(t.worker, plan.plan_id)).input as YoutubeFrozenInput, video = randomUUID().replaceAll('-', '').slice(0, 11);
  await t.store.apply(t.worker, submit(plan, 'ABOUT', 'about', { ...structuredClone(fixtureChannel), channel_id: channel, channel_url: `https://www.youtube.com/channel/${channel}`, observed_at: new Date().toISOString() }, true));
  await t.store.apply(t.worker, submit(plan, 'VIDEO', 'targets', { kind: 'targets', channel_id: channel, video_ids: [video], listed_at: new Date().toISOString(),
    window_start: new Date(Date.parse(input.reference_time) - input.scope.max_age_days * 86_400_000).toISOString(), exhausted: true, source: 'test' }, false));
  await t.store.apply(t.worker, submit(plan, 'VIDEO', 'videos', { kind: 'videos', items: [{ ...structuredClone(fixtureVideo), channel_id: channel, source_content_id: video, url: `https://www.youtube.com/watch?v=${video}` }] }, true));
  const snapshot = await t.store.agentInput(t.worker, plan.plan_id), { diagnostics: _diagnostics, ...profile } = model;
  await t.store.apply(t.worker, submit(plan, 'AGENT', 'agent', { channel_id: channel, input_hash: snapshot.input_hash, ...profile }, true));
}

test('each pasted line is queued once, or reported as known, repeated, a handle or unreadable', async () => {
  const t = setup(), a = channelId(), b = channelId();
  const result = await importLines(t, [a, `https://www.youtube.com/channel/${a}/videos`, ` ${b} `, '@somecreator', 'https://www.youtube.com/@another', 'not a channel', 'https://example.com/channel/' + a, '']);
  assert.deepEqual(result.items.map(i => i.outcome), ['queued', 'duplicate', 'queued', 'handle_unsupported', 'handle_unsupported', 'invalid', 'invalid']);
  assert.equal(result.queued, 2);
  assert.deepEqual((await importLines(t, [a])).items.map(i => i.outcome), ['already_queued']);
  const imports = await t.store.channelImports(t.reader);
  assert.deepEqual(imports.counts, { queued: 2, planned: 0, done: 0, failed: 0 });
  await assert.rejects(() => t.store.importChannels(t.reader, { request_id: randomUUID(), lines: [a] }), (e: unknown) => e instanceof StoreError && e.code === 'FORBIDDEN');
});

test('the scheduler admits imports oldest first within the active-plan limit; outcomes follow the first collection', async () => {
  const t = setup({ max_active_plans: 1 }), first = channelId(), second = channelId();
  await importLines(t, [first]); await importLines(t, [second]);
  const admitted = await t.store.scheduleUpdates(t.op.workspace_id);
  assert.deepEqual(admitted.map(p => [p.channel_id, p.plan_kind, p.required_domains]), [[first, 'FULL', ['ABOUT', 'VIDEO', 'AGENT']]], 'one at a time, oldest first');
  assert.deepEqual((await t.store.channelImports(t.reader)).counts, { queued: 1, planned: 1, done: 0, failed: 0 });
  assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id), [], 'the limit holds');

  await t.store.cancel(t.op, admitted[0]!.plan_id, { command_id: randomUUID(), expected_version: admitted[0]!.version });
  assert.equal((await t.store.channelImports(t.reader)).items.find(i => i.channel_id === first)!.state, 'failed');
  assert.deepEqual((await importLines(t, [first])).items.map(i => i.outcome), ['queued'], 'a failed import can be queued again');

  const next = await t.store.scheduleUpdates(t.op.workspace_id);
  assert.deepEqual(next.map(p => p.channel_id), [second], 'the older queued channel goes first');
  await completeFirstCollection(t, next[0]!);
  const done = (await t.store.channelImports(t.reader)).items.find(i => i.channel_id === second)!;
  assert.equal(done.state, 'done'); assert.equal(done.title, fixtureChannel.title);
  assert.equal((await t.store.getChannel(t.reader, second)).management.state, 'managed', 'a completed first collection manages the channel');
  assert.deepEqual((await importLines(t, [second])).items.map(i => i.outcome), ['known']);
});

test('no import is admitted while the Data API quota cannot cover a first collection', async () => {
  const t = setup({ api_daily_limit: 10 });
  await importLines(t, [channelId()]);
  assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id), []);
  assert.deepEqual((await t.store.channelImports(t.reader)).counts.queued, 1);
});
