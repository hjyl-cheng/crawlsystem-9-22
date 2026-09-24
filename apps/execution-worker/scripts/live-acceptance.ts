/** Real API/Store/Temporal acceptance. The test driver uses an operator token;
 * worker children receive only API/Temporal configuration, never PG or signing keys. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { Worker, Runtime, DefaultLogger } from '@temporalio/worker';
import { CONTRACT_VERSION, ApiErrorSchema, ChannelDetailSchema, PlanSchema, PlanDetailSchema, type Plan, type Domain, type WorkflowInput, type Submission } from '@crawlsystem/contracts';
import { fixtureSubmission } from '@crawlsystem/contracts/hash';
import { createWorkflowStarter } from '@crawlsystem/execution-client';
import { temporalOptions } from '@crawlsystem/execution-client/config';
import { ExecutionApi } from '@crawlsystem/execution-client/http';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`${key} is required`); return value; };
const output = resolve(process.env.EXECUTION_EVIDENCE_DIR ?? resolve(root, '.runtime/execution-evidence'));
await mkdir(output, { recursive: true, mode: 0o700 });
const operatorToken = (await readFile(required('OPERATOR_TOKEN_FILE'), 'utf8')).trim();
const control = required('CONTROL_API_URL'), ingest = required('INGEST_API_URL');
const api = new ExecutionApi({ controlUrl: control, ingestUrl: ingest, token: () => readFile(required('WORKER_TOKEN_FILE'), 'utf8') });
const session = await api.session();
assert.equal(session.role, 'worker'); assert.equal(session.subject, required('WORKER_ID'));
const temporal = { ...temporalOptions(), taskQueue: `execution-live-${randomUUID()}` };
const starter = await createWorkflowStarter(temporal);
const connection = await Connection.connect({ address: temporal.address, tls: temporal.tls, connectTimeout: '10 seconds' });
const client = new Client({ connection, namespace: temporal.namespace });
Runtime.install({ logger: new DefaultLogger('ERROR') });
const children = new Set<ChildProcess>();
const logs = new Map<ChildProcess, string[]>();
const plans: Plan[] = [];
const evidence: Record<string, unknown> = { contract: CONTRACT_VERSION, namespace: temporal.namespace, task_queue: temporal.taskQueue,
  workspace_id: session.workspace_id, scope: 'real Temporal mTLS + Control/Ingest + PostgreSQL through controlled APIs', checks: [] };
const checks = evidence.checks as string[];
const ref = (plan: Plan): WorkflowInput => ({ schema_version: CONTRACT_VERSION, plan_id: plan.plan_id, workspace_id: plan.workspace_id,
  execution_epoch: plan.execution_epoch, input_hash: plan.input_hash, workflow_id: plan.workflow_id });
async function operator(path: string, body?: unknown) {
  // Retain the exact request/command ID across a bounded transport retry.
  const serialized = body ? JSON.stringify(body) : undefined;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(new URL(path, control), { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
        body: serialized, signal: AbortSignal.timeout(10_000) });
    } catch (error) { if (attempt >= 3) throw error; await delay(1000); continue; }
    const value: unknown = await response.json();
    if (response.ok) return value;
    const parsed = ApiErrorSchema.safeParse(value);
    if (!parsed.success || !parsed.data.error.retryable || attempt >= 3) throw new Error(`Operator API failed with HTTP ${response.status}`);
    await delay(1000);
  }
}
async function create(domains: Domain[] = ['ABOUT','VIDEO']) {
  const plan = PlanSchema.parse(await operator('/v1/plans', { request_id: randomUUID(), fixture_id: 'channel-basic-v1', required_domains: domains }));
  plans.push(plan); return plan;
}
async function waitFor<T>(check: () => Promise<T | false>, label: string, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result !== false) return result; await delay(200); }
  throw new Error(`Timed out: ${label}`);
}
async function detail(id: string) { return PlanDetailSchema.parse(await operator(`/v1/plans/${id}`)); }
function child(script: string, env: NodeJS.ProcessEnv, envFile?: string) {
  const processChild = spawn(process.execPath, [...(envFile ? [`--env-file=${envFile}`] : []), '--import', 'tsx', script], { cwd: root, env, stdio: ['ignore','pipe','pipe'] });
  const lines: string[] = []; logs.set(processChild, lines); children.add(processChild);
  for (const stream of [processChild.stdout!, processChild.stderr!]) stream.on('data', data => { lines.push(String(data)); if (lines.length > 200) lines.shift(); });
  return processChild;
}
async function stop(processChild: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (processChild.exitCode !== null || processChild.signalCode !== null) return;
  const exit = once(processChild, 'exit'); processChild.kill(signal);
  const timer = new AbortController();
  try { await Promise.race([exit, delay(30_000, undefined, { signal: timer.signal }).then(() => { processChild.kill('SIGKILL'); throw new Error('Child drain exceeded 30 seconds'); })]); }
  finally { timer.abort(); }
}

// The proxy forwards real Ingest writes. It can lose a response after commit or hold
// a new write before forwarding; it does not fabricate a receipt or database result.
const blocked = new Set<string>(), seen = new Set<string>(), lost = new Set<string>(), unavailable = new Set<string>();
const posted: Submission[] = [];
const proxy = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 1_048_576) { response.writeHead(413).end(); return; } chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    const submission = JSON.parse(body.toString()) as Submission; posted.push(submission);
    if (submission.domain === 'VIDEO' && blocked.has(submission.plan_id)) {
      seen.add(submission.plan_id);
      while (blocked.has(submission.plan_id) && !response.destroyed) await delay(50);
      if (response.destroyed) return;
    }
    if (unavailable.delete(submission.plan_id)) {
      response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Injected transient outage', retryable: true, correlation_id: 'execution-live-fault' } })); return;
    }
    const upstream = await fetch(new URL('/v1/submissions', ingest), { method: 'POST', headers: { authorization: request.headers.authorization ?? '', 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
    const result = await upstream.text();
    if (submission.domain === 'ABOUT' && lost.delete(submission.plan_id) && upstream.ok) { response.destroy(); return; }
    response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(result);
  })().catch(() => { if (!response.destroyed) response.writeHead(502).end(); });
});
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
const address = proxy.address(); assert.ok(address && typeof address === 'object');
const workerEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '--max-old-space-size=192' };
for (const key of ['CONTROL_API_URL','WORKER_TOKEN_FILE','WORKER_ID','SERVER_ID','BUILD_VERSION','TEMPORAL_ADDRESS','TEMPORAL_NAMESPACE','TEMPORAL_TLS_CA_FILE','TEMPORAL_TLS_CERT_FILE','TEMPORAL_TLS_KEY_FILE','TEMPORAL_TLS_SERVER_NAME','TEMPORAL_ALLOW_INSECURE_LOOPBACK']) if (process.env[key]) workerEnv[key] = process.env[key];
Object.assign(workerEnv, { INGEST_API_URL: `http://127.0.0.1:${address.port}`, TEMPORAL_TASK_QUEUE: temporal.taskQueue, WORKER_CAPACITY: '2', WORKER_HEARTBEAT_MS: '1000', WORKER_DRAIN_MS: '2000' });
async function startWorker() {
  const processChild = child('apps/execution-worker/src/main.ts', workerEnv);
  await waitFor(async () => {
    if (processChild.exitCode !== null) throw new Error('Worker exited before readiness; inspect private logs');
    return logs.get(processChild)!.some(line => line.includes('"phase":"READY"'));
  }, 'Worker ready');
  const environmentKeys = (await readFile(`/proc/${processChild.pid}/environ`, 'utf8')).split('\0').filter(Boolean).map(entry => entry.split('=', 1)[0]!);
  assert.ok(!environmentKeys.some(key => /DATABASE|^PG|JWT_SECRET|OPERATOR_TOKEN|BACKEND_ENV/.test(key)), 'actual Worker environment must exclude backend credentials');
  evidence.worker_environment_keys = environmentKeys.sort();
  return processChild;
}
async function startPlan(plan: Plan) { return starter.start(ref(plan)); }
const backendEnv = process.env.EXECUTION_BACKEND_ENV_FILE;
const verifyDispatchRecovery = process.env.M1_VERIFY_DISPATCH_RECOVERY === 'true';
if (verifyDispatchRecovery && !backendEnv) throw new Error('Dispatcher recovery requires the private backend environment');
function startDispatcher(dropStartAck = false) {
  assert.ok(backendEnv);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '--max-old-space-size=128', M1_WORKSPACE_ID: session.workspace_id, TEMPORAL_TASK_QUEUE: temporal.taskQueue, PG_POOL_MAX: '1' };
  for (const key of Object.keys(workerEnv)) if (key.startsWith('TEMPORAL_')) env[key] = workerEnv[key];
  if (dropStartAck) env.M1_TEST_DROP_START_ACK = '1';
  return child(verifyDispatchRecovery ? 'scripts/dev/verify-dispatch-process.ts' : 'apps/control-api/src/dispatch-main.ts', env, backendEnv);
}
async function waitAcknowledged(processChild: ChildProcess, plan: Plan, kind: 'START'|'CANCEL') {
  await waitFor(async () => {
    if (processChild.exitCode !== null || processChild.signalCode !== null) throw new Error('Dispatcher exited before acknowledgement');
    return logs.get(processChild)!.join('').split('\n').some(line => {
      try { const event = JSON.parse(line); return event.event === 'intent_finished' && event.plan_id === plan.plan_id && event.kind === kind && event.state === 'DONE'; }
      catch { return false; }
    });
  }, `durable ${kind} acknowledged`);
}
let dispatcher: ChildProcess | undefined;
try {
  const initial = await create(); blocked.add(initial.plan_id); lost.add(initial.plan_id);
  if (verifyDispatchRecovery) {
    dispatcher = startDispatcher(true);
    await waitFor(async () => dispatcher!.exitCode !== null, 'crash after actual Temporal start');
    assert.equal(dispatcher.exitCode, 86);
    const lostAck = logs.get(dispatcher)!.join('').split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.event === 'start_ack_lost');
    assert.ok(lostAck?.run_id);
    dispatcher = startDispatcher();
    // No Worker polls until the original 30s lease is recovered, so fault injection
    // does not burn the submission Activity's bounded retry budget while waiting.
    await waitAcknowledged(dispatcher, initial, 'START');
    assert.equal((await startPlan(initial)).run_id, lostAck.run_id);
    checks.push('real Temporal start committed before dispatcher crash; expired lease recovered the original run');
  }
  let worker = await startWorker();
  if (!verifyDispatchRecovery) {
    if (backendEnv) dispatcher = startDispatcher();
    else await startPlan(initial);
  }
  await waitFor(async () => seen.has(initial.plan_id), 'VIDEO paused after ABOUT receipt');
  const before = await detail(initial.plan_id); assert.equal(before.receipts.length, 1);
  const first = await startPlan(initial);
  assert.deepEqual(await startPlan(initial), first);
  assert.equal(posted.filter(s => s.plan_id === initial.plan_id && s.domain === 'ABOUT').length, 1, 'lost response must reconcile instead of reposting');
  await stop(worker, 'SIGKILL');
  if (dispatcher) { await stop(dispatcher); dispatcher = undefined; }
  unavailable.add(initial.plan_id); blocked.delete(initial.plan_id);
  worker = await startWorker();
  const after = await waitFor(async () => { const value = await detail(initial.plan_id); return value.plan.status === 'COMPLETED' ? value : false; }, 'same Plan recovered');
  assert.equal(after.plan.plan_id, initial.plan_id); assert.equal(after.plan.input_hash, initial.input_hash);
  assert.equal(after.plan.deadline_at, before.plan.deadline_at); assert.equal(after.receipts.length, 2);
  assert.deepEqual(after.receipts.find(r => r.domain === 'ABOUT'), before.receipts[0]);
  const videos = posted.filter(s => s.plan_id === initial.plan_id && s.domain === 'VIDEO');
  assert.ok(videos.length >= 2); for (const value of videos) assert.deepEqual(value, videos[0]);
  const handle = client.workflow.getHandle(initial.workflow_id);
  assert.equal((await handle.result() as { status: string }).status, 'COMPLETED');
  assert.deepEqual(await startPlan(initial), first);
  await assert.rejects(starter.start({ ...ref(initial), input_hash: `sha256:${'f'.repeat(64)}` }));
  checks.push('lost APPLIED response reconciled with original receipt', 'SIGKILL + replacement process resumed original Plan/input/deadline',
    'transient Ingest 503 recovered with identical Submission', 'duplicate live and closed Workflow dispatch retained original run', 'wrong frozen input rejected');
  if (backendEnv) checks.push('persisted START intent dispatched; dispatcher stopped without losing execution');
  const history = await handle.fetchHistory();
  await writeFile(resolve(output, 'recovered-history.json'), JSON.stringify(history));
  const workflowBundle = { code: await readFile(resolve(root, 'apps/execution-worker/dist/workflow-bundle.cjs'), 'utf8') };
  await Worker.runReplayHistory({ workflowBundle }, history, initial.workflow_id);
  checks.push('actual recovered Workflow history replayed');

  const waiting = await create(['ABOUT','VIDEO','AGENT']);
  if (verifyDispatchRecovery) { dispatcher = startDispatcher(); await waitAcknowledged(dispatcher, waiting, 'START'); }
  else await startPlan(waiting);
  const waitingDetail = await waitFor(async () => { const value = await detail(waiting.plan_id); return value.plan.status === 'WAITING' ? value : false; }, 'AGENT waiting');
  assert.equal(waitingDetail.receipts.length, 2); assert.equal(waitingDetail.domains.find(d => d.domain === 'AGENT')?.state, 'PENDING');
  assert.equal((await client.workflow.getHandle(waiting.workflow_id).describe()).status.name, 'RUNNING');
  if (verifyDispatchRecovery) { await stop(dispatcher!); dispatcher = undefined; }
  await operator(`/v1/plans/${waiting.plan_id}/cancel`, { command_id: randomUUID(), expected_version: waitingDetail.plan.version });
  if (verifyDispatchRecovery) {
    assert.equal((await client.workflow.getHandle(waiting.workflow_id).describe()).status.name, 'RUNNING');
    dispatcher = startDispatcher(); await waitAcknowledged(dispatcher, waiting, 'CANCEL');
    checks.push('CANCEL intent persisted while dispatcher stopped; replacement dispatcher delivered cancellation');
  } else await starter.cancel(waiting.workflow_id);
  await assert.rejects(client.workflow.getHandle(waiting.workflow_id).result());
  assert.equal((await client.workflow.getHandle(waiting.workflow_id).describe()).status.name, 'CANCELLED');
  assert.equal((await detail(waiting.plan_id)).plan.status, 'CANCELLED');
  checks.push('missing AGENT persisted WAITING; cancellation interrupted durable timer');

  const cancelled = await create(); blocked.add(cancelled.plan_id);
  if (verifyDispatchRecovery) await waitAcknowledged(dispatcher!, cancelled, 'START');
  else await startPlan(cancelled);
  await waitFor(async () => seen.has(cancelled.plan_id), 'late submission held');
  const frozen = await api.input(cancelled.plan_id), cancelDetail = await detail(cancelled.plan_id);
  await operator(`/v1/plans/${cancelled.plan_id}/cancel`, { command_id: randomUUID(), expected_version: cancelDetail.plan.version });
  blocked.delete(cancelled.plan_id);
  await assert.rejects(client.workflow.getHandle(cancelled.workflow_id).result());
  const finalCancelled = await detail(cancelled.plan_id); assert.equal(finalCancelled.plan.status, 'CANCELLED'); assert.equal(finalCancelled.receipts.length, 1);
  const original = fixtureSubmission(frozen, 'ABOUT'); assert.deepEqual(await api.submit(original), finalCancelled.receipts[0]);
  await assert.rejects(api.submit(fixtureSubmission(frozen, 'VIDEO')));
  checks.push('late new write after cancellation rejected by real Store; original APPLIED receipt remains readable and replayable');
  const channel = ChannelDetailSchema.parse(await operator(`/v1/channels/${encodeURIComponent(initial.channel_id)}`));
  assert.equal(channel.videos.length, after.input.sample.videos.length);
  assert.equal(new Set(channel.videos.map(video => video.source_content_id)).size, channel.videos.length);
  assert.deepEqual(channel.videos[0]?.comments_first_page, after.input.sample.videos[0]?.comments_first_page);
  checks.push('current video/comment facts remain unique after retries and multiple fixture Plans');
  evidence.current_facts = { channel_id: channel.channel_id, video_count: channel.videos.length, comment_count: channel.videos.reduce((n, video) => n + (video.comments_first_page?.returned_count ?? 0), 0) };
  const workers = await operator('/v1/workers?limit=100') as { items: { worker_id: string; proxy_status: string; build_version: string }[] };
  const observed = workers.items.find(value => value.worker_id === session.subject); assert.ok(observed); assert.equal(observed.proxy_status, 'NOT_CONFIGURED');
  await stop(worker);
  checks.push('actual Worker identity/version/heartbeat observed; SIGTERM drained within bound; no PG environment in Worker');
  evidence.result = 'PASSED'; evidence.plans = { recovered: after, waiting: await detail(waiting.plan_id), cancelled: finalCancelled };
  evidence.workflow_run_id = first.run_id; evidence.worker = observed; evidence.finished_at = new Date().toISOString();
  await writeFile(resolve(output, 'results.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ result: 'PASSED', checks, plan_ids: plans.map(plan => plan.plan_id), evidence_directory: output }, null, 2));
} catch (error) {
  evidence.result = 'FAILED'; evidence.plan_ids = plans.map(plan => plan.plan_id); evidence.finished_at = new Date().toISOString();
  await writeFile(resolve(output, 'results.json'), JSON.stringify(evidence, null, 2));
  throw error;
} finally {
  blocked.clear();
  for (const processChild of children) {
    await stop(processChild).catch(() => {});
    await writeFile(resolve(output, `process-${processChild.pid}.log`), logs.get(processChild)!.join('')).catch(() => {});
  }
  // Close only this harness's plans; preserve all applied facts and receipts.
  for (const plan of plans) {
    try { const current = await detail(plan.plan_id); if (!['COMPLETED','CANCELLED','FAILED'].includes(current.plan.status)) await operator(`/v1/plans/${plan.plan_id}/cancel`, { command_id: randomUUID(), expected_version: current.plan.version }); await starter.cancel(plan.workflow_id); } catch {}
  }
  proxy.closeAllConnections(); await new Promise<void>(resolveClose => proxy.close(() => resolveClose()));
  await starter.close(); await connection.close();
}
