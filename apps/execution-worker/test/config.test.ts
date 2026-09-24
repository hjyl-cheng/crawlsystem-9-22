import test from 'node:test';
import assert from 'node:assert/strict';
import { workerConfig } from '../src/config.ts';
import { validateTemporalOptions } from '@crawlsystem/execution-client/config';
import { validateApiUrl } from '@crawlsystem/execution-client/http';
const env = { TEMPORAL_ADDRESS: '127.0.0.1:7233', TEMPORAL_NAMESPACE: 'crawlsystem-m1-test', TEMPORAL_ALLOW_INSECURE_LOOPBACK: 'true',
  CONTROL_API_URL: 'http://127.0.0.1:1', INGEST_API_URL: 'http://127.0.0.1:2', WORKER_TOKEN_FILE: '/tmp/test-token', WORKER_ID: 'test-worker', SERVER_ID: 'test-node', BUILD_VERSION: 'test' };
test('Worker rejects backend credentials and unbounded resource configuration', () => {
  assert.equal(workerConfig(env).capacity, 2);
  for (const key of ['DATABASE_URL','PGPASSWORD','M1_JWT_SECRET_FILE','CONSOLE_DATABASE_URL']) assert.throws(() => workerConfig({ ...env, [key]: 'secret' }));
  for (const key of ['WORKER_CAPACITY','WORKER_DRAIN_MS','WORKER_HEARTBEAT_MS','WORKER_HTTP_TIMEOUT_MS']) assert.throws(() => workerConfig({ ...env, [key]: '1000000' }));
});
test('remote transport requires TLS and origin URLs reject embedded credentials', () => {
  assert.throws(() => validateApiUrl('http://api.example.invalid'));
  assert.equal(validateApiUrl('http://control-api-preview.control.svc.cluster.local:18100'), 'http://control-api-preview.control.svc.cluster.local:18100');
  for (const host of ['http://svc.cluster.local.example.invalid', 'http://a.b.c.svc.cluster.local', 'http://control.svc.cluster.local']) assert.throws(() => validateApiUrl(host));
  assert.throws(() => validateApiUrl('https://user:password@api.example.invalid'));
  assert.throws(() => validateTemporalOptions({ address: 'remote:7233', namespace: 'crawlsystem-m1-test', taskQueue: 'test' }));
});
test('Worker requires exactly one credential source', () => {
  const { WORKER_TOKEN_FILE: _unused, ...cluster } = env;
  assert.equal(workerConfig({ ...cluster, WORKLOAD_IDENTITY_TOKEN_FILE: '/var/run/secrets/tokens/control' }).identityTokenFile, '/var/run/secrets/tokens/control');
  assert.throws(() => workerConfig(cluster));
  assert.throws(() => workerConfig({ ...env, WORKLOAD_IDENTITY_TOKEN_FILE: '/var/run/secrets/tokens/control' }));
});
test('a renewed mTLS file triggers one graceful restart signal', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { watchTlsFiles } = await import('@crawlsystem/execution-client/config');
  const dir = mkdtempSync('/tmp/crawlsystem-tls-watch-');
  for (const name of ['ca', 'cert', 'key']) writeFileSync(`${dir}/${name}`, 'v1');
  let changes = 0;
  const stop = watchTlsFiles({ TEMPORAL_TLS_CA_FILE: `${dir}/ca`, TEMPORAL_TLS_CERT_FILE: `${dir}/cert`, TEMPORAL_TLS_KEY_FILE: `${dir}/key` }, () => { changes++; }, 20);
  try {
    await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(changes, 0);
    writeFileSync(`${dir}/cert`, 'v2');
    await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(changes, 1);
    writeFileSync(`${dir}/cert`, 'v3');
    await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(changes, 1);
  } finally { stop(); }
});
test('Temporal API key comes from exactly one source and is refreshed only when it changes', async () => {
  const { temporalOptions, refreshTemporalApiKey } = await import('@crawlsystem/execution-client/config');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const base = { TEMPORAL_ADDRESS: '127.0.0.1:7233', TEMPORAL_NAMESPACE: 'crawlsystem-m1-test', TEMPORAL_ALLOW_INSECURE_LOOPBACK: 'true' };
  assert.equal(temporalOptions(base).apiKey, undefined);
  const file = `${mkdtempSync('/tmp/crawlsystem-temporal-key-')}/token`; writeFileSync(file, 'jwt-1\n');
  assert.equal(await temporalOptions({ ...base, TEMPORAL_API_KEY_FILE: file }).apiKey!(), 'jwt-1');
  assert.ok(temporalOptions({ ...base, TEMPORAL_API_KEY_MODE: 'workload', CONTROL_API_URL: 'http://127.0.0.1:1', WORKLOAD_IDENTITY_TOKEN_FILE: file }).apiKey);
  assert.throws(() => temporalOptions({ ...base, TEMPORAL_API_KEY_MODE: 'workload' }));
  assert.throws(() => temporalOptions({ ...base, TEMPORAL_API_KEY_MODE: 'workload', TEMPORAL_API_KEY_FILE: file, CONTROL_API_URL: 'http://127.0.0.1:1', WORKLOAD_IDENTITY_TOKEN_FILE: file }));
  assert.throws(() => temporalOptions({ ...base, TEMPORAL_API_KEY_MODE: 'static' }));
  let token = 'a'; const applied: string[] = []; let errors = 0;
  const stop = refreshTemporalApiKey(async () => { if (token === 'fail') throw new Error('down'); return token; }, t => { applied.push(t); }, () => { errors++; }, 15);
  try {
    await new Promise(r => setTimeout(r, 50)); token = 'b'; await new Promise(r => setTimeout(r, 50)); token = 'fail'; await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(applied, ['a', 'b']); assert.ok(errors > 0);
  } finally { stop(); }
});
