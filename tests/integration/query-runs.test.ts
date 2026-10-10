import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { upsertBindings } from '@crawlsystem/store/discovery';
import { DiscoveryLimitsSchema, UpdateLimitsSchema, type DiscoveryLimits, type Principal } from '@crawlsystem/contracts';
import { prepareDatabase } from './database-ready.ts';

/** Plan step B2 (second part): search execution under a lease (24.8 §5.2, Q-02..Q-09, Q-20..Q-23). */
const pool = createPool();
before(async () => { await prepareDatabase(pool); });
after(async () => { await pool.end(); });
const channel = (n: number) => `UC${String(n).padStart(22, '0')}`;
const video = (n: number) => `v${String(n).padStart(10, '0')}`;
function setup(limits: Partial<DiscoveryLimits> = {}, apiDailyLimit = 10_000) {
  const workspace_id = `test-runs-${randomUUID()}`;
  const as = (role: Principal['role'], subject: string): Principal => ({ workspace_id, subject, role });
  const store = new Store(pool, UpdateLimitsSchema.parse({ api_daily_limit: apiDailyLimit }), DiscoveryLimitsSchema.parse({ api_reserve: 0, ...limits }));
  // Preserve coverage of frozen pre-R4 runs; current web/About policy has its own integration suite.
  const claim=store.claimQueryRun.bind(store);
  store.claimQueryRun=async principal=>{
    const result=await claim(principal);
    if(result.run && result.run.params.policy_version!=='query-clock-1') {
      result.run.params.policy_version='query-clock-1';
      await pool.query('UPDATE control.query_runs SET params=$2 WHERE run_id=$1',[result.run.run_id,result.run.params]);
    }
    return result;
  };
  return { store, workspace_id, worker: as('worker', 'worker-a'), other: as('worker', 'worker-b'), op: as('operator', 'operator-1'), reader: as('reader', 'reader-1') };
}
const bind = (workspace: string, rows: { text: string; category: string; priority?: number; country?: string }[]) =>
  upsertBindings(pool, workspace, rows.map(r => ({ country: 'BR', language: 'pt', source_type: 'MANUAL', source_ref: 'test', ...r })));
const reject = (run: () => Promise<unknown>, code: string) => assert.rejects(run, (e: unknown) => e instanceof StoreError && e.code === code);
const page = (attempt: number, n: number, channels: number[]) => ({ attempt, page: n, items: channels.map(c => ({ video_id: video(c * 10 + n), channel_id: channel(c) })) });
const facts = (id: number, subscribers: number | null, hidden = false) => ({ channel_id: channel(id), title: `Channel ${id}`, country: 'BR', subscriber_count: subscribers, hidden_subscribers: hidden, video_count: 10, view_count: 1000 });

test('a claim freezes the search of the fairest due binding, one open run per binding', async () => {
  const t = setup();
  await bind(t.workspace_id, [{ text: 'musica a', category: 'Music', priority: 9 }, { text: 'musica b', category: 'Music', priority: 5 }, { text: 'receita', category: 'Food', priority: 1 }]);
  const first = await t.store.claimQueryRun(t.worker);
  assert.deepEqual([first.run?.params.text, first.run?.params.window, first.run?.params.sort, first.run?.params.language, first.run?.attempt], ['musica a', 'THIS_YEAR', 'popularity', 'pt', 1]);
  const second = await t.store.claimQueryRun(t.other);
  assert.equal(second.run?.params.category, 'Food', 'the category searched least today goes next (Q-23)');
  const third = await t.store.claimQueryRun(t.worker);
  assert.deepEqual([third.run, third.idle_reason], [null, 'concurrency'], 'two active runs at most');
  await t.store.queryRunFail(t.worker, first.run!.run_id, { attempt: 1, reason: 'network', retryable: true });
  const fourth = await t.store.claimQueryRun(t.worker);
  assert.equal(fourth.run?.params.text, 'musica b', 'a binding with a run waiting to retry gets no second run');
});

