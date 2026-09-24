/**
 * Temporal namespace authorization for the shared cluster Temporal (Helm release
 * `temporal`, chart 1.7.0). Run from a clean tree after deploy-preview.ts has
 * published the JWKS and the dispatcher/Worker send tokens.
 *
 *   enable   — preflight, apply NetworkPolicy temporal-internal, helm upgrade with
 *              docs/crawlsystem-infra-a1-s3/values/temporal.yaml, then verify.
 *   verify   — tokens gate namespaces: no token and other namespaces are denied.
 *   rollback — helm rollback to the revision recorded before `enable`.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Connection } from '@temporalio/client';
import { TemporalTokenIssuer } from '@crawlsystem/http/temporal-token';

const run = (command: string, args: string[], input?: string) => execFileSync(command, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const kubectl = (...args: string[]) => run('kubectl', args);
const chart = '.runtime/temporal-chart/temporal-1.7.0.tgz', values = 'docs/crawlsystem-infra-a1-s3/values/temporal.yaml', record = '.runtime/temporal-authz.json';
const step = (message: string) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

async function verify() {
  const forward = spawn('kubectl', ['-n', 'temporal', 'port-forward', 'svc/temporal-frontend', '17235:7233'], { stdio: 'ignore' });
  const connections: Connection[] = [];
  try {
    await delay(2500);
    const tls = { serverRootCACertificate: readFileSync(process.env.TEMPORAL_TLS_CA_FILE!), clientCertPair: { crt: readFileSync(process.env.TEMPORAL_TLS_CERT_FILE!), key: readFileSync(process.env.TEMPORAL_TLS_KEY_FILE!) }, serverNameOverride: process.env.TEMPORAL_TLS_SERVER_NAME! };
    const issuer = await TemporalTokenIssuer.fromPem(readFileSync('.runtime/temporal-jwt/signing.pem', 'utf8'), 300);
    const connect = async (permissions?: string[]) => { const c = await Connection.connect({ address: '127.0.0.1:17235', tls, connectTimeout: '10 seconds', ...(permissions ? { apiKey: await issuer.issue('authz-verify', permissions) } : {}) }); connections.push(c); return c; };
    const allowed = async (c: Connection, namespace: string) => { try { await c.workflowService.describeNamespace({ namespace }); return true; } catch (e) { if (/PERMISSION_DENIED/.test(String(e))) return false; throw e; } };
    const anonymous = await connect(), m1 = await connect(['crawlsystem-m1-main:read']);
    const checks = {
      no_token_m1: await allowed(anonymous, 'crawlsystem-m1-main'), no_token_crawlsystem: await allowed(anonymous, 'crawlsystem'),
      m1_token_m1: await allowed(m1, 'crawlsystem-m1-main'), m1_token_crawlsystem: await allowed(m1, 'crawlsystem'),
    };
    step(`verify ${JSON.stringify(checks)}`);
    assert.deepEqual(checks, { no_token_m1: false, no_token_crawlsystem: false, m1_token_m1: true, m1_token_crawlsystem: false });
    return checks;
  } finally { await Promise.all(connections.map(c => c.close())); forward.kill(); }
}

const action = process.argv[2];
if (action === 'verify') await verify();
else if (action === 'enable') {
  if (run('git', ['status', '--porcelain'])) throw new Error('Enable only from a clean, committed tree');
  // Preflight: clients must already send tokens, or they lose Temporal at upgrade.
  kubectl('-n', 'temporal', 'get', 'configmap', 'temporal-jwks');
  for (const [namespace, kind, name] of [['control', 'deployment', 'intent-dispatcher'], ['crawler', 'statefulset', 'execution-worker']]) {
    const env = kubectl('-n', namespace!, 'get', kind!, name!, '-o', 'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="TEMPORAL_API_KEY_MODE")].value}');
    assert.equal(env, 'workload', `${name} must send Temporal tokens before authorization is enabled`);
  }
  if (!existsSync(chart)) run('helm', ['pull', 'temporal', '--repo', 'https://go.temporal.io/helm-charts', '--version', '1.7.0', '-d', '.runtime/temporal-chart']);
  const history = JSON.parse(run('helm', ['-n', 'temporal', 'history', 'temporal', '-o', 'json'])) as { revision: number; status: string }[];
  const previous = history.filter(h => h.status === 'deployed').at(-1)!.revision;
  writeFileSync(record, JSON.stringify({ previous_revision: previous, started_at: new Date().toISOString() }, null, 2) + '\n');
  // internal-frontend (no authorization) must stay reachable from the temporal namespace only.
  const policy = readFileSync('docs/crawlsystem-infra-a1-s3/manifests/60-network-policies.yaml', 'utf8').split(/^---\s*$/m).find(doc => /name: temporal-internal\s*$/m.test(doc));
  if (!policy) throw new Error('NetworkPolicy temporal-internal not found in the infra manifests');
  step(run('kubectl', ['apply', '-f', '-'], policy));
  step(run('helm', ['upgrade', 'temporal', chart, '-n', 'temporal', '-f', values, '--wait', '--timeout', '10m']).split('\n')[0]!);
  // Frontend reloads JWKS on start; allow the new internal-frontend to register before probing.
  for (let attempt = 1; ; attempt++) { try { await verify(); break; } catch (error) { if (attempt >= 6) throw error; await delay(10_000); } }
  step(`enabled; rollback with: node --env-file=.runtime/main.env --import tsx scripts/dev/temporal-authz.ts rollback`);
} else if (action === 'rollback') {
  const { previous_revision } = JSON.parse(readFileSync(record, 'utf8')) as { previous_revision: number };
  step(run('helm', ['-n', 'temporal', 'rollback', 'temporal', String(previous_revision), '--wait', '--timeout', '10m']));
} else throw new Error('Usage: temporal-authz.ts enable|verify|rollback (run with --env-file=.runtime/main.env for TLS files)');
