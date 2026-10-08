import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { prepareDatabase } from './database-ready.ts';
import { fixtureChannel, fixtureVideo } from '@crawlsystem/contracts/fixtures';
import { stableSubmissionId, submissionHash } from '@crawlsystem/contracts/hash';
import { CONTRACT_VERSION, type ChannelClock, type Domain, type Plan, type Principal, type Submission, type VideoFacts, type YoutubeFrozenInput } from '@crawlsystem/contracts';

const pool = createPool(), store = new Store(pool);
before(async () => { await prepareDatabase(pool); });
after(async () => { await pool.end(); });

const channelId = () => 'UC' + randomUUID().replaceAll('-', '').slice(0, 22);
const videoId = () => randomUUID().replaceAll('-', '').slice(0, 11);
function people() {
  const workspace_id = `test-clock-${randomUUID()}`;
  const as = (role: Principal['role']) => ({ workspace_id, subject: role, role }) as Principal;
  return { operator: as('operator'), reader: as('reader'), worker: as('worker') };
}
type People = ReturnType<typeof people>;
function submit(p: Plan, domain: Domain, key: string, payload: unknown, domain_complete: boolean): Submission {
  const body = { schema_version: CONTRACT_VERSION, submission_id: stableSubmissionId(p.plan_id, p.execution_epoch, domain, key), plan_id: p.plan_id,
    execution_epoch: p.execution_epoch, input_hash: p.input_hash, logical_batch_key: key, domain_complete, domain, payload };
  return { ...body, payload_hash: submissionHash(body as never) } as Submission;
}
const about = (channel: string) => ({ ...structuredClone(fixtureChannel), channel_id: channel, channel_url: `https://www.youtube.com/channel/${channel}`, source: 'test:youtube' });
const video = (channel: string, id: string, publishedDaysAgo: number): VideoFacts => ({ ...structuredClone(fixtureVideo), channel_id: channel, source_content_id: id,
  url: `https://www.youtube.com/watch?v=${id}`, published_at: new Date(Date.now() - publishedDaysAgo * 86_400_000).toISOString() });
const rejects = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, (e: unknown) => e instanceof StoreError && e.code === code);
async function start(p: People, channel: string, domains: Domain[]) {
  const plan = await store.createPlan(p.operator, { request_id: randomUUID(), source_mode: 'youtube', channel_id: channel, required_domains: domains } as never);
  return { plan, input: (await store.getInput(p.worker, plan.plan_id)).input as YoutubeFrozenInput };
}
/** Runs a real plan to COMPLETED for the given domains (ABOUT and/or VIDEO). */
async function complete(p: People, channel: string, domains: Domain[], publishedDaysAgo = 200) {
  const { plan, input } = await start(p, channel, domains);
  if (domains.includes('ABOUT')) await store.apply(p.worker, submit(plan, 'ABOUT', 'about:channel', about(channel), true));
  if (domains.includes('VIDEO')) {
    const id = videoId(), windowStart = new Date(Date.parse(input.reference_time) - input.scope.max_age_days * 86_400_000).toISOString();
    await store.apply(p.worker, submit(plan, 'VIDEO', 'video:targets', { kind: 'targets', channel_id: channel, video_ids: [id], listed_at: new Date().toISOString(), window_start: windowStart, exhausted: true, source: 'test' }, false));
    await store.apply(p.worker, submit(plan, 'VIDEO', 'video:batch:0', { kind: 'videos', items: [video(channel, id, publishedDaysAgo)] }, true));
  }
  assert.equal((await store.getInput(p.worker, plan.plan_id)).plan.status, 'COMPLETED');
  return plan;
}
const clocks = async (p: People, channel: string) => Object.fromEntries((await store.getChannel(p.reader, channel)).management.clocks.map(c => [c.clock, c])) as Record<string, ChannelClock>;
const daysFrom = (iso: string, base: string) => Math.round((Date.parse(iso) - Date.parse(base)) / 86_400_000);

