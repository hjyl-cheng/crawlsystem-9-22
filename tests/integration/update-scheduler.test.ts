import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { CONTRACT_VERSION, CLOCK_NAMES, UpdateLimitsSchema, type Domain, type Plan, type Principal, type Submission } from '@crawlsystem/contracts';
import { fixtureChannel, fixtureVideo } from '@crawlsystem/contracts/fixtures';
import { stableSubmissionId, submissionHash } from '@crawlsystem/contracts/hash';
import { prepareDatabase } from './database-ready.ts';

const pool = createPool();
before(async () => { await prepareDatabase(pool); });
after(async () => { await pool.end(); });
const model = JSON.parse(readFileSync(new URL('../../apps/profile-agent/tests/expected-profile.json', import.meta.url), 'utf8'));
function setup(overrides = {}) {
  const workspace_id = `test-updates-${randomUUID()}`;
  const who = (role: Principal['role']): Principal => ({ workspace_id, subject: role, role });
  return { store: new Store(pool, UpdateLimitsSchema.parse(overrides)), op: who('operator'), reader: who('reader'), worker: who('worker') };
}
function submission(plan: Plan, domain: Domain, payload: unknown, key = domain.toLowerCase()): Submission {
  const body = { schema_version: CONTRACT_VERSION, submission_id: stableSubmissionId(plan.plan_id, plan.execution_epoch, domain, key), plan_id: plan.plan_id,
    execution_epoch: plan.execution_epoch, input_hash: plan.input_hash, logical_batch_key: key, domain, payload, domain_complete: true };
  return { ...body, payload_hash: submissionHash(body as never) } as Submission;
}
async function seed(t: ReturnType<typeof setup>, due: Domain[], now = new Date()) {
  const channel = 'UC' + randomUUID().replaceAll('-', '').slice(0, 22), video_id = randomUUID().replaceAll('-', '').slice(0, 11);
  const plan = await t.store.createPlan(t.op, { request_id: randomUUID(), source_mode: 'youtube', channel_id: channel, required_domains: ['ABOUT', 'VIDEO'] } as never);
  const context = await t.store.getInput(t.worker, plan.plan_id);
  assert.equal(context.input.source_mode, 'youtube');
  const about = { ...structuredClone(fixtureChannel), channel_id: channel, channel_url: `https://www.youtube.com/channel/${channel}`, observed_at: now.toISOString() };
  await t.store.apply(t.worker, submission(plan, 'ABOUT', about));
  await t.store.apply(t.worker, { ...submission(plan, 'VIDEO', { kind: 'targets', channel_id: channel, video_ids: [video_id], listed_at: now.toISOString(),
    window_start: new Date(Date.parse(context.input.reference_time) - 90 * 86400000).toISOString(), exhausted: true, source: 'test' }, 'targets'),
    ...(() => { const s = submission(plan, 'VIDEO', { kind: 'targets', channel_id: channel, video_ids: [video_id], listed_at: now.toISOString(), window_start: new Date(Date.parse(context.input.reference_time) - 90 * 86400000).toISOString(), exhausted: true, source: 'test' }, 'targets');
      s.domain_complete = false; s.payload_hash = submissionHash(s); return s; })() });
  await t.store.apply(t.worker, submission(plan, 'VIDEO', { kind: 'videos', items: [{ ...structuredClone(fixtureVideo), channel_id: channel, source_content_id: video_id,
    url: `https://www.youtube.com/watch?v=${video_id}`, observed_at: now.toISOString() }] }, 'videos'));
  // The legacy engine's own clocks are the source; m1.channel_clocks is derived from them. Make the chosen
  // domains due yesterday (UTC) and the others in 30 days in both, as a settlement would write them.
  const today = Date.parse(now.toISOString().slice(0, 10)), day = (offset: number) => new Date(today + offset * 86_400_000).toISOString().slice(0, 10);
  const days = Object.fromEntries(CLOCK_NAMES.map(c => [`${c.toLowerCase()}_due_day`, due.includes(c) ? day(-1) : day(30)]));
  await pool.query('UPDATE m1.channel_feature_state SET clock=clock||$3::jsonb WHERE workspace_id=$1 AND channel_id=$2', [t.op.workspace_id, channel, days]);
  await pool.query(`UPDATE m1.channel_clocks SET due_at=(($3::jsonb->>(lower(clock)||'_due_day'))::date)::timestamp AT TIME ZONE 'UTC',
    last_attempt_at=NULL,last_scheduled_at=NULL WHERE workspace_id=$1 AND channel_id=$2`, [t.op.workspace_id, channel, days]);
  return { channel, about, video_id };
}
const reject = (run: () => Promise<unknown>, code: string) => assert.rejects(run, (e: unknown) => e instanceof StoreError && e.code === code);

