import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { upsertBindings } from '@crawlsystem/store/discovery';
import { DiscoveryLimitsSchema, UpdateLimitsSchema, type DiscoveryLimits, type Principal } from '@crawlsystem/contracts';
import { prepareDatabase } from './database-ready.ts';

/** Plan step B3: candidate channels, admitted automatically (fair across categories) or decided by an operator. */
const pool = createPool();
before(async () => { await prepareDatabase(pool); });
after(async () => { await pool.end(); });
const channel = (n: number) => `UC${String(n).padStart(22, '0')}`;
function setup(limits: Partial<DiscoveryLimits> = {}) {
  const workspace_id = `test-cand-${randomUUID()}`;
  const as = (role: Principal['role'], subject: string): Principal => ({ workspace_id, subject, role });
  const store = new Store(pool, UpdateLimitsSchema.parse({}), DiscoveryLimitsSchema.parse({ api_reserve: 0, max_active_runs: 5, ...limits }));
  return { store, workspace_id, worker: as('worker', 'worker-a'), op: as('operator', 'operator-1'), reader: as('reader', 'reader-1') };
}
type Setup = ReturnType<typeof setup>;
/** One search of `text` in `category` that found these channels with these subscriber counts. */
async function found(t: Setup, text: string, category: string, channels: [number, number][]) {
  await upsertBindings(pool, t.workspace_id, [{ text, country: 'BR', language: 'pt', category, source_type: 'MANUAL', source_ref: 'test' }]);
  const run = (await t.store.claimQueryRun(t.worker)).run!;
  assert.equal(run.params.text, text);
  const page = await t.store.queryRunPage(t.worker, run.run_id, { attempt: 1, page: 1, items: channels.map(([n]) => ({ video_id: `v${String(n).padStart(10, '0')}`, channel_id: channel(n) })) });
  // As the Worker does: only the channels the page reported new are qualified and reported.
  await t.store.queryRunComplete(t.worker, run.run_id, { attempt: 1, pages: 1, stop_reason: 'list_end', missing_channel_ids: [],
    channels: channels.filter(([n]) => page.new_channel_ids.includes(channel(n))).map(([n, subs]) => ({ channel_id: channel(n), title: `Canal ${n}`, country: 'BR', subscriber_count: subs, hidden_subscribers: false, video_count: 5, view_count: 100 })) });
}
const reject = (run: () => Promise<unknown>, code: string) => assert.rejects(run, (e: unknown) => e instanceof StoreError && e.code === code);
const queued = async (workspace: string) => (await pool.query(`SELECT channel_id,requested_by FROM m1.channel_imports WHERE workspace_id=$1 AND state='queued' ORDER BY channel_id`, [workspace])).rows;

test('qualified candidates join the import queue a few at a time, taking turns across categories', async () => {
  const t = setup({ import_buffer: 3 });
  await found(t, 'musica', 'Music', [[1, 90_000], [2, 80_000], [3, 70_000], [4, 500]]);
  await found(t, 'receita', 'Food', [[5, 2_000], [6, 1_500]]);
  assert.deepEqual((await t.store.admitCandidates(t.workspace_id)).sort(), [channel(1), channel(2), channel(5)], 'best of each category first, then the next best');
  assert.deepEqual((await queued(t.workspace_id)).map(r => [r.channel_id, r.requested_by]), [[channel(1), 'discovery'], [channel(2), 'discovery'], [channel(5), 'discovery']]);
  assert.deepEqual(await t.store.admitCandidates(t.workspace_id), [], 'the queue is full');
  await pool.query(`UPDATE m1.channel_imports SET state='planned' WHERE workspace_id=$1 AND channel_id=$2`, [t.workspace_id, channel(1)]);
  assert.deepEqual(await t.store.admitCandidates(t.workspace_id), [channel(6)], 'one place freed: Food takes its turn before Music\'s third');
  const summary = await t.store.candidateSummary(t.reader);
  assert.deepEqual([summary.by_state.ADMITTED, summary.by_state.QUALIFIED, summary.by_state.UNQUALIFIED, summary.admitted_today, summary.import_queue], [4, 1, 1, 4, 3]);
  assert.deepEqual(summary.by_category, [{ category: 'Music', qualified: 1, admitted: 2 }, { category: 'Food', qualified: 0, admitted: 2 }]);
  assert.deepEqual(await setup({ auto_admit: false }).store.admitCandidates(t.workspace_id), [], 'automatic admission can be switched off');
});

