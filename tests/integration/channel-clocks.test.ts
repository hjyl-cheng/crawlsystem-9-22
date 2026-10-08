import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { refreshReferences } from '@crawlsystem/store/feature-clocks';
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
const about = (channel: string) => ({ ...structuredClone(fixtureChannel), channel_id: channel, channel_url: `https://www.youtube.com/channel/${channel}`, source: 'test:youtube', observed_at: new Date().toISOString() });
const video = (channel: string, id: string, publishedDaysAgo: number): VideoFacts => ({ ...structuredClone(fixtureVideo), channel_id: channel, source_content_id: id,
  url: `https://www.youtube.com/watch?v=${id}`, published_at: new Date(Date.now() - publishedDaysAgo * 86_400_000).toISOString() });
const rejects = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, (e: unknown) => e instanceof StoreError && e.code === code);
async function start(p: People, channel: string, domains: Domain[]) {
  const plan = await store.createPlan(p.operator, { request_id: randomUUID(), source_mode: 'youtube', channel_id: channel, required_domains: domains } as never);
  return { plan, input: (await store.getInput(p.worker, plan.plan_id)).input as YoutubeFrozenInput };
}
/** Runs a real plan to COMPLETED for the given domains (ABOUT and/or VIDEO; VIDEO collects one video, new unless given). */
async function complete(p: People, channel: string, domains: Domain[], publishedDaysAgo = 200, id = videoId()) {
  const { plan, input } = await start(p, channel, domains);
  if (domains.includes('ABOUT')) await store.apply(p.worker, submit(plan, 'ABOUT', 'about:channel', about(channel), true));
  if (domains.includes('VIDEO')) {
    const windowStart = new Date(Date.parse(input.reference_time) - input.scope.max_age_days * 86_400_000).toISOString();
    await store.apply(p.worker, submit(plan, 'VIDEO', 'video:targets', { kind: 'targets', channel_id: channel, video_ids: [id], listed_at: new Date().toISOString(), window_start: windowStart, exhausted: true, source: 'test' }, false));
    await store.apply(p.worker, submit(plan, 'VIDEO', 'video:batch:0', { kind: 'videos', items: [video(channel, id, publishedDaysAgo)] }, true));
  }
  assert.equal((await store.getInput(p.worker, plan.plan_id)).plan.status, 'COMPLETED');
  return plan;
}
const clocks = async (p: People, channel: string) => Object.fromEntries((await store.getChannel(p.reader, channel)).management.clocks.map(c => [c.clock, c])) as Record<string, ChannelClock>;
/** Whole UTC days from the day of `base` to the due day (clocks are due at 00:00 UTC). */
const daysFrom = (due: string, base: string) => (Date.parse(due) - Date.parse(base.slice(0, 10))) / 86_400_000;
const featureState = async (p: People, channel: string) => (await pool.query('SELECT state,applied FROM m1.channel_feature_state WHERE workspace_id=$1 AND channel_id=$2', [p.operator.workspace_id, channel])).rows[0];
const FALLBACK = ['subscriber_growth_reference_fallback', 'view_growth_reference_fallback'];