test('concurrent scanners create exactly one frozen update per channel for all seven domain combinations', async () => {
  const t = setup({ max_active_plans: 25, max_agent_plans: 25, auto_domains: [...CLOCK_NAMES] }), now = new Date();
  const combinations: Domain[][] = [['ABOUT'], ['VIDEO'], ['AGENT'], ['ABOUT', 'VIDEO'], ['ABOUT', 'AGENT'], ['VIDEO', 'AGENT'], [...CLOCK_NAMES]];
  const seeded = [];
  for (const domains of combinations) seeded.push(await seed(t, domains, now));
  const scans = await Promise.all([t.store.scheduleUpdates(t.op.workspace_id, now), t.store.scheduleUpdates(t.op.workspace_id, now), t.store.scheduleUpdates(t.op.workspace_id, now)]);
  const plans = scans.flat(); assert.equal(plans.length, 7);
  for (const [i, item] of seeded.entries()) {
    const plan = plans.find(p => p.channel_id === item.channel)!;
    assert.equal(plan.plan_kind, 'UPDATE'); assert.deepEqual([...plan.required_domains].sort(), [...combinations[i]!].sort());
    const input = (await t.store.getInput(t.worker, plan.plan_id)).input;
    assert.equal(input.source_mode, 'youtube');
    if (input.source_mode === 'youtube') assert.equal(input.plan_kind, 'UPDATE');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM m1.intents WHERE plan_id=$1', [plan.plan_id])).rows[0]!.n, 1);
    if (plan.required_domains.includes('AGENT') && !plan.required_domains.includes('VIDEO')) {
      // Without VIDEO the Agent reads the stored videos frozen at creation; it still waits for a required About.
      if (input.source_mode === 'youtube') assert.deepEqual(input.agent_video_ids, [item.video_id]);
      if (plan.required_domains.length === 1) {
        const snapshot = await t.store.agentInput(t.worker, plan.plan_id); assert.equal(snapshot.videos[0]!.source_content_id, item.video_id);
        const { diagnostics: _diagnostics, ...profile } = model;
        await t.store.apply(t.worker, submission(plan, 'AGENT', { channel_id: item.channel, input_hash: snapshot.input_hash, ...profile }));
      } else await reject(() => t.store.agentInput(t.worker, plan.plan_id), 'DOMAIN_INCOMPLETE');
    }
  }
  const view = await t.store.updates(t.reader);
  assert.equal(view.summary.managed, 7); assert.equal(view.summary.completed_24h, 1);
  await reject(() => t.store.updates(t.worker), 'FORBIDDEN');
});

test('failed attempts remain due, do not repeat today, and may run again on the next UTC day', async () => {
  const t = setup(), now = new Date(), item = await seed(t, ['ABOUT'], now);
  const [plan] = await t.store.scheduleUpdates(t.op.workspace_id, now); assert.ok(plan);
  const due = (await t.store.getChannel(t.reader, item.channel)).management.clocks.find(c => c.clock === 'ABOUT')!.due_at;
  await t.store.cancel(t.op, plan.plan_id, { command_id: randomUUID(), expected_version: plan.version });
  assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id, now), []);
  assert.equal((await t.store.getChannel(t.reader, item.channel)).management.clocks.find(c => c.clock === 'ABOUT')!.due_at, due);
  assert.equal((await t.store.updates(t.reader)).page.items[0]!.waiting_reason, 'attempted_today');
  const next = await t.store.scheduleUpdates(t.op.workspace_id, new Date(now.getTime() + 86400000));
  assert.equal(next.length, 1); assert.deepEqual(next[0]!.required_domains, ['ABOUT']);
});

test('admission keeps work due at capacity or quota limits, then resumes; paused channels are excluded', async () => {
  const t = setup({ max_active_plans: 1, api_daily_limit: 4 }), now = new Date();
  const first = await seed(t, ['ABOUT'], now), second = await seed(t, ['ABOUT'], now);
  assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id, now), []);
  assert.equal((await t.store.updates(t.reader)).summary.waiting.find(r => r.reason === 'api_quota')!.channels, 2);
  const resumed = new Store(pool, UpdateLimitsSchema.parse({ max_active_plans: 1 }));
  const [plan] = await resumed.scheduleUpdates(t.op.workspace_id, now); assert.ok(plan);
  const other = [first, second].find(c => c.channel !== plan.channel_id)!;
  assert.equal((await resumed.updates(t.reader)).page.items.find(c => c.channel_id === other.channel)!.waiting_reason, 'concurrency');
  await reject(() => resumed.createPlan(t.op, { request_id: randomUUID(), source_mode: 'youtube', channel_id: plan.channel_id, required_domains: ['ABOUT'] } as never), 'CONFLICT');
  await resumed.cancel(t.op, plan.plan_id, { command_id: randomUUID(), expected_version: plan.version });
  assert.equal((await resumed.scheduleUpdates(t.op.workspace_id, now)).length, 1);
  const m = (await resumed.getChannel(t.reader, plan.channel_id)).management;
  await resumed.manageChannel(t.op, plan.channel_id, { action: 'pause', expected_version: m.version });
  assert.equal((await resumed.updates(t.reader)).summary.managed, 1);
});