test('operators reject candidates, admit below the threshold, and withdraw an admission only before collection starts', async () => {
  const t = setup({ auto_admit: false });
  await found(t, 'viagem', 'Travel', [[1, 5_000], [2, 300], [3, 9_000]]);
  const [first] = (await t.store.candidates(t.reader, 20, 0, { state: 'QUALIFIED' })).items.filter(c => c.channel_id === channel(1));
  assert.deepEqual([first!.found_by.text, first!.found_by.category, first!.found_count, first!.import_state], ['viagem', 'Travel', 1, null]);
  await reject(() => t.store.candidateCommand(t.op, channel(1), { action: 'reject', reason: 'not Brazilian', expected_version: 9 }), 'CONFLICT');
  const rejected = await t.store.candidateCommand(t.op, channel(1), { action: 'reject', reason: 'not Brazilian', expected_version: 1 });
  assert.deepEqual([rejected.state, rejected.decided_by, rejected.decision_reason], ['REJECTED', 'operator-1', 'not Brazilian']);
  const low = await t.store.candidateCommand(t.op, channel(2), { action: 'admit', reason: 'niche but relevant', expected_version: 1 });
  assert.deepEqual([low.state, low.import_state], ['ADMITTED', 'queued'], 'an operator may admit below the threshold');
  const withdrawn = await t.store.candidateCommand(t.op, channel(2), { action: 'reject', reason: 'changed my mind', expected_version: 2 });
  assert.deepEqual([withdrawn.state, withdrawn.import_state], ['REJECTED', null], 'the queued import is withdrawn');
  const started = await t.store.candidateCommand(t.op, channel(3), { action: 'admit', expected_version: 1 });
  await pool.query(`UPDATE m1.channel_imports SET state='planned' WHERE workspace_id=$1 AND channel_id=$2`, [t.workspace_id, channel(3)]);
  await reject(() => t.store.candidateCommand(t.op, channel(3), { action: 'reject', reason: 'late', expected_version: started.version }), 'CONFLICT');
  await reject(() => t.store.candidateCommand(t.reader, channel(3), { action: 'reject', reason: 'x', expected_version: started.version }), 'FORBIDDEN');
  await reject(() => t.store.candidateCommand(t.op, channel(3), { action: 'admit', expected_version: started.version }), 'CONFLICT');
  await pool.query(`UPDATE m1.channel_imports SET state='failed' WHERE workspace_id=$1 AND channel_id=$2`, [t.workspace_id, channel(3)]);
  const retried = await t.store.candidateCommand(t.op, channel(3), { action: 'admit', reason: 'retry', expected_version: started.version });
  assert.deepEqual([retried.state, retried.import_state], ['ADMITTED', 'queued'], 'a failed first collection is retried by admitting again');
  const search = await t.store.candidates(t.reader, 20, 0, { search: 'canal 3' });
  assert.deepEqual(search.items.map(c => c.channel_id), [channel(3)]);
});

test('a channel found again by another query keeps its first finder and counts both searches', async () => {
  const t = setup({ auto_admit: false });
  await found(t, 'futebol', 'Sports & Outdoors', [[1, 50_000]]);
  await found(t, 'gols', 'Sports & Outdoors', [[1, 50_000]]);
  const [c] = (await t.store.candidates(t.reader, 20, 0, {})).items;
  assert.deepEqual([c!.found_by.text, c!.found_count], ['futebol', 2]);
});
