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
test('Activity continues the stored plan trace on every Control/Ingest call after reading input', async () => {
  const { InMemorySpanExporter } = await import('@opentelemetry/sdk-trace-base');
  const { RequestTracing } = await import('@crawlsystem/http/tracing');
  const { value, ref } = fixtureContext(), backend = fixtureApi(value), traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  value.trace_context = `00-${traceId}-00f067aa0ba902b7-01`;
  const headers: (string | null)[] = [];
  const fetcher: typeof fetch = async (url, init) => { headers.push(new Headers(init?.headers).get('traceparent')); return backend.fetcher(url, init); };
  const exporter = new InMemorySpanExporter(), tracing = new RequestTracing('worker-test', () => {}, 0, exporter);
  const api = new ExecutionApi({ controlUrl: 'http://localhost:1', ingestUrl: 'http://localhost:2', token: async () => 'test', fetch: fetcher });
  const activities = createActivities({ api, workerId: 'worker-test', workspaceId: ref.workspace_id, enter: () => () => {}, log: () => {}, tracing });
  const env = new MockActivityEnvironment({ activityType: 'executeFixture' } as never);
  const descriptor = await run(env, () => activities.loadExecution(ref));
  assert.equal((await run(env, () => activities.executeFixture(ref, descriptor))).status, 'COMPLETED');
  await tracing.flush();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 2, 'one span per Activity execution');
  for (const span of spans) { assert.equal(span.spanContext().traceId, traceId); assert.equal(span.parentSpanContext?.spanId, '00f067aa0ba902b7'); }
  // Each Activity's first input read precedes the known context; every later call carries its span.
  const traced = headers.filter(header => header !== null);
  assert.equal(headers.length - traced.length, 2);
  assert.ok(traced.length > 3 && traced.every(header => header.startsWith(`00-${traceId}-`)));
  await tracing.close();
});
