import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { prepareDatabase } from './database-ready.ts';
import { fixtureChannel, fixtureVideo } from '@crawlsystem/contracts/fixtures';
import { stableSubmissionId, submissionHash } from '@crawlsystem/contracts/hash';
import { CONTRACT_VERSION, type AgentResult, type Domain, type Plan, type Principal, type Submission, type VideoFacts, type VideoUnavailable, type YoutubeFrozenInput } from '@crawlsystem/contracts';

const pool = createPool(), store = new Store(pool);
before(async () => { await prepareDatabase(pool); });
after(async () => { await pool.end(); });

const channelId = () => 'UC' + randomUUID().replaceAll('-', '').slice(0, 22);
const videoId = () => randomUUID().replaceAll('-', '').slice(0, 11);
function people() {
  const workspace_id = `test-yt-${randomUUID()}`;
  return { operator: { workspace_id, subject: 'op', role: 'operator' } as Principal, worker: { workspace_id, subject: 'w', role: 'worker' } as Principal };
}
async function plan(domains?: Domain[], scope?: Record<string, number>) {
  const p = people(), channel = channelId();
  const created = await store.createPlan(p.operator, { request_id: randomUUID(), source_mode: 'youtube', channel_id: channel, ...(domains ? { required_domains: domains } : {}), ...(scope ? { scope } : {}) } as never);
  const input = (await store.getInput(p.worker, created.plan_id)).input as YoutubeFrozenInput;
  return { ...p, plan: created, channel, input };
}
function submit(p: Plan, domain: Domain, key: string, payload: unknown, domain_complete: boolean): Submission {
  const body = { schema_version: CONTRACT_VERSION, submission_id: stableSubmissionId(p.plan_id, p.execution_epoch, domain, key), plan_id: p.plan_id,
    execution_epoch: p.execution_epoch, input_hash: p.input_hash, logical_batch_key: key, domain_complete, domain, payload };
  return { ...body, payload_hash: submissionHash(body as never) } as Submission;
}
const windowStart = (input: YoutubeFrozenInput) => new Date(Date.parse(input.reference_time) - input.scope.max_age_days * 86_400_000).toISOString();
const manifest = (input: YoutubeFrozenInput, ids: string[]) => ({ kind: 'targets', channel_id: input.channel_id, video_ids: ids, listed_at: new Date().toISOString(), window_start: windowStart(input), exhausted: true, source: 'test' });
const about = (channel: string) => ({ ...structuredClone(fixtureChannel), channel_id: channel, channel_url: `https://www.youtube.com/channel/${channel}`, source: 'test:youtube' });
const video = (channel: string, id: string): VideoFacts => ({ ...structuredClone(fixtureVideo), channel_id: channel, source_content_id: id, url: `https://www.youtube.com/watch?v=${id}` });
const unavailable = (channel: string, id: string): VideoUnavailable => ({ channel_id: channel, source_content_id: id, unavailable: true, access_status: 'private', reason: 'Video is private', source: 'test', observed_at: new Date().toISOString() });
const rejects = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, (e: unknown) => e instanceof StoreError && e.code === code);
const agentFacts = (channel: string, input_hash: string): AgentResult => {
  const fact = <T>(value: T) => ({ value, source: 'test-model', confidence: 'medium' as const, evidence: [], source_urls: [], reason: null });
  return { channel_id: channel, input_hash, model_version: 'test-model-1', taxonomy_version: 'v2', observed_at: new Date().toISOString(), facts: {
    country: fact('US'), creator_gender: fact('male' as const), creator_age_range: fact(30), creator_language: fact('en'),
    audience_region: fact([{ region: 'US', percentage: 60 }, { region: 'Other', percentage: 40 }]), audience_language: fact([{ language: 'en', percentage: 100 }]),
    audience_age_gender: fact((['18-24','25-34','35-44','45-54','55-64','65+'] as const).map((age_range, i) => ({ age_range, male: i === 0 ? 50 : 5, female: i === 0 ? 25 : 0 }))),
    active_subscriber_ratio: fact(12), channel_tags: fact({ tags: Array.from({ length: 10 }, (_, i) => `tag${i}`), top_5_distribution: [{ tag: 'tag0', percentage: 50 }, { tag: 'Other', percentage: 50 }] }),
    channel_categories: fact({ level_1: 'Gaming', level_2: ['Action'] }) } } as AgentResult;
};

