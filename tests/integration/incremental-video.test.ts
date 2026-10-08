import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { CONTRACT_VERSION, type Domain, type Plan, type Principal, type Submission, type VideoFacts, type YoutubeFrozenInput } from '@crawlsystem/contracts';
import { fixtureChannel, fixtureVideo } from '@crawlsystem/contracts/fixtures';
import { stableSubmissionId, submissionHash } from '@crawlsystem/contracts/hash';
import { prepareDatabase } from './database-ready.ts';

/** M3 step 3: an update finds only new uploads (legacy anchors) and re-reads recent videos' counts (legacy Recent Sampling). */
const pool = createPool(), store = new Store(pool);
before(async () => { await prepareDatabase(pool); });
after(async () => { await pool.end(); });

const DAY = 86_400_000;
const ids = () => randomUUID().replaceAll('-', '').slice(0, 11);
function people() {
  const workspace_id = `test-incremental-${randomUUID()}`;
  const as = (role: Principal['role']): Principal => ({ workspace_id, subject: role, role });
  return { op: as('operator'), reader: as('reader'), worker: as('worker') };
}
function submit(plan: Plan, domain: Domain, key: string, payload: unknown, domain_complete: boolean): Submission {
  const body = { schema_version: CONTRACT_VERSION, submission_id: stableSubmissionId(plan.plan_id, plan.execution_epoch, domain, key), plan_id: plan.plan_id,
    execution_epoch: plan.execution_epoch, input_hash: plan.input_hash, logical_batch_key: key, domain, payload, domain_complete };
  return { ...body, payload_hash: submissionHash(body as never) } as Submission;
}
const video = (channel: string, id: string, publishedDaysAgo: number, views: number): VideoFacts => ({ ...structuredClone(fixtureVideo), channel_id: channel, source_content_id: id,
  url: `https://www.youtube.com/watch?v=${id}`, published_at: new Date(Date.now() - publishedDaysAgo * DAY).toISOString(), observed_at: new Date().toISOString(),
  view_count: { ...fixtureVideo.view_count, value: views } });
const reject = (run: () => Promise<unknown>, code: string) => assert.rejects(run, (e: unknown) => e instanceof StoreError && e.code === code);

/** A managed channel whose first collection stored three videos published 2, 5 and 40 days ago. */
async function managedChannel(p: ReturnType<typeof people>) {
  const channel = 'UC' + randomUUID().replaceAll('-', '').slice(0, 22), known = [ids(), ids(), ids()];
  const plan = await store.createPlan(p.op, { request_id: randomUUID(), source_mode: 'youtube', channel_id: channel, required_domains: ['ABOUT', 'VIDEO'] } as never);
  const input = (await store.getInput(p.worker, plan.plan_id)).input as YoutubeFrozenInput;
  await store.apply(p.worker, submit(plan, 'ABOUT', 'about:channel', { ...structuredClone(fixtureChannel), channel_id: channel, channel_url: `https://www.youtube.com/channel/${channel}`, observed_at: new Date().toISOString() }, true));
  await store.apply(p.worker, submit(plan, 'VIDEO', 'video:targets', { kind: 'targets', channel_id: channel, video_ids: known, listed_at: new Date().toISOString(),
    window_start: new Date(Date.parse(input.reference_time) - input.scope.max_age_days * DAY).toISOString(), exhausted: true, source: 'test' }, false));
  await store.apply(p.worker, submit(plan, 'VIDEO', 'video:batch:0', { kind: 'videos', items: [video(channel, known[0]!, 2, 1000), video(channel, known[1]!, 5, 2000), video(channel, known[2]!, 40, 3000)] }, true));
  // Counts last read ten days ago: stale, so both recent videos are picked for a re-read.
  await pool.query("UPDATE m1.videos SET stats_observed_at=now()-interval '10 days' WHERE workspace_id=$1 AND channel_id=$2", [p.op.workspace_id, channel]);
  return { channel, known };
}

test('an update freezes the newest known videos as anchors and the stale recent ones for a re-read', async () => {
  const p = people(), { channel, known } = await managedChannel(p);
  const version = (await store.getChannel(p.reader, channel)).management.version;
  const plan = await store.updateChannel(p.op, channel, { request_id: randomUUID(), expected_version: version, domains: ['VIDEO'] });
  const input = (await store.getInput(p.worker, plan.plan_id)).input as YoutubeFrozenInput;
  assert.deepEqual(input.discovery_anchor_ids, known, 'newest first');
  assert.deepEqual([...input.recent_sampling!.video_ids].sort(), [known[0], known[1]].sort(), 'only the last 30 days');
  assert.equal(input.recent_sampling!.stale_ratio, 1);
});

