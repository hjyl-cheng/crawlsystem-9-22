import test from 'node:test';
import assert from 'node:assert/strict';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ExecutionApi } from '@crawlsystem/execution-client/http';
import { createActivities, verifyContext } from '../src/activities.ts';
import { fixtureContext, fixtureApi } from './support.ts';

function run<T>(env: MockActivityEnvironment, fn: () => Promise<T>): Promise<T> { return env.run<[], T, typeof fn>(fn); }

function setup(domains: Parameters<typeof fixtureContext>[0] = ['ABOUT','VIDEO']) {
  const { value, ref } = fixtureContext(domains), backend = fixtureApi(value);
  const api = new ExecutionApi({ controlUrl: 'http://localhost:1', ingestUrl: 'http://localhost:2', token: async () => 'test', fetch: backend.fetcher });
  let running = 0; const logs: unknown[] = [];
  const activities = createActivities({ api, workerId: 'worker-test', workspaceId: ref.workspace_id,
    enter: () => { running++; return () => { running--; }; }, log: record => logs.push(record) });
  return { value, ref, backend, activities, logs, running: () => running, env: new MockActivityEnvironment() };
}
test('SDK Activity executes shared fixture and duplicate attempt returns Store result', async () => {
  const f = setup(); f.backend.faults.dropFirstResponse = true;
  const descriptor = await run(f.env, () => f.activities.loadExecution(f.ref));
  assert.equal((await run(f.env, () => f.activities.executeFixture(f.ref, descriptor))).status, 'COMPLETED');
  assert.equal(f.value.receipts.length, 2); assert.equal(f.backend.submissions.length, 2); assert.equal(f.running(), 0);
  assert.equal((await run(new MockActivityEnvironment({ attempt: 2 }), () => f.activities.executeFixture(f.ref, descriptor))).status, 'COMPLETED');
  assert.equal(f.backend.submissions.length, 2);
});
test('required AGENT remains WAITING with no fabricated submission', async () => {
  const f = setup(['ABOUT','VIDEO','AGENT']);
  const descriptor = await run(f.env, () => f.activities.loadExecution(f.ref));
  assert.equal((await run(f.env, () => f.activities.executeFixture(f.ref, descriptor))).status, 'WAITING');
  assert.equal(f.value.domains.find(d => d.domain === 'AGENT')!.state, 'PENDING');
  assert.equal(f.backend.submissions.length, 2);
  assert.equal((await run(f.env, () => f.activities.settleExecution(f.ref, 'BUDGET_EXHAUSTED'))).status, 'FAILED');
});
test('cancelled late write is non-retryable and cannot override Store cancellation', async () => {
  const f = setup(); f.backend.faults.cancelBeforeSubmit = true;
  const descriptor = await run(f.env, () => f.activities.loadExecution(f.ref));
  await assert.rejects(run(f.env, () => f.activities.executeFixture(f.ref, descriptor)), (e: unknown) => e instanceof Error && 'nonRetryable' in e && e.nonRetryable === true);
  assert.equal(f.value.receipts.length, 0); assert.equal(f.backend.submissions.length, 1);
  assert.equal((await run(f.env, () => f.activities.settleExecution(f.ref, 'INTERNAL_ERROR'))).status, 'CANCELLED');
  assert.equal(f.running(), 0);
});
test('frozen payload changes and active stale epoch fail verification', () => {
  const f = setup(); f.value.input.sample.about.title = 'changed'; assert.throws(() => verifyContext(f.ref, f.value, f.ref.workspace_id));
  const next = setup(); next.value.plan.execution_epoch++; assert.throws(() => verifyContext(next.ref, next.value, next.ref.workspace_id));
});
test('transient Ingest failure is classified and correlated without resetting input', async () => {
  const f = setup(); f.backend.faults.unavailable = true;
  const descriptor = await run(f.env, () => f.activities.loadExecution(f.ref));
  await assert.rejects(run(f.env, () => f.activities.executeFixture(f.ref, descriptor)), (e: unknown) => e instanceof Error && 'nonRetryable' in e && e.nonRetryable === false);
  assert.equal(f.backend.submissions.length, 2); assert.equal(f.running(), 0);
  assert.ok(f.backend.events.some(event => event.kind === 'ERROR' && event.error_code === 'UNAVAILABLE'));
  f.backend.faults.unavailable = false;
  assert.equal((await run(new MockActivityEnvironment({ attempt: 2 }), () => f.activities.executeFixture(f.ref, descriptor))).status, 'COMPLETED');
  assert.deepEqual(f.backend.submissions[0], f.backend.submissions[2]);
});