test('YouTube plans freeze the channel and default scope and need ABOUT, VIDEO and AGENT', async () => {
  const t = await plan();
  assert.equal(t.plan.source_mode, 'youtube'); assert.equal(t.plan.fixture_id, null); assert.equal(t.plan.channel_id, t.channel);
  assert.deepEqual(t.plan.required_domains, ['ABOUT', 'VIDEO', 'AGENT']);
  assert.deepEqual(t.input.scope, { video_limit: 30, max_age_days: 90, comments_per_video: 20, comment_sort: 'TOP_COMMENTS' });
  assert.equal((await store.getInput(t.worker, t.plan.plan_id)).video_targets, undefined, 'targets are unknown until listed');
  const p = people();
  await assert.rejects(store.createPlan(p.operator, { request_id: randomUUID(), source_mode: 'youtube', channel_id: '@handle' } as never));
  await assert.rejects(store.createPlan(p.operator, { request_id: randomUUID(), source_mode: 'youtube', channel_id: channelId(), required_domains: ['AGENT'] } as never));
});
test('VIDEO targets are frozen once, inside the scope, and every target must be settled', async () => {
  const t = await plan(['VIDEO'], { video_limit: 2 });
  const [a, b] = [videoId(), videoId()];
  await rejects(() => store.apply(t.worker, submit(t.plan, 'VIDEO', 'video:batch:0', { kind: 'videos', items: [video(t.channel, a)] }, false)), 'TARGET_MISMATCH');
  await rejects(() => store.apply(t.worker, submit(t.plan, 'VIDEO', 'video:targets', manifest(t.input, [a, b, videoId()]), false)), 'TARGET_MISMATCH');
  await rejects(() => store.apply(t.worker, submit(t.plan, 'VIDEO', 'video:targets', { ...manifest(t.input, [a]), window_start: new Date().toISOString() }, false)), 'TARGET_MISMATCH');
  const frozen = submit(t.plan, 'VIDEO', 'video:targets', manifest(t.input, [a, b]), false);
  const receipt = await store.apply(t.worker, frozen);
  assert.deepEqual(await store.apply(t.worker, frozen), receipt, 'the same manifest replays its receipt');
  await rejects(() => store.apply(t.worker, submit(t.plan, 'VIDEO', 'video:targets:again', manifest(t.input, [a]), false)), 'CONFLICT');
  assert.deepEqual((await store.getInput(t.worker, t.plan.plan_id)).video_targets, [a, b]);
  await rejects(() => store.apply(t.worker, submit(t.plan, 'VIDEO', 'video:batch:x', { kind: 'videos', items: [video(t.channel, videoId())] }, false)), 'TARGET_MISMATCH');
  await rejects(() => store.apply(t.worker, submit(t.plan, 'VIDEO', 'video:batch:0', { kind: 'videos', items: [video(t.channel, a)] }, true)), 'DOMAIN_INCOMPLETE');
  await store.apply(t.worker, submit(t.plan, 'VIDEO', 'video:batch:0', { kind: 'videos', items: [video(t.channel, a), unavailable(t.channel, b)] }, true));
  const done = await store.getInput(t.worker, t.plan.plan_id);
  assert.equal(done.plan.status, 'COMPLETED'); assert.equal(done.domains[0]!.state, 'APPLIED');
});
test('an empty listing is a legal, complete VIDEO result', async () => {
  const t = await plan(['VIDEO']);
  await store.apply(t.worker, submit(t.plan, 'VIDEO', 'video:targets', { ...manifest(t.input, []), exhausted: true }, true));
  assert.equal((await store.getInput(t.worker, t.plan.plan_id)).plan.status, 'COMPLETED');
});
test('AGENT needs ABOUT and VIDEO, reads a snapshot without unavailable videos, and rejects a stale input', async () => {
  const t = await plan();
  const [a, b] = [videoId(), videoId()];
  await rejects(() => store.agentInput(t.worker, t.plan.plan_id), 'DOMAIN_INCOMPLETE');
  await store.apply(t.worker, submit(t.plan, 'ABOUT', 'about:channel', about(t.channel), true));
  await store.apply(t.worker, submit(t.plan, 'VIDEO', 'video:targets', manifest(t.input, [a, b]), false));
  await store.apply(t.worker, submit(t.plan, 'VIDEO', 'video:batch:0', { kind: 'videos', items: [video(t.channel, a), unavailable(t.channel, b)] }, true));
  assert.equal((await store.getInput(t.worker, t.plan.plan_id)).plan.status, 'RUNNING', 'a real plan does not wait on its Agent');
  const snapshot = await store.agentInput(t.worker, t.plan.plan_id);
  assert.deepEqual(snapshot.videos.map(v => v.source_content_id), [a]);
  await rejects(() => store.apply(t.worker, submit(t.plan, 'AGENT', 'agent:profile', agentFacts(t.channel, `sha256:${'0'.repeat(64)}`), true)), 'INPUT_MISMATCH');
  // Facts changed after the snapshot was read (e.g. a newer plan wrote the video): the old result is refused.
  await pool.query(`UPDATE crawl_data.videos SET data=jsonb_set(data,'{title}','"changed"') WHERE workspace_id=$1 AND video_id=$2`, [t.worker.workspace_id, a]);
  await rejects(() => store.apply(t.worker, submit(t.plan, 'AGENT', 'agent:profile', agentFacts(t.channel, snapshot.input_hash), true)), 'INPUT_MISMATCH');
  const fresh = await store.agentInput(t.worker, t.plan.plan_id);
  await store.apply(t.worker, submit(t.plan, 'AGENT', 'agent:profile:2', agentFacts(t.channel, fresh.input_hash), true));
  const done = await store.getInput(t.worker, t.plan.plan_id);
  assert.equal(done.plan.status, 'COMPLETED');
  const channel = await store.getChannel({ ...t.operator, role: 'reader' }, t.channel);
  assert.equal(channel.source_mode, 'youtube'); assert.equal(channel.agent?.input_hash, fresh.input_hash);
  assert.equal(channel.videos.length, 2, 'the unavailable target is kept as an explicit marker');
});
test('fixture plans keep their frozen sample path and still cannot accept Agent results', async () => {
  const p = people();
  const created = await store.createPlan(p.operator, { request_id: randomUUID(), fixture_id: 'channel-basic-v1', required_domains: ['ABOUT', 'VIDEO', 'AGENT'] });
  assert.equal(created.source_mode, 'fixture'); assert.equal(created.fixture_id, 'channel-basic-v1');
  await rejects(() => store.agentInput(p.worker, created.plan_id), 'DOMAIN_NOT_REQUIRED');
});
