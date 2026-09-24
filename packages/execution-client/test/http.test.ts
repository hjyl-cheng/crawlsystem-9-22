import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureSubmission } from '@crawlsystem/contracts/hash';
import { ExecutionApi, ExecutionApiError, workloadTokenSource } from '../src/http.ts';
import { fixtureApi, fixtureContext } from '../../../apps/execution-worker/test/support.ts';

function setup() {
  const { value } = fixtureContext(); const backend = fixtureApi(value);
  const api = new ExecutionApi({ controlUrl: 'http://localhost:1', ingestUrl: 'http://localhost:2', token: async () => 'test', fetch: backend.fetcher });
  return { value, api, backend, submission: fixtureSubmission(value, 'ABOUT') };
}
test('lost APPLIED response is recovered without posting a second submission', async () => {
  const { value, api, backend, submission } = setup(); backend.faults.dropFirstResponse = true;
  const receipt = await api.submit(submission);
  assert.equal(receipt.submission_id, submission.submission_id); assert.equal(backend.submissions.length, 1);
  assert.deepEqual(await api.submit(submission), receipt); assert.equal(value.receipts.length, 1); assert.equal(backend.submissions.length, 1);
});
test('unavailable receipt lookup is not absence and prevents new writes', async () => {
  const { api, backend, submission } = setup(); backend.faults.receiptUnavailable = true;
  await assert.rejects(api.submit(submission), (e: unknown) => e instanceof ExecutionApiError && e.code === 'UNAVAILABLE');
  assert.equal(backend.submissions.length, 0);
});
test('Ingest unavailable has at most two POST attempts; authorization has one', async () => {
  const { api, backend, submission } = setup(); backend.faults.unavailable = true;
  await assert.rejects(api.submit(submission)); assert.equal(backend.submissions.length, 2);
  backend.faults.unavailable = false; backend.faults.forbid = true;
  await assert.rejects(api.submit(submission), (e: unknown) => e instanceof ExecutionApiError && !e.retryable && e.code === 'FORBIDDEN');
  assert.equal(backend.submissions.length, 3);
});
test('deadline and cancellation prevent new requests', async () => {
  const { api, backend, submission } = setup();
  await assert.rejects(api.submit(submission, { deadline: Date.now() - 1 }), (e: unknown) => e instanceof ExecutionApiError && e.code === 'BUDGET_EXHAUSTED');
  await assert.rejects(api.submit(submission, { signal: AbortSignal.abort() }));
  assert.equal(backend.submissions.length, 0);
});
test('receipt content identity must match the original submission', async () => {
  const { api, backend, submission, value } = setup(); await api.submit(submission);
  value.receipts[0]!.payload_hash = `sha256:${'f'.repeat(64)}`;
  await assert.rejects(api.submit(submission), (e: unknown) => e instanceof ExecutionApiError && e.code === 'CONFLICT');
  assert.equal(backend.submissions.length, 1);
});
test('invalid or oversized response is rejected and native diagnostics are redacted', async () => {
  for (const fetcher of [async () => Response.json({ bad: true }), async () => new Response('x'.repeat(2_097_153))]) {
    const api = new ExecutionApi({ controlUrl: 'http://localhost:1', ingestUrl: 'http://localhost:2', token: async () => 'secret', fetch: fetcher });
    await assert.rejects(api.input('id'), (e: unknown) => e instanceof ExecutionApiError && e.code === 'INVALID_REQUEST');
  }
  const api = new ExecutionApi({ controlUrl: 'http://localhost:1', ingestUrl: 'http://localhost:2', token: async () => 'secret', fetch: async () => { throw new Error('Bearer secret'); } });
  await assert.rejects(api.input('id', { attempts: 1 }), (e: unknown) => e instanceof Error && !e.message.includes('secret') && !e.cause);
});

function tokenServer(subject = 'worker-0', expires_in = 600) {
  const calls: string[] = [];
  let fail = false;
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls.push(`${url.pathname} ${(init.headers as Record<string, string>).authorization}`);
    if (fail) throw new Error('connect ECONNREFUSED');
    return Response.json({ token: `api-token-${calls.length}-padding-padding`, subject, workspace_id: 'w', role: 'worker', server_id: 'a2', expires_in });
  }) as typeof fetch;
  return { calls, fetcher, fail: () => { fail = true; } };
}
test('workload token is exchanged once, shared, and renewed at half-life', async () => {
  let now = 0; const server = tokenServer();
  const token = workloadTokenSource({ controlUrl: 'http://control.control.svc.cluster.local:18100', workerId: 'worker-0', identityToken: async () => 'sa-token\n', fetch: server.fetcher, now: () => now });
  const [a, b] = await Promise.all([token(), token()]);
  assert.equal(a, b); assert.deepEqual(server.calls, ['/v1/workload/token Bearer sa-token']);
  now = 299_000; assert.equal(await token(), a); assert.equal(server.calls.length, 1);
  now = 300_000; assert.notEqual(await token(), a); assert.equal(server.calls.length, 2);
});
test('a Control outage keeps a still-valid token, then fails once it expires', async () => {
  let now = 0; const server = tokenServer();
  const token = workloadTokenSource({ controlUrl: 'http://localhost:1', workerId: 'worker-0', identityToken: async () => 'sa', fetch: server.fetcher, now: () => now });
  const first = await token(); server.fail();
  now = 400_000; assert.equal(await token(), first);
  now = 600_000; await assert.rejects(token(), (e: unknown) => e instanceof ExecutionApiError && e.code === 'UNAVAILABLE' && e.retryable);
});
test('a token for another Pod identity is refused', async () => {
  const server = tokenServer('worker-1');
  const token = workloadTokenSource({ controlUrl: 'http://localhost:1', workerId: 'worker-0', identityToken: async () => 'sa', fetch: server.fetcher });
  await assert.rejects(token(), (e: unknown) => e instanceof ExecutionApiError && e.code === 'FORBIDDEN');
});
