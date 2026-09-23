import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import type { Store } from '@crawlsystem/store';
import { issueToken } from '@crawlsystem/http/auth';
import { ConsoleAuth, MemoryAccountStore, passwordRecord } from '../src/console-auth.ts';
import { createControlApi } from '../src/app.ts';

const password = 'test-only-password-47';
const account = { username: 'test-reader', subject: 'test-reader', workspace_id: 'auth-test', role: 'reader', ...await passwordRecord(password) };
const key = randomBytes(32), origin = 'https://console.example.test';
const headers = { origin, 'x-console-request': '1' };
function fixture() {
  let now = Date.now();
  const auth = new ConsoleAuth(new MemoryAccountStore([account]), true, () => now);
  const app = createControlApi({ store: {} as Store, signingKey: key, allowedOrigin: origin, consoleAuth: auth });
  const login = (value = password) => app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload: { username: account.username, password: value } });
  return { app, auth, login, advance: (ms: number) => { now += ms; } };
}
test('password login issues an opaque HttpOnly cookie and restores the same read-only identity', async () => {
  const f = fixture();
  try {
    const response = await f.login(); assert.equal(response.statusCode, 200);
    const cookie = String(response.headers['set-cookie']);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag));
    const identity = response.json(); assert.equal(identity.role, 'reader'); assert.equal(identity.workspace_id, 'auth-test');
    assert.equal(Object.hasOwn(identity, 'token'), false);
    for (let i = 0; i < 2; i++) {
      const restored = await f.app.inject({ url: '/v1/session', headers: { cookie: cookie.split(';')[0]! } });
      assert.equal(restored.statusCode, 200); assert.deepEqual(restored.json(), identity);
    }
  } finally { await f.app.close(); }
});
test('incorrect and unknown accounts get the same 401 and no authenticated cookie', async () => {
  const f = fixture();
  try {
    const wrong = await f.login('wrong-password');
    const unknown = await f.app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload: { username: 'unknown', password } });
    for (const result of [wrong, unknown]) { assert.equal(result.statusCode, 401); assert.equal(result.headers['set-cookie'], undefined); }
    assert.equal(wrong.json().error.message, unknown.json().error.message);
    assert.equal((await f.app.inject({ url: '/v1/session' })).statusCode, 401);
  } finally { await f.app.close(); }
});
test('logout revokes the server session and expires the browser cookie', async () => {
  const f = fixture();
  try {
    const cookie = String((await f.login()).headers['set-cookie']).split(';')[0]!;
    const result = await f.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { ...headers, cookie }, payload: {} });
    assert.equal(result.statusCode, 200); assert.match(String(result.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await f.app.inject({ url: '/v1/session', headers: { cookie } })).statusCode, 401);
  } finally { await f.app.close(); }
});
test('CSRF, forbidden origins and caller-supplied permissions are rejected', async () => {
  const f = fixture();
  try {
    const payload = { username: account.username, password };
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { ...headers, origin: 'https://other.example' }, payload })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload: { ...payload, role: 'operator' } })).statusCode, 400);
    const cookie = String((await f.login()).headers['set-cookie']).split(';')[0]!;
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/plans', headers: { cookie }, payload: {} })).statusCode, 403);
  } finally { await f.app.close(); }
});
test('sessions expire after eight hours and login attempts have a finite budget', async () => {
  const f = fixture();
  try {
    const cookie = String((await f.login()).headers['set-cookie']).split(';')[0]!;
    f.advance(f.auth.lifetimeMs + 1);
    assert.equal((await f.app.inject({ url: '/v1/session', headers: { cookie } })).statusCode, 401);
    for (let i = 0; i < 10; i++) assert.equal((await f.login('wrong-password')).statusCode, 401);
    assert.equal((await f.login()).statusCode, 429);
    f.advance(60_001); assert.equal((await f.login()).statusCode, 200);
  } finally { await f.app.close(); }
});
test('existing Worker Bearer authentication still works independently of console cookies', async () => {
  const f = fixture();
  try {
    const token = await issueToken({ subject: 'worker', workspace_id: 'worker-test', role: 'worker' }, key);
    const result = await f.app.inject({ url: '/v1/session', headers: { authorization: `Bearer ${token}` } });
    assert.equal(result.statusCode, 200); assert.equal(result.json().role, 'worker');
    assert.equal((await f.app.inject({ url: '/v1/session', headers: { authorization: 'Bearer invalid' } })).statusCode, 401);
  } finally { await f.app.close(); }
});