test('the first completed real plan puts the channel under management with the legacy first clocks', async () => {
  const p = people(), channel = channelId();
  const { plan: cancelled } = await start(p, channel, ['ABOUT']);
  await store.cancel(p.operator, cancelled.plan_id, { command_id: randomUUID(), expected_version: cancelled.version });
  assert.equal((await store.getChannel(p.reader, channel)).management.state, null, 'a plan that did not complete does not manage the channel');
  const plan = await complete(p, channel, ['ABOUT']);
  const detail = await store.getChannel(p.reader, channel);
  assert.equal(detail.management.state, 'managed'); assert.equal(detail.management.version, 1);
  const c = await clocks(p, channel), observed = detail.about!.observed_at;
  assert.deepEqual(Object.keys(c), ['ABOUT', 'VIDEO', 'AGENT']);
  assert.deepEqual(['ABOUT', 'VIDEO', 'AGENT'].map(k => daysFrom(c[k]!.due_at, observed)), [7, 7, 180], 'About from the policy; Video and Agent at their baselines');
  assert.deepEqual(c.ABOUT!.reasons, [...FALLBACK, 'about_baseline', 'about_cold_start_cadence_fallback'], 'no publishing cadence known yet, no growth ranking yet');
  assert.deepEqual(c.VIDEO!.reasons, ['clock_bootstrap_baseline']); assert.deepEqual(c.AGENT!.reasons, ['clock_bootstrap_baseline']);
  assert.ok(Object.values(c).every(k => k.retry_at === null && k.next_due_at === k.due_at && k.policy_version === 'v16-rule-7'));
  assert.equal(c.ABOUT!.last_plan_id, plan.plan_id); assert.ok(c.ABOUT!.last_success_at);
  assert.equal(c.VIDEO!.last_success_at, null, 'only collected parts record a success');
  assert.deepEqual((await featureState(p, channel)).applied, { about: 1, video: 0, agent: 0 });
  const listed = (await store.listChannels(p.reader)).items.find(i => i.channel_id === channel)!;
  assert.equal(listed.management_state, 'managed'); assert.equal(listed.next_due_at, c.ABOUT!.due_at);
});
test('a domain that was not applied leaves its clock due; the next success moves it by the policy', async () => {
  const p = people(), channel = channelId();
  await complete(p, channel, ['ABOUT']);
  const before = await clocks(p, channel);
  const { plan } = await start(p, channel, ['ABOUT']);
  await store.cancel(p.operator, plan.plan_id, { command_id: randomUUID(), expected_version: plan.version });
  let c = await clocks(p, channel);
  assert.deepEqual([c.ABOUT!.due_at, c.ABOUT!.interval_days, c.ABOUT!.reasons, c.ABOUT!.retry_at], [before.ABOUT!.due_at, before.ABOUT!.interval_days, before.ABOUT!.reasons, null], 'a failure changes no clock');
  assert.equal(c.ABOUT!.last_plan_id, plan.plan_id); assert.ok(c.ABOUT!.last_attempt_at! > c.ABOUT!.last_success_at!);
  assert.equal(c.ABOUT!.last_success_at, before.ABOUT!.last_success_at);
  assert.deepEqual(c.AGENT, before.AGENT, 'domains the plan did not require are untouched');
  assert.deepEqual((await featureState(p, channel)).applied, { about: 2, video: 0, agent: 0 }, 'the failure still counts as an About observation');
  const next = await complete(p, channel, ['ABOUT']);
  c = await clocks(p, channel);
  assert.equal(c.ABOUT!.last_plan_id, next.plan_id);
  assert.deepEqual(c.ABOUT!.reasons, [...FALLBACK, 'about_priority_medium'], 'an unchanged mid-ranked channel is checked weekly');
  assert.equal(daysFrom(c.ABOUT!.due_at, (await store.getChannel(p.reader, channel)).about!.observed_at), 7);
});
test('a Video run counts only videos no earlier plan applied; Recent Sampling is skipped so Video stays within 7 days', async () => {
  const p = people(), channel = channelId(), first = videoId();
  await complete(p, channel, ['ABOUT', 'VIDEO'], 10, first);
  let c = await clocks(p, channel), state = (await featureState(p, channel)).state;
  assert.equal(c.VIDEO!.interval_days, 7);
  assert.deepEqual(c.VIDEO!.reasons, ['publish_interval_fallback', 'discovery_baseline', 'recent_sampling_skipped', 'video_interval_constrained_by_discovery']);
  assert.equal(state.new_video_empty_runs, 0); assert.ok(state.last_publish_at);
  await complete(p, channel, ['VIDEO'], 10, first);
  state = (await featureState(p, channel)).state;
  assert.equal(state.new_video_empty_runs, 1, 'the same video again is not a new one');
  await complete(p, channel, ['VIDEO'], -1 / 1440);
  state = (await featureState(p, channel)).state;
  assert.equal(state.new_video_empty_runs, 0, 'a video published since the last run is new');
  assert.equal(state.recent_publish_interval_days.length, 1); assert.ok(Math.abs(state.recent_publish_interval_days[0] - 10) < 0.01, 'about 10 days between the two uploads');
  c = await clocks(p, channel);
  assert.ok(c.VIDEO!.interval_days >= 3 && c.VIDEO!.interval_days <= 7);
  assert.deepEqual((await featureState(p, channel)).applied, { about: 1, video: 3, agent: 0 });
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
  assert.ok(again.clocks.length === 3 && again.clocks.every(k => k.retry_at === null));
  assert.deepEqual(again.clocks.map(k => k.reasons.at(-1)), ['about_cold_start_cadence_fallback', 'clock_bootstrap_baseline', 'clock_bootstrap_baseline'], 'started over from the stored facts');
  const facts = await store.getChannel(p.reader, channel);
  assert.equal(again.clocks.find(k => k.clock === 'ABOUT')!.last_success_at, new Date(facts.about!.observed_at).toISOString(), 'facts collected before count as the last success');
  assert.equal(again.clocks.find(k => k.clock === 'AGENT')!.last_success_at, null, 'never profiled');
  const fixture = await store.createPlan(p.operator, { request_id: randomUUID(), fixture_id: 'channel-basic-v1', required_domains: ['ABOUT'] });
  await rejects(() => store.manageChannel(p.operator, fixture.channel_id, { action: 'manage', expected_version: 0 }), 'INVALID_REQUEST');
  const fresh = channelId();
  await start(p, fresh, ['ABOUT']);
  await rejects(() => store.manageChannel(p.operator, fresh, { action: 'manage', expected_version: 0 }), 'DOMAIN_INCOMPLETE');
  await rejects(() => store.manageChannel(p.operator, channelId(), { action: 'manage', expected_version: 0 }), 'NOT_FOUND');
});
test('operators pin an interval per domain and return it to the policy; lists and counts follow', async () => {
  const p = people(), channel = channelId();
  await complete(p, channel, ['ABOUT']);
  const pin = (clock: string, interval_days: number | null, expected_version: number, who = p.operator) => store.overrideClock(who, channel, { clock, interval_days, expected_version });
  await rejects(() => pin('ABOUT', 1, 1, p.reader), 'FORBIDDEN');
  await rejects(() => pin('ABOUT', 1, 0), 'CONFLICT');
  await assert.rejects(() => pin('ABOUT', 4, 1), 'only the offered intervals');
  let m = await pin('ABOUT', 1, 1);
  let about = m.clocks.find(c => c.clock === 'ABOUT')!;
  assert.equal(m.version, 2); assert.equal(about.override_days, 1); assert.equal(about.interval_days, 1); assert.deepEqual(about.reasons, ['manual_override']);
  assert.equal(daysFrom(about.due_at, about.last_success_at!), 1, 'due the pinned interval after the last success');
  await complete(p, channel, ['ABOUT']);
  about = (await clocks(p, channel)).ABOUT!;
  assert.equal(about.interval_days, 1); assert.deepEqual(about.reasons, ['manual_override'], 'a success keeps the pinned interval');
  assert.equal(daysFrom(about.due_at, about.last_success_at!), 1);
  const { plan } = await start(p, channel, ['ABOUT']);
  await store.cancel(p.operator, plan.plan_id, { command_id: randomUUID(), expected_version: plan.version });
  const failed = (await clocks(p, channel)).ABOUT!;
  assert.deepEqual([failed.due_at, failed.retry_at], [about.due_at, null], 'a failure moves no clock, pinned or not');
  m = await pin('ABOUT', null, 2);
  about = m.clocks.find(c => c.clock === 'ABOUT')!;
  assert.equal(about.override_days, null); assert.equal(about.interval_days, 7); assert.deepEqual(about.reasons, [...FALLBACK, 'about_priority_medium'], 'the policy decision comes back');
  const listed = (await store.listChannels(p.reader)).items.find(i => i.channel_id === channel)!;
  assert.deepEqual(listed.clocks.map(c => [c.clock, c.interval_days, c.override_days]), [['ABOUT', 7, null], ['VIDEO', 7, null], ['AGENT', 180, null]]);
  let counts = (await store.completeness(p.reader)).management;
  assert.deepEqual(counts, { managed: 1, paused: 0, overdue: 0 });
  await pool.query(`UPDATE m1.channel_clocks SET due_at=clock_timestamp()-interval '1 hour' WHERE workspace_id=$1 AND channel_id=$2 AND clock='AGENT'`, [p.operator.workspace_id, channel]);
  counts = (await store.completeness(p.reader)).management;
  assert.deepEqual(counts, { managed: 1, paused: 0, overdue: 1 });
  await store.manageChannel(p.operator, channel, { action: 'pause', expected_version: 3 });
  assert.deepEqual((await store.completeness(p.reader)).management, { managed: 0, paused: 1, overdue: 0 }, 'a paused channel is not overdue');
  assert.equal((await pin('VIDEO', 14, 4)).clocks.find(c => c.clock === 'VIDEO')!.override_days, 14, 'paused channels can still be configured');
  await store.manageChannel(p.operator, channel, { action: 'remove', expected_version: 5 });
  await rejects(() => pin('ABOUT', 1, 6), 'CONFLICT');
});
test('once a day every channel is ranked against the others; later decisions use the ranking', async () => {
  const p = people(), channel = channelId();
  await complete(p, channel, ['ABOUT']); await complete(p, channel, ['ABOUT']);
  const done = await refreshReferences(pool, p.operator.workspace_id);
  assert.ok(done && done.distributions === 5 && done.channels === 1, JSON.stringify(done));
  assert.equal(await refreshReferences(pool, p.operator.workspace_id), null, 'once per day');
  const state = (await featureState(p, channel)).state;
  assert.equal(state.subscriber_size_percentile, 0.5, 'a single channel sits in the middle');
  assert.equal(state.reference_distribution_version, `${new Date().toISOString().slice(0, 10)}:v16-empirical-1`);
  await complete(p, channel, ['ABOUT']);
  assert.ok(!(await clocks(p, channel)).ABOUT!.reasons.some(r => FALLBACK.includes(r)), 'growth is ranked now');
});
