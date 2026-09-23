import assert from 'node:assert/strict';
import { createServer, type Server, type RequestListener } from 'node:http';
import { test } from 'node:test';
import { CONTRACT_VERSION } from '@crawlsystem/contracts';
import { ApiFailure, ControlApi, normalizeBaseUrl } from '../src/api.js';

async function server(handler: RequestListener) {
  const app: Server = createServer(handler);
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); } };
}
test('session request uses the public route, validates identity and keeps credentials out of URLs', async () => {
  const service = await server((req, res) => {
    assert.equal(req.url, '/v1/session'); assert.equal(req.headers.authorization, 'Bearer fixture-only');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ subject: 'reader-fixture', workspace_id: 'console-test', role: 'reader', contract_version: CONTRACT_VERSION }));
  });
  try { const result = await new ControlApi(service.url, 'fixture-only').session(); assert.equal(result.role, 'reader'); } finally { await service.close(); }
});
test('invalid success bodies are rejected instead of becoming empty successful pages', async () => {
  const service = await server((_req, res) => { res.end(JSON.stringify({ role: 'operator' })); });
  try { await assert.rejects(new ControlApi(service.url, 'fixture').session(), (e: unknown) => e instanceof ApiFailure && e.code === 'SCHEMA' && !e.retryable); } finally { await service.close(); }
});
test('401 invalidates identity even when the response is HTML', async () => {
  let invalidated = false;
  const service = await server((_req, res) => { res.statusCode = 401; res.end('<html>unauthorized</html>'); });
  try { await assert.rejects(new ControlApi(service.url, 'fixture', () => { invalidated = true; }).session(), (e: unknown) => e instanceof ApiFailure && e.status === 401); assert.equal(invalidated, true); } finally { await service.close(); }
});
test('preserves conflict category, correlation and retry policy from the backend', async () => {
  const service = await server((_req, res) => { res.statusCode = 409; res.end(JSON.stringify({ error: { code: 'CONFLICT', message: 'version changed', retryable: false, correlation_id: 'test-correlation' } })); });
  try { await assert.rejects(new ControlApi(service.url, 'fixture').session(), (e: unknown) => e instanceof ApiFailure && e.code === 'CONFLICT' && e.correlationId === 'test-correlation' && !e.retryable); } finally { await service.close(); }
});
test('requests time out and explicit navigation cancellation remains distinguishable', async () => {
  const service = await server(() => {});
  try {
    await assert.rejects(new ControlApi(service.url, 'fixture', undefined, 20).session(), (e: unknown) => e instanceof ApiFailure && e.code === 'TIMEOUT');
    const abort = new AbortController(); const promise = new ControlApi(service.url, 'fixture').session(abort.signal); abort.abort();
    await assert.rejects(promise, (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
  } finally { await service.close(); }
});
test('API configuration accepts public origins and rejects embedded credentials or redirects', () => {
  assert.equal(normalizeBaseUrl('/api/'), '/api'); assert.equal(normalizeBaseUrl('https://api.example.test/'), 'https://api.example.test');
  for (const value of ['https://name:secret@example.test', '//example.test', 'javascript:alert(1)', 'https://example.test/?key=x']) assert.throws(() => normalizeBaseUrl(value));
});