test('pages report channels new to the system; completion makes candidates and settles the clock once', async () => {
  const t = setup();
  await bind(t.workspace_id, [{ text: 'rock', category: 'Music' }]);
  await pool.query(`INSERT INTO control.channel_imports(workspace_id,channel_id,requested_by,request_id) VALUES($1,$2,'test',$3)`, [t.workspace_id, channel(9), randomUUID()]);
  const { run } = await t.store.claimQueryRun(t.worker);
  const p1 = await t.store.queryRunPage(t.worker, run!.run_id, page(1, 1, [1, 2, 3, 9, 1]));
  assert.deepEqual(p1, { new_channel_ids: [channel(1), channel(2), channel(3)], continue: true }, 'a queued import is known; three new reads on');
  const p2 = await t.store.queryRunPage(t.worker, run!.run_id, page(1, 2, [3, 4]));
  assert.deepEqual(p2, { new_channel_ids: [channel(4)], continue: false });
  await reject(() => t.store.queryRunComplete(t.worker, run!.run_id, { attempt: 1, pages: 2, stop_reason: 'low_yield', channels: [facts(1, 5000)], missing_channel_ids: [] }), 'INVALID_REQUEST');
  const body = { attempt: 1, pages: 2, stop_reason: 'low_yield' as const, channels: [facts(1, 5000), facts(2, 999), facts(3, null, true)], missing_channel_ids: [channel(4)] };
  await reject(() => t.store.queryRunComplete(t.other, run!.run_id, body), 'STALE_EXECUTION');
  const result = await t.store.queryRunComplete(t.worker, run!.run_id, body);
  assert.deepEqual([result.new_channels, result.qualified_new, result.binding.state, result.binding.cadence], [4, 1, 'ACTIVE', 'MONTH'], 'one qualified: monthly');
  assert.ok(Math.abs(Date.parse(result.binding.next_run_at!) - Date.now() - 30 * 86_400_000) < 3 * 86_400_000);
  assert.deepEqual(await t.store.queryRunComplete(t.worker, run!.run_id, body), result, 'a lost acknowledgement replays (Q-09)');
  const candidates = (await pool.query('SELECT channel_id,state,reason,subscriber_count FROM control.channel_candidates WHERE workspace_id=$1 ORDER BY channel_id', [t.workspace_id])).rows;
  assert.deepEqual(candidates.map(c => [c.channel_id, c.state, c.reason]), [[channel(1), 'QUALIFIED', null], [channel(2), 'UNQUALIFIED', 'below_threshold'], [channel(3), 'UNQUALIFIED', 'hidden_subscribers'], [channel(4), 'UNAVAILABLE', 'not_found']]);
  const summary = await t.store.querySummary(t.reader);
  assert.deepEqual([summary.runs.succeeded_today, summary.runs.new_channels_today, summary.runs.qualified_today, summary.candidates.qualified], [1, 4, 1, 1]);
  const [listed] = (await t.store.queries(t.reader, 1, 0, {})).items;
  assert.deepEqual([listed!.last_run?.state, listed!.last_run?.qualified_new, listed!.state], ['SUCCEEDED', 1, 'ACTIVE']);
});

test('a later binding finds the same channels known; three qualified make a binding weekly', async () => {
  const t = setup();
  await bind(t.workspace_id, [{ text: 'a', category: 'Music', priority: 2 }, { text: 'b', category: 'Music', priority: 1 }]);
  const one = (await t.store.claimQueryRun(t.worker)).run!;
  await t.store.queryRunPage(t.worker, one.run_id, page(1, 1, [1, 2, 3]));
  const done = await t.store.queryRunComplete(t.worker, one.run_id, { attempt: 1, pages: 1, stop_reason: 'list_end', channels: [facts(1, 2000), facts(2, 3000), facts(3, 4000)], missing_channel_ids: [] });
  assert.deepEqual([done.binding.cadence, done.qualified_new], ['WEEK', 3]);
  const two = (await t.store.claimQueryRun(t.worker)).run!;
  assert.equal(two.params.text, 'b');
  assert.deepEqual(await t.store.queryRunPage(t.worker, two.run_id, page(1, 1, [1, 2, 3])), { new_channel_ids: [], continue: false });
  const empty = await t.store.queryRunComplete(t.worker, two.run_id, { attempt: 1, pages: 1, stop_reason: 'low_yield', channels: [], missing_channel_ids: [] });
  assert.deepEqual([empty.new_channels, empty.binding.state, empty.binding.cadence], [0, 'ACTIVE', 'MONTH'], 'an empty run counts towards cool-down');
  const lineage = (await pool.query('SELECT count(*)::int AS n FROM control.query_run_channels WHERE channel_id=$1 AND run_id=ANY($2::uuid[])', [channel(1), [one.run_id, two.run_id]])).rows[0]!.n;
  assert.equal(lineage, 2, 'both runs keep the channel in their lineage (BC-16)');
});

