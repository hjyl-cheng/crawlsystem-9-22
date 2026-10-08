import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { IdSchema } from '@crawlsystem/contracts';
import { ExecutionApi, validateApiUrl, workloadTokenSource } from '@crawlsystem/execution-client/http';
import { probeYoutubeContent } from '@crawlsystem/execution-client/proxy-connect';
import { ProxyPool, proxyUrl } from './pool.ts';
import { localServer } from './server.ts';

// Node-local Proxy Manager (DaemonSet): syncs with Proxy Control, serves leases to local
// Workers, and health-checks idle proxies by loading a YouTube page through the same proxied
// fetch the collector uses. New and blocked proxies stay in trial until probes pass.
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const pod = IdSchema.parse(required('POD_NAME')), node = IdSchema.parse(required('NODE_NAME')), control = validateApiUrl(required('CONTROL_API_URL'));
const syncMs = Number(process.env.PROXY_SYNC_MS ?? '30000'), probeEveryMs = Number(process.env.PROXY_PROBE_EVERY_MS ?? '300000'), probeParallel = Number(process.env.PROXY_PROBE_PARALLEL ?? '8');
const trialEveryMs = Number(process.env.PROXY_TRIAL_PROBE_EVERY_MS ?? '60000');
const log = (record: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), service: 'proxy-manager', server_id: node, ...record })}\n`);
const identity = required('WORKLOAD_IDENTITY_TOKEN_FILE');
const api = new ExecutionApi({ controlUrl: control, ingestUrl: control, timeoutMs: 8000,
  token: workloadTokenSource({ controlUrl: control, workerId: pod, identityToken: () => readFile(identity, 'utf8') }) });
const pool = new ProxyPool();
const bootId = randomUUID();
let sequence = 0, stopping = false;
const server = localServer(pool).listen(Number(process.env.PORT ?? '18110'), '0.0.0.0');
const stop = () => { stopping = true; server.close(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);

async function sync() {
  const response = await api.proxySync({ node_boot_id: bootId, report_sequence: ++sequence, observed_at: new Date().toISOString(), observations: pool.observations() }, { attempts: 1 });
  if (response.server_id !== node) throw new Error('Control assigned a different server identity');
  pool.apply(response.assignments, Date.parse(response.lease_expires_at));
  return response.assignments.length;
}
async function probeRound() {
  const due = pool.probeCandidates(probeEveryMs, probeParallel * 4, trialEveryMs);
  const tally = { probed: due.length, passed: 0, blocked: 0 };
  for (let i = 0; i < due.length && !stopping; i += probeParallel) {
    await Promise.all(due.slice(i, i + probeParallel).map(async a => {
      const result = await probeYoutubeContent(proxyUrl(a));
      if (result.ok) tally.passed++; else if (result.blocked) tally.blocked++;
      pool.probed(a.proxy_id, result.ok, result.ok ? result.latency_ms : null, result.ok ? undefined : result.error, !result.ok && result.blocked);
    }));
  }
  return tally;
}
// Sync and health checks run independently, so slow probes never delay lease renewal.
async function syncLoop() {
  while (!stopping) {
    try { await sync(); if (sequence === 1 || sequence % 20 === 0) log({ event: 'synced', ...pool.stats() }); }
    // A missed sync keeps serving only until the central lease expires (pool.authorized).
    catch (error) { log({ event: 'sync_failed', error: error instanceof Error ? error.name : 'unknown', authorized: pool.authorized }); }
    await delay(syncMs);
  }
}
async function probeLoop() {
  while (!stopping) {
    const tally = await probeRound().catch(() => null);
    if (tally?.probed) log({ event: 'probed', ...tally, ...pool.stats() });
    await delay(15_000);
  }
}
await Promise.all([syncLoop(), probeLoop()]);
