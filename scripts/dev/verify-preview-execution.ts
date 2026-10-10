/**
 * Acceptance of the resident preview deployment (deploy/m1-preview): every step
 * goes through the deployed Control API, dispatcher, Worker StatefulSet and
 * Ingest. Local processes only issue a short operator token, read PostgreSQL
 * and describe Temporal for evidence. Run with --env-file=.runtime/main.env.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { PlanDetailSchema, PlanSchema, WorkerSchema, pageSchema, type PlanDetail } from '@crawlsystem/contracts';
import { issueToken, loadSigningKey } from '@crawlsystem/http/auth';
import { TemporalTokenIssuer } from '@crawlsystem/http/temporal-token';
import { createPool } from '@crawlsystem/store/config';

const kubectl = (...args: string[]) => execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const workspace = 'm1-main', expectedBuild = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const deployed = kubectl('-n', 'crawler', 'get', 'statefulset', 'execution-worker', '-o', 'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="BUILD_VERSION")].value}');
const base = `http://${kubectl('-n', 'control', 'get', 'svc', 'control-api-preview', '-o', 'jsonpath={.spec.clusterIP}')}:18100`;
const token = await issueToken({ subject: 'preview-acceptance', workspace_id: workspace, role: 'operator' }, loadSigningKey(), 900);
const api = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(data)}`);
  return data;
};
const plan = async (id: string) => PlanDetailSchema.parse(await api(`/v1/plans/${id}`));
async function until(id: string, done: (p: PlanDetail) => boolean, seconds: number, label: string) {
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await delay(1000)) { const p = await plan(id); if (done(p)) return p; }
  const last = await plan(id); throw new Error(`${label}: plan ${id} stuck at ${last.plan.status}`);
}
const workerLogReady = (pod: string, since: string) => kubectl('-n', 'crawler', 'logs', pod, `--since-time=${since}`).includes('"phase":"READY"');
const checks: string[] = [];
const pass = (check: string) => { checks.push(check); process.stdout.write(`PASS ${check}\n`); };

const pool = createPool();
const forward = spawn('kubectl', ['-n', 'temporal', 'port-forward', 'svc/temporal-frontend', '17233:7233'], { stdio: 'ignore' });
let connection: Connection | undefined;
try {
  assert.equal(deployed, expectedBuild, 'deployed Worker build must equal HEAD');
  const health = await (await fetch(base + '/healthz')).json() as { build_version: string };
  assert.equal(health.build_version, expectedBuild); pass('Control and Worker run the committed revision');

  // 1. A plan created through Control completes via dispatcher → Temporal → resident Worker → Ingest.
  // A sampled parent forces this trace to be exported by every service regardless of the root ratio.
  const traceId = randomUUID().replaceAll('-', '');
  const created = PlanSchema.parse(await api('/v1/plans', { request_id: randomUUID(), fixture_id: 'channel-basic-v1', required_domains: ['ABOUT', 'VIDEO'] }, { traceparent: `00-${traceId}-${randomUUID().replaceAll('-', '').slice(0, 16)}-01` }));
  const completed = await until(created.plan_id, p => p.plan.status === 'COMPLETED', 90, 'resident completion');
  assert.equal(completed.receipts.length, 2); assert.ok(completed.domains.every(d => d.state === 'APPLIED'));
  const workers = new Set(completed.events.map(e => e.worker_id));
  assert.deepEqual([...workers], ['execution-worker-0'], 'events come from the StatefulSet Pod identity');
  pass('plan created via Control completed by the resident Worker with 2 APPLIED receipts');

  // 2. The Worker identity is the Pod, and server_id is its node as proven by TokenReview.
  const node = kubectl('-n', 'crawler', 'get', 'pod', 'execution-worker-0', '-o', 'jsonpath={.spec.nodeName}');
  const listed = pageSchema(WorkerSchema).parse(await api('/v1/workers?limit=100')).items.find(w => w.worker_id === 'execution-worker-0');
  assert.ok(listed && !listed.stale && listed.accepting_work && listed.server_id === node && listed.build_version === expectedBuild);
  pass(`Worker heartbeat: execution-worker-0 on ${node}, accepting, current build`);

  // 3. The same trace reached Loki from all four services (Control, dispatcher, Worker, Ingest).
  // Checked before replacing the Worker Pod: Alloy can miss the log file of a Pod deleted seconds after start.
  const loki = spawn('kubectl', ['-n', 'monitoring', 'port-forward', 'svc/loki', '13101:3100'], { stdio: 'ignore' });
  let services: string[] = [];
  try {
    const expected = ['control', 'ingest', 'intent-dispatcher', 'execution-worker'];
    for (const end = Date.now() + 90_000; Date.now() < end && !expected.every(name => services.includes(name)); await delay(3000)) {
      try {
        const query = new URLSearchParams({ query: `{job="kubernetes-pods"} |= "${traceId}"`, start: String((Date.now() - 900_000) * 1e6), limit: '500' });
        const result = await (await fetch(`http://127.0.0.1:13101/loki/api/v1/query_range?${query}`)).json() as { data?: { result?: { values: [string, string][] }[] } };
        const lines = (result.data?.result ?? []).flatMap(stream => stream.values.map(([, line]) => line));
        services = [...new Set(lines.flatMap(line => { try { const record = JSON.parse(line); return record.event === 'trace_span' && record.trace_id === traceId ? [record.service as string] : []; } catch { return []; } }))].sort();
      } catch { /* port-forward still starting */ }
    }
    assert.deepEqual(services, [...expected].sort(), `trace ${traceId} must be exported by all services`);
  } finally { loki.kill(); }
  pass(`trace ${traceId} spans Control, dispatcher, Worker and Ingest in Loki`);

  // 4. A plan that waits for AGENT survives a Worker Pod replacement, then a durable cancel reaches Temporal.
  const waitingPlan = PlanSchema.parse(await api('/v1/plans', { request_id: randomUUID(), fixture_id: 'channel-basic-v1', required_domains: ['ABOUT', 'VIDEO', 'AGENT'] }));
  const waiting = await until(waitingPlan.plan_id, p => p.plan.status === 'WAITING', 90, 'waiting for AGENT');
  assert.equal(waiting.domains.find(d => d.domain === 'AGENT')?.state, 'PENDING');
  const oldUid = kubectl('-n', 'crawler', 'get', 'pod', 'execution-worker-0', '-o', 'jsonpath={.metadata.uid}');
  const restartedAt = new Date().toISOString();
  kubectl('-n', 'crawler', 'delete', 'pod', 'execution-worker-0', '--wait=true', '--timeout=90s');
  for (const end = Date.now() + 120_000; ; await delay(2000)) {
    if (Date.now() > end) throw new Error('replacement Worker did not become READY');
    try { if (kubectl('-n', 'crawler', 'get', 'pod', 'execution-worker-0', '-o', 'jsonpath={.metadata.uid}') !== oldUid && workerLogReady('execution-worker-0', restartedAt)) break; } catch { /* Pod not created yet */ }
  }
  assert.equal((await plan(waitingPlan.plan_id)).plan.status, 'WAITING', 'waiting plan is not reset or duplicated by the restart');
  pass('Worker Pod replaced (new UID, same identity) and re-authenticated via TokenReview; waiting plan intact');

  const before = await plan(waitingPlan.plan_id);
  await api(`/v1/plans/${waitingPlan.plan_id}/cancel`, { command_id: randomUUID(), expected_version: before.plan.version });
  await until(waitingPlan.plan_id, p => p.plan.status === 'CANCELLED', 30, 'cancel');
  let intents: { kind: string; state: string; attempts: number; workflow_run_id: string | null }[] = [];
  for (const end = Date.now() + 60_000; Date.now() < end; await delay(1000)) {
    intents = (await pool.query('SELECT kind,state,attempts,workflow_run_id FROM control.intents WHERE plan_id=$1 ORDER BY kind', [waitingPlan.plan_id])).rows;
    if (intents.find(i => i.kind === 'CANCEL')?.state === 'DONE') break;
  }
  const start = intents.find(i => i.kind === 'START'), cancel = intents.find(i => i.kind === 'CANCEL');
  assert.equal(start?.state, 'DONE'); assert.equal(cancel?.state, 'DONE', 'deployed dispatcher delivered the CANCEL intent');
  // Read-only namespace token (ignored by Temporal until namespace authorization is enabled).
  const temporalKey = await (await TemporalTokenIssuer.fromPem(readFileSync('.runtime/temporal-jwt/signing.pem', 'utf8'), 600)).issue('preview-acceptance', ['crawlsystem-m1-main:read']);
  const tls = { serverRootCACertificate: readFileSync(process.env.TEMPORAL_TLS_CA_FILE!), clientCertPair: { crt: readFileSync(process.env.TEMPORAL_TLS_CERT_FILE!), key: readFileSync(process.env.TEMPORAL_TLS_KEY_FILE!) }, serverNameOverride: process.env.TEMPORAL_TLS_SERVER_NAME! };
  for (let attempt = 0; !connection; attempt++) { try { connection = await Connection.connect({ address: '127.0.0.1:17233', tls, connectTimeout: '5 seconds', apiKey: temporalKey }); } catch (e) { if (attempt > 5) throw e; await delay(1000); } }
  const client = new Client({ connection, namespace: 'crawlsystem-m1-main' });
  let status = '';
  for (const end = Date.now() + 60_000; Date.now() < end && status !== 'CANCELLED'; await delay(1000)) status = (await client.workflow.getHandle(waitingPlan.workflow_id).describe()).status.name;
  assert.equal(status, 'CANCELLED');
  const completedStatus = (await client.workflow.getHandle(completed.plan.workflow_id).describe()).status.name;
  assert.equal(completedStatus, 'COMPLETED');
  pass('durable CANCEL delivered by the deployed dispatcher; Temporal shows CANCELLED (and COMPLETED for plan 1)');

  const evidence = { verified_at: new Date().toISOString(), revision: expectedBuild, workspace_id: workspace,
    scope: 'Resident preview deployment: Control, intent-dispatcher, execution-worker StatefulSet, Ingest; local process only issued an operator token and read PG/Temporal',
    trace: { trace_id: traceId, services },
    completed_plan: { plan_id: completed.plan.plan_id, workflow_id: completed.plan.workflow_id, receipts: completed.receipts.map(r => r.submission_id) },
    cancelled_plan: { plan_id: waitingPlan.plan_id, workflow_id: waitingPlan.workflow_id, intents },
    worker: { worker_id: 'execution-worker-0', server_id: node, replaced_pod_uid: oldUid }, checks };
  mkdirSync('docs/m1/reports', { recursive: true });
  writeFileSync('docs/m1/reports/preview-execution.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ result: 'PASSED', checks: checks.length }));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAILED', passed: checks, failure: String(error).slice(0, 800) })); process.exitCode = 1;
} finally {
  await connection?.close(); forward.kill(); await pool.end();
}
