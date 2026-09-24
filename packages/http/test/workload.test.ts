import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Store } from '@crawlsystem/store';
import { authenticate } from '../src/auth.ts';
import { WorkloadIdentity, type ReviewedWorkload } from '../src/workload.ts';
import { createControlApi } from '../../../apps/control-api/src/app.ts';

const key = randomBytes(32), serviceAccount = 'system:serviceaccount:crawler:execution-worker';
const saToken = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
function identity(result: ReviewedWorkload | undefined | Error, seen: string[] = []) {
  return new WorkloadIdentity({ serviceAccount, audience: 'crawlsystem-control', workspaceId: 'm1-test', signingKey: key, lifetimeSeconds: 600,
    reviewer: async (token, audience) => { seen.push(`${audience}:${token}`); if (result instanceof Error) throw result; return result; } });
}
const pod = { username: serviceAccount, pod: 'execution-worker-0', node: 'a2' };

test('a reviewed Worker Pod receives a short worker token whose subject is the Pod', async () => {
  const seen: string[] = [];
  const result = await identity(pod, seen).exchange(`Bearer ${saToken}`);
  assert.deepEqual(seen, [`crawlsystem-control:${saToken}`]);
  assert.deepEqual(result.principal, { subject: 'execution-worker-0', workspace_id: 'm1-test', role: 'worker' });
  assert.equal(result.server_id, 'a2'); assert.equal(result.expires_in, 600);
  assert.deepEqual(await authenticate(`Bearer ${result.token}`, key), result.principal);
});
test('other ServiceAccounts, invalid tokens and malformed headers get no API token', async () => {
  await assert.rejects(identity({ ...pod, username: 'system:serviceaccount:control:default' }).exchange(`Bearer ${saToken}`), { status: 403 });
  await assert.rejects(identity(undefined).exchange(`Bearer ${saToken}`), { status: 401 });
  const seen: string[] = [];
  for (const header of [undefined, 'Bearer not-a-jwt', `Basic ${saToken}`, `Bearer ${saToken} extra`]) await assert.rejects(identity(pod, seen).exchange(header), { status: 401 });
  assert.deepEqual(seen, [], 'malformed input never reaches the API server');
});
test('an unavailable TokenReview is a retryable 503 and leaks no cause', async () => {
  await assert.rejects(identity(new Error('connect ECONNREFUSED 10.43.0.1:443')).exchange(`Bearer ${saToken}`),
    (error: Error & { status?: number; retryable?: boolean }) => error.status === 503 && error.retryable === true && !error.message.includes('10.43'));
});
test('configuration rejects broad identities and long lifetimes', () => {
  assert.throws(() => new WorkloadIdentity({ serviceAccount: 'system:serviceaccounts', audience: 'a-b', workspaceId: 'w', signingKey: key, reviewer: async () => undefined }));
  assert.throws(() => new WorkloadIdentity({ serviceAccount, audience: 'crawlsystem-control', workspaceId: 'w', signingKey: key, lifetimeSeconds: 86400, reviewer: async () => undefined }));
});
test('Control exposes the exchange without JWT authentication and returns the contract shape', async () => {
  const app = createControlApi({ store: {} as Store, signingKey: key, workloadIdentity: identity(pod) });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/workload/token', headers: { authorization: `Bearer ${saToken}` } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.subject, 'execution-worker-0'); assert.equal(body.role, 'worker'); assert.equal(body.server_id, 'a2');
    const session = await app.inject({ url: '/v1/session', headers: { authorization: `Bearer ${body.token}` } });
    assert.equal(session.statusCode, 200); assert.equal(session.json().subject, 'execution-worker-0');
    // The ServiceAccount token itself is never accepted as an API credential.
    assert.equal((await app.inject({ url: '/v1/session', headers: { authorization: `Bearer ${saToken}` } })).statusCode, 401);
  } finally { await app.close(); }
  const disabled = createControlApi({ store: {} as Store, signingKey: key });
  try { assert.equal((await disabled.inject({ method: 'POST', url: '/v1/workload/token', headers: { authorization: `Bearer ${saToken}` } })).statusCode, 503); }
  finally { await disabled.close(); }
});
test('TokenReview accepts only authenticated, audience-bound Pod tokens', async () => {
  const { kubernetesTokenReviewer } = await import('../src/workload.ts');
  const user = { username: serviceAccount, extra: { 'authentication.kubernetes.io/pod-name': ['execution-worker-0'], 'authentication.kubernetes.io/node-name': ['a2'] } };
  const reply = (status: number, body: unknown) => kubernetesTokenReviewer(async (method, path, request) => {
    assert.equal(method, 'POST'); assert.equal(path, '/apis/authentication.k8s.io/v1/tokenreviews');
    assert.deepEqual((request as { spec: unknown }).spec, { token: 'sa', audiences: ['crawlsystem-control'] });
    return { status, body };
  });
  assert.deepEqual(await reply(201, { status: { authenticated: true, audiences: ['crawlsystem-control'], user } })('sa', 'crawlsystem-control'), { username: serviceAccount, pod: 'execution-worker-0', node: 'a2' });
  for (const status of [{ authenticated: false, user }, { authenticated: true, audiences: ['https://kubernetes.default.svc'], user },
    { authenticated: true, audiences: ['crawlsystem-control'], user: { username: serviceAccount } }])
    assert.equal(await reply(201, { status })('sa', 'crawlsystem-control'), undefined, 'legacy or wrong-audience tokens are not Worker identities');
  await assert.rejects(reply(403, {})('sa', 'crawlsystem-control'));
});