test('failures retry the same run with its frozen parameters; repeated failures give up for a day', async () => {
  const t = setup();
  await bind(t.workspace_id, [{ text: 'falha', category: 'Tech' }]);
  const first = (await t.store.claimQueryRun(t.worker)).run!;
  const failed = await t.store.queryRunFail(t.worker, first.run_id, { attempt: 1, reason: 'blocked', retryable: true });
  assert.equal(failed.state, 'PENDING');
  await pool.query('UPDATE control.query_runs SET retry_at=now() WHERE run_id=$1', [first.run_id]);
  const again = (await t.store.claimQueryRun(t.other)).run!;
  assert.deepEqual([again.run_id, again.attempt, again.params], [first.run_id, 2, first.params], 'same run, same parameters (Q-07)');
  await reject(() => t.store.queryRunPage(t.worker, first.run_id, page(1, 1, [1])), 'STALE_EXECUTION');
  // A lease that runs out is a failed attempt too.
  await pool.query(`UPDATE control.query_runs SET lease_expires_at=now()-interval '1 second' WHERE run_id=$1`, [first.run_id]);
  const third = await t.store.claimQueryRun(t.worker);
  assert.equal(third.run, null, 'the expired attempt waits for its retry time');
  const row = (await pool.query('SELECT state,failures,last_error FROM control.query_runs WHERE run_id=$1', [first.run_id])).rows[0]!;
  assert.deepEqual([row.state, row.failures, row.last_error], ['PENDING', 2, 'lease_expired']);
  // Attempt 3 stops on the Data API budget (not counted); attempts 4..6 fail and the fifth counted failure gives up.
  for (let attempt = 3; attempt <= 6; attempt++) {
    await pool.query('UPDATE control.query_runs SET retry_at=now() WHERE run_id=$1', [first.run_id]);
    const claim = (await t.store.claimQueryRun(t.worker)).run!;
    assert.equal(claim.attempt, attempt);
    await t.store.queryRunFail(t.worker, claim.run_id, { attempt, reason: attempt === 3 ? 'quota' : 'parse', retryable: true });
  }
  const end = (await pool.query('SELECT r.state,r.failures,b.retry_at,b.state AS binding_state,b.last_success_at FROM control.query_runs r JOIN control.query_bindings b USING (binding_id) WHERE r.run_id=$1', [first.run_id])).rows[0]!;
  assert.deepEqual([end.state, end.failures, end.binding_state, end.last_success_at], ['FAILED', 5, 'BOOTSTRAP', null], 'a quota stop is not counted; the clock never advanced (Q-08)');
  assert.ok(new Date(end.retry_at).getTime() > Date.now() + 23 * 3_600_000);
  assert.equal((await t.store.claimQueryRun(t.worker)).idle_reason, 'no_due');
});

test('a frozen legacy retry qualifies discoveries missing from refreshed search pages', async () => {
  const t=setup();await bind(t.workspace_id,[{text:'changing search results',category:'Gaming'}]);
  const first=(await t.store.claimQueryRun(t.worker)).run!;
  await t.store.queryRunPage(t.worker,first.run_id,page(1,1,[1,2]));
  await t.store.queryRunFail(t.worker,first.run_id,{attempt:1,reason:'parse',retryable:true});
  await pool.query('UPDATE control.query_runs SET retry_at=now() WHERE run_id=$1',[first.run_id]);
  const retry=(await t.store.claimQueryRun(t.worker)).run!;
  const refreshed=await t.store.queryRunPage(t.worker,retry.run_id,page(retry.attempt,1,[1,3]));
  assert.deepEqual(refreshed.new_channel_ids,[channel(1),channel(3)]);
  assert.equal(refreshed.continue,false,'pagination still uses this page only');
  assert.deepEqual(refreshed.qualification_channel_ids,[channel(1),channel(2),channel(3)]);
  const completed=await t.store.queryRunComplete(t.worker,retry.run_id,{attempt:retry.attempt,pages:1,stop_reason:'low_yield',
    channels:[facts(1,2000),facts(2,2000),facts(3,2000)],missing_channel_ids:[]});
  assert.equal(completed.new_channels,3);assert.equal(completed.qualified_new,3);assert.equal(completed.binding.cadence,'WEEK');
});