test('new uploads are collected, recent counts re-read, and the Video clock gets real Recent Sampling', async () => {
  const p = people(), { channel, known } = await managedChannel(p);
  const version = (await store.getChannel(p.reader, channel)).management.version;
  const plan = await store.updateChannel(p.op, channel, { request_id: randomUUID(), expected_version: version, domains: ['VIDEO'] });
  const sampled = ((await store.getInput(p.worker, plan.plan_id)).input as YoutubeFrozenInput).recent_sampling!.video_ids;
  const fresh = ids(), discovery = { kind: 'discovery', channel_id: channel, video_ids: [fresh], listed_at: new Date().toISOString(), scanned_count: 1, pages: 1,
    matched_anchor_id: known[0], stop_reason: 'anchor_matched', source: 'test' };
  await reject(() => store.apply(p.worker, submit(plan, 'VIDEO', 'video:discovery', { ...discovery, matched_anchor_id: ids() }, false)), 'TARGET_MISMATCH');
  await store.apply(p.worker, submit(plan, 'VIDEO', 'video:discovery', discovery, false));
  const batch = { kind: 'videos', items: [video(channel, fresh, 0.1, 50)] };
  await reject(() => store.apply(p.worker, submit(plan, 'VIDEO', 'video:batch:0', batch, true)), 'DOMAIN_INCOMPLETE');
  await store.apply(p.worker, submit(plan, 'VIDEO', 'video:batch:0', batch, false));
  const counts = (id: string, views: number) => ({ video_id: id, view_count: views, like_count: 10, comment_count: id === known[0] ? 2 : 1 });
  const samples = { kind: 'samples', observed_at: new Date().toISOString(), source: 'data_api:videos', items: sampled.map(id => counts(id, id === known[0] ? 1500 : 2000)), missing_video_ids: [] };
  await reject(() => store.apply(p.worker, submit(plan, 'VIDEO', 'video:samples', { ...samples, items: [counts(known[2]!, 1)], missing_video_ids: [] }, true)), 'TARGET_MISMATCH');
  await store.apply(p.worker, submit(plan, 'VIDEO', 'video:samples', samples, true));
  assert.equal((await store.getInput(p.worker, plan.plan_id)).plan.status, 'COMPLETED');

  const facts = (await pool.query('SELECT facts FROM m1.plan_video_samples WHERE plan_id=$1', [plan.plan_id])).rows[0]!.facts;
  assert.deepEqual(facts, { selected_count: 2, success_count: 2, failure_count: 0, comparable_view_count: 2, view_changed_count: 1, view_delta_total: 500, engagement_changed_count: 1 });
  const stored = (await pool.query('SELECT data,stats_observed_at,change_probability FROM m1.videos WHERE workspace_id=$1 AND channel_id=$2 AND video_id=$3', [p.op.workspace_id, channel, known[0]])).rows[0]!;
  assert.deepEqual([stored.data.view_count.value, stored.data.view_count.source, stored.data.comment_count.value], [1500, 'data_api:videos', 2]);
  assert.equal(stored.change_probability, 0.85, 'views (0.70) and comments (0.15) moved, likes (0.15) did not');
  assert.ok(Date.now() - new Date(stored.stats_observed_at).getTime() < 60_000);

  const state = (await pool.query('SELECT state FROM m1.channel_feature_state WHERE workspace_id=$1 AND channel_id=$2', [p.op.workspace_id, channel])).rows[0]!.state;
  assert.equal(state.recent30_video_count, 3, 'the two recent known videos and the new one');
  assert.equal(state.recent_stale_ratio, 1);
  assert.ok(state.last_recent_sampling_at, 'Recent Sampling applied');
  const clock = (await store.getChannel(p.reader, channel)).management.clocks.find(c => c.clock === 'VIDEO')!;
  assert.ok(!clock.reasons.includes('recent_sampling_skipped'), clock.reasons.join(','));
});

test('an update with nothing new and nothing to re-read completes on its discovery', async () => {
  const p = people(), { channel, known } = await managedChannel(p);
  await pool.query("UPDATE m1.videos SET stats_observed_at=now() WHERE workspace_id=$1 AND channel_id=$2", [p.op.workspace_id, channel]);
  const version = (await store.getChannel(p.reader, channel)).management.version;
  const plan = await store.updateChannel(p.op, channel, { request_id: randomUUID(), expected_version: version, domains: ['VIDEO'] });
  assert.deepEqual(((await store.getInput(p.worker, plan.plan_id)).input as YoutubeFrozenInput).recent_sampling!.video_ids, [], 'just read: nothing stale');
  await store.apply(p.worker, submit(plan, 'VIDEO', 'video:discovery', { kind: 'discovery', channel_id: channel, video_ids: [], listed_at: new Date().toISOString(),
    scanned_count: 0, pages: 1, matched_anchor_id: known[0], stop_reason: 'anchor_matched', source: 'test' }, true));
  assert.equal((await store.getInput(p.worker, plan.plan_id)).plan.status, 'COMPLETED');
  const state = (await pool.query('SELECT state FROM m1.channel_feature_state WHERE workspace_id=$1 AND channel_id=$2', [p.op.workspace_id, channel])).rows[0]!.state;
  assert.equal(state.new_video_empty_runs, 1, 'an empty discovery counts as an empty run');
});

test('a first collection cannot report discovery, and an update cannot list a window', async () => {
  const p = people(), { channel } = await managedChannel(p);
  const first = await store.createPlan(p.op, { request_id: randomUUID(), source_mode: 'youtube', channel_id: 'UC' + randomUUID().replaceAll('-', '').slice(0, 22), required_domains: ['VIDEO'] } as never);
  await reject(() => store.apply(p.worker, submit(first, 'VIDEO', 'video:discovery', { kind: 'discovery', channel_id: first.channel_id, video_ids: [], listed_at: new Date().toISOString(),
    scanned_count: 0, pages: 1, matched_anchor_id: null, stop_reason: 'list_end', source: 'test' }, true)), 'TARGET_MISMATCH');
  const version = (await store.getChannel(p.reader, channel)).management.version;
  const update = await store.updateChannel(p.op, channel, { request_id: randomUUID(), expected_version: version, domains: ['VIDEO'] });
  await reject(() => store.apply(p.worker, submit(update, 'VIDEO', 'video:targets', { kind: 'targets', channel_id: channel, video_ids: [], listed_at: new Date().toISOString(),
    window_start: new Date().toISOString(), exhausted: true, source: 'test' }, true)), 'TARGET_MISMATCH');
});