test('the first completed real plan puts the channel under management with first-collection clocks', async () => {
  const p = people(), channel = channelId();
  const { plan: cancelled } = await start(p, channel, ['ABOUT']);
  await store.cancel(p.operator, cancelled.plan_id, { command_id: randomUUID(), expected_version: cancelled.version });
  assert.equal((await store.getChannel(p.reader, channel)).management.state, null, 'a plan that did not complete does not manage the channel');
  const plan = await complete(p, channel, ['ABOUT']);
  const detail = await store.getChannel(p.reader, channel);
  assert.equal(detail.management.state, 'managed'); assert.equal(detail.management.version, 1);
  const c = await clocks(p, channel), at = detail.management.changed_at!;
  assert.deepEqual(Object.keys(c), ['ABOUT', 'VIDEO', 'AGENT']);
  assert.deepEqual(['ABOUT', 'VIDEO', 'AGENT'].map(k => daysFrom(c[k]!.due_at, at)), [7, 7, 60]);
  assert.equal(daysFrom(c.VIDEO!.refresh_due_at!, at), 14, 'the recent-video refresh has its own 14-day period');
  assert.equal(c.ABOUT!.refresh_due_at, null); assert.equal(c.AGENT!.refresh_due_at, null);
  assert.ok(Object.values(c).every(k => k.reason === 'first_collection' && k.retry_at === null && k.next_due_at === k.due_at && k.policy_version === 'm3-v1-fixed'));
  assert.equal(c.ABOUT!.last_plan_id, plan.plan_id); assert.ok(c.ABOUT!.last_success_at);
  assert.equal(c.VIDEO!.last_success_at, null, 'only collected parts record a success');
  const listed = (await store.listChannels(p.reader)).items.find(i => i.channel_id === channel)!;
  assert.equal(listed.management_state, 'managed'); assert.equal(listed.next_due_at, c.ABOUT!.due_at);
});
test('a plan that does not complete schedules only retries; the next success restarts the normal period', async () => {
  const p = people(), channel = channelId();
  await complete(p, channel, ['ABOUT']);
  const before = await clocks(p, channel);
  const { plan } = await start(p, channel, ['ABOUT']);
  await store.cancel(p.operator, plan.plan_id, { command_id: randomUUID(), expected_version: plan.version });
  let c = await clocks(p, channel);
  assert.equal(c.ABOUT!.due_at, before.ABOUT!.due_at, 'the normal period does not advance');
  assert.equal(daysFrom(c.ABOUT!.retry_at!, c.ABOUT!.last_attempt_at!), 3); assert.equal(c.ABOUT!.next_due_at, c.ABOUT!.retry_at);
  assert.equal(c.ABOUT!.reason, 'retry_after_failure'); assert.equal(c.ABOUT!.last_plan_id, plan.plan_id);
  assert.equal(c.ABOUT!.last_success_at, before.ABOUT!.last_success_at);
  assert.deepEqual(c.AGENT, before.AGENT, 'domains the plan did not require are untouched');
  const next = await complete(p, channel, ['ABOUT']);
  c = await clocks(p, channel);
  assert.equal(c.ABOUT!.retry_at, null); assert.equal(c.ABOUT!.reason, 'baseline'); assert.equal(c.ABOUT!.last_plan_id, next.plan_id);
  assert.equal(daysFrom(c.ABOUT!.due_at, c.ABOUT!.last_success_at!), 7);
});
test('an applied VIDEO restarts the Video clock and the refresh period; a channel publishing now is checked every 3 days', async () => {
  const p = people(), channel = channelId();
  await complete(p, channel, ['ABOUT', 'VIDEO'], 2);
  assert.equal((await clocks(p, channel)).VIDEO!.interval_days, 7, 'first collection uses the first tiers');
  await complete(p, channel, ['VIDEO'], 2);
  const c = await clocks(p, channel);
  assert.equal(c.VIDEO!.interval_days, 3); assert.equal(c.VIDEO!.reason, 'active_publishing');
  assert.equal(daysFrom(c.VIDEO!.refresh_due_at!, c.VIDEO!.last_success_at!), 14, 'a full-scope Video run also refreshed the recent videos');
  assert.equal(c.ABOUT!.reason, 'first_collection', 'ABOUT was not required');
  const { plan } = await start(p, channel, ['VIDEO']);
  await store.cancel(p.operator, plan.plan_id, { command_id: randomUUID(), expected_version: plan.version });
  assert.equal((await clocks(p, channel)).VIDEO!.refresh_due_at, c.VIDEO!.refresh_due_at, 'an unfinished Video run leaves the refresh period alone');
  const quiet = channelId();
  await complete(p, quiet, ['VIDEO'], 200); await complete(p, quiet, ['VIDEO'], 200);
  assert.equal((await clocks(p, quiet)).VIDEO!.interval_days, 7);
});
test('operators pause, resume, remove and re-manage with a version check; removed channels are left alone', async () => {
  const p = people(), channel = channelId();
  await complete(p, channel, ['ABOUT']);
  const command = (action: string, expected_version: number, who = p.operator) => store.manageChannel(who, channel, { action, expected_version });
  await rejects(() => command('pause', 1, p.reader), 'FORBIDDEN');
  await rejects(() => command('pause', 0), 'CONFLICT');
  await rejects(() => command('resume', 1), 'CONFLICT');
  await rejects(() => command('manage', 1), 'CONFLICT');
  assert.equal((await command('pause', 1)).state, 'paused');
  assert.equal((await store.listChannels(p.reader)).items.find(i => i.channel_id === channel)!.next_due_at, null, 'a paused channel shows no next update');
  assert.equal((await command('resume', 2)).state, 'managed');
  const removed = await command('remove', 3);
  assert.equal(removed.state, 'removed'); assert.deepEqual(removed.clocks, [], 'removed channels show no clocks');
  await complete(p, channel, ['ABOUT']);
  assert.equal((await store.getChannel(p.reader, channel)).management.state, 'removed', 'a later plan does not re-manage it');
  const again = await command('manage', 4);
  assert.equal(again.state, 'managed'); assert.equal(again.version, 5);
  assert.ok(again.clocks.length === 3 && again.clocks.every(k => k.reason === 'manual_manage' && k.retry_at === null));
  const fixture = await store.createPlan(p.operator, { request_id: randomUUID(), fixture_id: 'channel-basic-v1', required_domains: ['ABOUT'] });
  await rejects(() => store.manageChannel(p.operator, fixture.channel_id, { action: 'manage', expected_version: 0 }), 'INVALID_REQUEST');
  const fresh = channelId();
  await start(p, fresh, ['ABOUT']);
  await rejects(() => store.manageChannel(p.operator, fresh, { action: 'manage', expected_version: 0 }), 'DOMAIN_INCOMPLETE');
  await rejects(() => store.manageChannel(p.operator, channelId(), { action: 'manage', expected_version: 0 }), 'NOT_FOUND');
});