test('limits pause searching: switched off, daily runs, backlog and the Data API reserve', async () => {
  assert.equal((await setup({ enabled: false }).store.claimQueryRun(setup().worker)).idle_reason, 'disabled');
  const daily = setup({ daily_run_limit: 1 });
  await bind(daily.workspace_id, [{ text: 'x', category: 'Food' }, { text: 'y', category: 'Food' }]);
  const run = (await daily.store.claimQueryRun(daily.worker)).run!;
  await daily.store.queryRunComplete(daily.worker, run.run_id, { attempt: 1, pages: 0, stop_reason: 'list_end', channels: [], missing_channel_ids: [] });
  assert.equal((await daily.store.claimQueryRun(daily.worker)).idle_reason, 'daily_runs');
  const backlog = setup({ backlog_limit: 1 });
  await bind(backlog.workspace_id, [{ text: 'z', category: 'Food' }]);
  await pool.query(`INSERT INTO control.channel_imports(workspace_id,channel_id,requested_by,request_id) VALUES($1,$2,'test',$3)`, [backlog.workspace_id, channel(1), randomUUID()]);
  assert.equal((await backlog.store.claimQueryRun(backlog.worker)).idle_reason, 'backlog', 'queued collections slow discovery down (Q-22)');
  const quota = setup({ api_reserve: 2 }, 3);
  await bind(quota.workspace_id, [{ text: 'q', category: 'Food' }]);
  const held = (await quota.store.claimQueryRun(quota.worker)).run!;
  const permit = await quota.store.queryRunPermit(quota.worker, held.run_id, { request_id: randomUUID(), attempt: 1, endpoint: 'channels' });
  assert.deepEqual([permit.granted, permit.used_units], [true, 1]);
  const refused = await quota.store.queryRunPermit(quota.worker, held.run_id, { request_id: randomUUID(), attempt: 1, endpoint: 'channels' });
  assert.equal(refused.granted, false, 'two units stay free for collection');
  const owner = (await pool.query('SELECT run_id,plan_id FROM control.data_api_permits WHERE workspace_id=$1', [quota.workspace_id])).rows;
  assert.deepEqual(owner, [{ run_id: held.run_id, plan_id: null }]);
  await quota.store.queryRunFail(quota.worker, held.run_id, { attempt: 1, reason: 'quota', retryable: true });
  await pool.query('UPDATE control.query_runs SET retry_at=now() WHERE run_id=$1',[held.run_id]);
  assert.equal((await quota.store.claimQueryRun(quota.worker)).idle_reason, 'api_quota');
});

test('disabling a binding cancels its open run; the Worker is told to stop', async () => {
  const t = setup();
  await bind(t.workspace_id, [{ text: 'parar', category: 'Travel' }]);
  const run = (await t.store.claimQueryRun(t.worker)).run!;
  await t.store.queryCommand(t.op, run.binding_id, { action: 'disable', reason: 'irrelevant', expected_version: 1 });
  assert.deepEqual(await t.store.queryRunHeartbeat(t.worker, run.run_id, { attempt: 1 }), { active: false, lease_expires_at: null });
  await reject(() => t.store.queryRunPage(t.worker, run.run_id, page(1, 1, [1])), 'STALE_EXECUTION');
  assert.equal((await t.store.queryRunFail(t.worker, run.run_id, { attempt: 1, reason: 'interrupted', retryable: true })).state, 'CANCELLED');
  await reject(() => t.store.claimQueryRun(t.op), 'FORBIDDEN');
});