test('request permits are shared, idempotent, bounded, and unused reservations are released on settlement', async () => {
  const t = setup({ api_daily_limit: 5 }), now = new Date(); await seed(t, ['ABOUT'], now);
  const [plan] = await t.store.scheduleUpdates(t.op.workspace_id, now); assert.ok(plan);
  const body = { request_id: randomUUID(), plan_id: plan.plan_id, execution_epoch: plan.execution_epoch, input_hash: plan.input_hash };
  const permits = await Promise.all([t.store.dataApiPermit(t.worker, body), t.store.dataApiPermit(t.worker, body)]);
  assert.ok(permits.every(p => p.granted && p.used_units === 1));
  await reject(() => t.store.dataApiPermit(t.reader, body), 'FORBIDDEN');
  await reject(() => t.store.dataApiPermit(t.worker, { ...body, request_id: randomUUID(), execution_epoch: 2 }), 'STALE_EXECUTION');
  for (let i = 0; i < 4; i++) assert.equal((await t.store.dataApiPermit(t.worker, { ...body, request_id: randomUUID() })).granted, true);
  assert.equal((await t.store.dataApiPermit(t.worker, { ...body, request_id: randomUUID() })).granted, false);
  assert.equal((await t.store.updates(t.reader)).summary.api_used_units, 5);
  await t.store.cancel(t.op, plan.plan_id, { command_id: randomUUID(), expected_version: plan.version });
  assert.equal((await t.store.updates(t.reader)).summary.api_reserved_units, 0);
});

test('manual updates require operator/version checks and replay one identity without admitting duplicate work', async () => {
  const t = setup(), item = await seed(t, ['ABOUT']);
  const command = { request_id: randomUUID(), expected_version: 1, domains: ['ABOUT'] as Domain[] };
  await reject(() => t.store.updateChannel(t.reader, item.channel, command), 'FORBIDDEN');
  await reject(() => t.store.updateChannel(t.op, item.channel, { ...command, expected_version: 0 }), 'CONFLICT');
  const [a, b] = await Promise.all([t.store.updateChannel(t.op, item.channel, command), t.store.updateChannel(t.op, item.channel, command)]);
  assert.equal(a.plan_id, b.plan_id);
  await reject(() => t.store.updateChannel(t.op, item.channel, { ...command, domains: ['VIDEO'] }), 'CONFLICT');
  await reject(() => t.store.updateChannel(t.op, item.channel, { ...command, request_id: randomUUID() }), 'CONFLICT');
});

test('by default About and Video are updated by themselves; a due Agent waits for a manual update', async () => {
  const t = setup(), now = new Date();
  const all = await seed(t, ['ABOUT', 'VIDEO', 'AGENT'], now), agentOnly = await seed(t, ['AGENT'], now);
  const plans = await t.store.scheduleUpdates(t.op.workspace_id, now);
  assert.deepEqual(plans.map(p => [p.channel_id, p.required_domains]), [[all.channel, ['ABOUT', 'VIDEO']]], 'never the Agent');
  const waiting = (await t.store.updates(t.reader)).page.items.find(c => c.channel_id === agentOnly.channel)!;
  assert.deepEqual([waiting.state, waiting.waiting_reason, waiting.due_domains], ['due', 'manual_only', ['AGENT']]);
  assert.deepEqual((await t.store.getChannel(t.reader, agentOnly.channel)).management.auto_domains, ['ABOUT', 'VIDEO']);
  const version = (await t.store.getChannel(t.reader, agentOnly.channel)).management.version;
  const manual = await t.store.updateChannel(t.op, agentOnly.channel, { request_id: randomUUID(), expected_version: version });
  assert.deepEqual(manual.required_domains, ['AGENT'], 'a manual update takes what is due');
  const off = setup({ enabled: false });
  assert.deepEqual((await off.store.getChannel(t.reader, all.channel)).management.auto_domains, [], 'nothing is automatic while the scheduler is off');
});
