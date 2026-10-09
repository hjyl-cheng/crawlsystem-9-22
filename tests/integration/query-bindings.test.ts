import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { upsertBindings } from '@crawlsystem/store/discovery';
import type { Principal } from '@crawlsystem/contracts';
import { prepareDatabase } from './database-ready.ts';

/** Plan step B2 (first part): query terms bound to a country and a business category (24.8 §5, Q-01, Q-10..Q-13, Q-15, Q-24). */
const pool = createPool(), store = new Store(pool);
before(async () => { await prepareDatabase(pool); });
after(async () => { await pool.end(); });
function people() {
  const workspace_id = `test-query-${randomUUID()}`;
  const as = (role: Principal['role']): Principal => ({ workspace_id, subject: `${role}-1`, role });
  return { op: as('operator'), reader: as('reader') };
}
const reject = (run: () => Promise<unknown>, code: string) => assert.rejects(run, (e: unknown) => e instanceof StoreError && e.code === code);

test('a query is one binding per normalised text, country and category; repeats only add sources', async () => {
  const p = people();
  const a = await store.createQuery(p.op, { text: '  Rock   com Atitude ', country: 'BR', language: 'pt', category: 'Music' });
  assert.deepEqual([a.text, a.state, a.cadence, a.source_count], ['rock com atitude', 'BOOTSTRAP', null, 1], 'new and due, no cadence yet');
  assert.ok(a.next_run_at && Date.parse(a.next_run_at) <= Date.now());
  const again = await store.createQuery(p.op, { text: 'ROCK COM ATITUDE', country: 'BR', language: 'pt', category: 'Music' });
  assert.equal(again.binding_id, a.binding_id, 'same binding');
  const otherCategory = await store.createQuery(p.op, { text: 'rock com atitude', country: 'BR', language: 'pt', category: 'Casual Vlogs' });
  const otherCountry = await store.createQuery(p.op, { text: 'rock com atitude', country: 'PT', language: 'pt', category: 'Music' });
  assert.equal(new Set([a.binding_id, otherCategory.binding_id, otherCountry.binding_id]).size, 3);
  await assert.rejects(() => store.createQuery(p.op, { text: 'x', country: 'BR', language: 'pt', category: 'Cooking' }), 'only the 19 categories');
  await reject(() => store.createQuery(p.reader, { text: 'x', country: 'BR', language: 'pt', category: 'Music' }), 'FORBIDDEN');
});

test('operators disable, enable and override the cadence with a version check and an audit trail', async () => {
  const p = people();
  const q = await store.createQuery(p.op, { text: 'receitas fit', country: 'BR', language: 'pt', category: 'Food' });
  await reject(() => store.queryCommand(p.op, q.binding_id, { action: 'disable', reason: 'off topic', expected_version: 9 }), 'CONFLICT');
  const off = await store.queryCommand(p.op, q.binding_id, { action: 'disable', reason: 'off topic', expected_version: 1 });
  assert.deepEqual([off.state, off.next_run_at, off.version], ['DISABLED', null, 2]);
  await store.createQuery(p.op, { text: 'receitas fit', country: 'BR', language: 'pt', category: 'Food' });
  assert.equal((await store.queries(p.reader, 20, 0, { state: 'DISABLED' })).items.length, 1, 'a new source does not lift a manual disable (Q-15)');
  const on = await store.queryCommand(p.op, q.binding_id, { action: 'enable', expected_version: 2 });
  assert.deepEqual([on.state, on.version], ['BOOTSTRAP', 3], 'never succeeded: back to its first run');
  const weekly = await store.queryCommand(p.op, q.binding_id, { action: 'set_cadence', cadence: 'WEEK', reason: 'seasonal topic', expected_version: 3 });
  assert.equal(weekly.cadence_override, 'WEEK');
  const audit = (await pool.query('SELECT version,actor,action,detail FROM m1.query_audit WHERE binding_id=$1 ORDER BY version', [q.binding_id])).rows;
  assert.deepEqual(audit.map(r => [r.version, r.actor, r.action, r.detail.reason ?? null]), [[2, 'operator-1', 'disable', 'off topic'], [3, 'operator-1', 'enable', null], [4, 'operator-1', 'set_cadence', 'seasonal topic']]);
});

test('bulk upserts bind thousands at once, keep every source, and summaries count by state, category and country', async () => {
  const p = people();
  const rows = Array.from({ length: 2500 }, (_, i) => ({ text: `termo ${i % 2000}`, country: 'BR', language: 'pt', category: i % 2 ? 'Music' : 'Gaming',
    priority: i, source_type: 'AUTO_TAG', source_ref: `legacy:crawlsystem:query_terms:${i}` }));
  const result = await upsertBindings(pool, p.op.workspace_id, rows);
  assert.equal(result.created, 2000, '2,000 distinct texts; a repeated text keeps its category, so it adds only a source');
  const total = (await pool.query('SELECT count(*)::int n FROM m1.query_bindings WHERE workspace_id=$1', [p.op.workspace_id])).rows[0]!.n;
  assert.equal(total, result.created, 'every new (text, country, category) once');
  const again = await upsertBindings(pool, p.op.workspace_id, rows);
  assert.equal(again.created, 0, 'idempotent');
  const summary = await store.querySummary(p.reader);
  assert.equal(summary.total, total); assert.equal(summary.by_state.BOOTSTRAP, total); assert.equal(summary.due, total);
  assert.deepEqual(summary.by_country, [{ country: 'BR', bindings: total }]);
  const found = await store.queries(p.reader, 5, 0, { search: 'termo 19', category: 'Music' });
  assert.ok(found.items.length > 0 && found.items.every(b => b.text.includes('termo 19') && b.category === 'Music'));
  assert.ok(found.items[0]!.sources.length >= 1 && found.items[0]!.sources[0]!.type === 'AUTO_TAG');
});
