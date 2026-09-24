import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeConnection, Worker, Runtime, DefaultLogger } from '@temporalio/worker';
import { ExecutionApi, workloadTokenSource } from '@crawlsystem/execution-client/http';
import { RequestTracing } from '@crawlsystem/http/tracing';
import { createActivities } from './activities.ts';
import { workerConfig } from './config.ts';
import { refreshTemporalApiKey, watchTlsFiles } from '@crawlsystem/execution-client/config';

const config = workerConfig();
const tracing = new RequestTracing('execution-worker', record => log(record), Number(process.env.TRACE_SAMPLE_RATIO ?? '0.1'));
const log = (record: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`);
// SDK messages may contain endpoints or user payloads. Emit only a bounded category.
Runtime.install({ logger: new DefaultLogger('WARN', entry => log({ source: 'temporal', level: entry.level, message: 'Temporal SDK diagnostic; inspect secured service logs' })) });
const token = config.identityTokenFile
  ? workloadTokenSource({ controlUrl: config.controlUrl, workerId: config.workerId, timeoutMs: config.httpTimeoutMs, identityToken: () => readFile(config.identityTokenFile!, 'utf8') })
  : async () => readFile(config.tokenFile!, 'utf8');
const api = new ExecutionApi({ controlUrl: config.controlUrl, ingestUrl: config.ingestUrl, timeoutMs: config.httpTimeoutMs, token });
const session = await api.session();
if (session.role !== 'worker' || session.subject !== config.workerId) throw new Error('Worker credential identity mismatch');
const running = new Map<string, number>();
let accepting = false, stopping = false;
const heartbeatStop = new AbortController();
const report = () => api.heartbeat({ worker_id: config.workerId, server_id: config.serverId, build_version: config.buildVersion,
  accepting_work: accepting, capacity: config.capacity, running_plan_ids: [...running.keys()] }, { attempts: 1 });
const temporalApiKey = config.temporal.apiKey ? await config.temporal.apiKey() : undefined;
const connection = await NativeConnection.connect({ address: config.temporal.address, tls: config.temporal.tls ?? (temporalApiKey ? false : undefined), ...(temporalApiKey ? { apiKey: temporalApiKey } : {}) });
const stopTemporalRefresh = refreshTemporalApiKey(config.temporal.apiKey, token => connection.setApiKey(token),
  () => log({ worker_id: config.workerId, phase: 'TEMPORAL_TOKEN', error_code: 'UNAVAILABLE', retryable: true }));
let worker: Worker | undefined;
let heartbeatLoop: Promise<void> | undefined;
const stop = () => {
  if (stopping) return;
  stopping = true; accepting = false;
  void report().catch(() => {});
  if (worker?.getState() === 'RUNNING') worker.shutdown();
};
process.once('SIGTERM', stop); process.once('SIGINT', stop);
// Renewed mTLS files are only read at connect: drain and let Kubernetes restart the Pod.
const unwatch = watchTlsFiles(process.env, () => { log({ worker_id: config.workerId, phase: 'CERTIFICATE_ROTATED' }); stop(); });
try {
  worker = await Worker.create({ connection, namespace: config.temporal.namespace, taskQueue: config.temporal.taskQueue,
    identity: config.workerId, buildId: config.buildVersion,
    // Prebuild once; each replacement process loads the same bundle without webpack.
    workflowBundle: { codePath: fileURLToPath(new URL('../dist/workflow-bundle.cjs', import.meta.url)) },
    activities: createActivities({ api, workerId: config.workerId, workspaceId: session.workspace_id, log, tracing,
      enter(planId) { running.set(planId, (running.get(planId) ?? 0) + 1); return () => { const count = running.get(planId)! - 1; if (count) running.set(planId, count); else running.delete(planId); }; },
    }),
    maxConcurrentActivityTaskExecutions: config.capacity, maxConcurrentWorkflowTaskExecutions: config.capacity + 2,
    maxConcurrentActivityTaskPolls: 1, maxConcurrentWorkflowTaskPolls: 1, maxCachedWorkflows: 10,
    maxHeartbeatThrottleInterval: '1 second', defaultHeartbeatThrottleInterval: '1 second',
    shutdownGraceTime: config.drainMs, shutdownForceTime: config.drainMs + 10_000,
  });
  await report();
  if (!stopping) {
    accepting = true;
    heartbeatLoop = (async () => {
      while (!heartbeatStop.signal.aborted) {
        await report().catch(() => log({ worker_id: config.workerId, phase: 'HEARTBEAT', error_code: 'UNAVAILABLE', retryable: true }));
        await delay(config.heartbeatMs, undefined, { signal: heartbeatStop.signal }).catch(() => {});
      }
    })();
    log({ worker_id: config.workerId, phase: 'READY', build_version: config.buildVersion, workspace_id: session.workspace_id });
    await worker.run();
  }
} finally {
  accepting = false;
  heartbeatStop.abort();
  await heartbeatLoop;
  await report().catch(() => {});
  await tracing.close();
  await connection.close();
  unwatch(); stopTemporalRefresh();
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
}
