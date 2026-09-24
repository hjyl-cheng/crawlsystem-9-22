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
  assert.throws(() => validateApiUrl('https://user:password@api.example.invalid'));
  assert.throws(() => validateTemporalOptions({ address: 'remote:7233', namespace: 'crawlsystem-m1-test', taskQueue: 'test' }));
});
