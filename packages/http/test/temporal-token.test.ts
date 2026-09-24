import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { jwtVerify, createLocalJWKSet } from 'jose';
import { TemporalTokenIssuer, temporalJwks, temporalKeyId } from '../src/temporal-token.ts';
import { WorkloadIdentity } from '../src/workload.ts';

const pem = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const worker = 'system:serviceaccount:crawler:execution-worker', dispatcher = 'system:serviceaccount:control:intent-dispatcher';
const saToken = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

test('Temporal tokens verify against the published JWKS and carry exactly the granted permissions', async () => {
  const current = pem(), previous = pem(), issuer = await TemporalTokenIssuer.fromPem(current, 600);
  const jwks = await temporalJwks([current, previous]);
  assert.deepEqual(jwks.keys.map(k => k.kid), [temporalKeyId(current), temporalKeyId(previous)]);
  assert.ok(jwks.keys.every(k => !('d' in k)), 'JWKS never contains private key material');
  const token = await issuer.issue('sa/pod', ['crawlsystem-m1-main:write']);
  const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks as never), { algorithms: ['ES256'] });
  assert.equal(protectedHeader.kid, temporalKeyId(current));
  assert.deepEqual(payload.permissions, ['crawlsystem-m1-main:write']); assert.equal(payload.sub, 'sa/pod');
  assert.equal((payload.exp as number) - (payload.iat as number), 600);
  await assert.rejects(jwtVerify(token, createLocalJWKSet(await temporalJwks([previous]) as never)), 'a different key set rejects the token');
});
test('system, admin and malformed permissions are never issued', async () => {
  const issuer = await TemporalTokenIssuer.fromPem(pem());
  for (const permissions of [[], ['system:admin'], ['crawlsystem-m1-main:admin'], ['crawlsystem-m1-main'], ['*:write']])
    await assert.rejects(issuer.issue('x', permissions));
  await assert.rejects(TemporalTokenIssuer.fromPem(pem(), 86400));
});
test('ServiceAccounts get only their mapped Temporal permissions', async () => {
  const issuer = await TemporalTokenIssuer.fromPem(pem());
  const identity = (username: string) => new WorkloadIdentity({ serviceAccount: worker, audience: 'crawlsystem-control', workspaceId: 'w', signingKey: randomBytes(32),
    reviewer: async () => ({ username, pod: 'pod-0', node: 'a1' }),
    temporal: { issuer, permissions: { [worker]: ['crawlsystem-m1-main:read', 'crawlsystem-m1-main:worker'], [dispatcher]: ['crawlsystem-m1-main:write'] } } });
  const granted = await identity(dispatcher).exchangeTemporal(`Bearer ${saToken}`);
  assert.deepEqual(granted.permissions, ['crawlsystem-m1-main:write']); assert.equal(granted.expires_in, 900);
  assert.deepEqual((await identity(worker).exchangeTemporal(`Bearer ${saToken}`)).permissions, ['crawlsystem-m1-main:read', 'crawlsystem-m1-main:worker']);
  await assert.rejects(identity('system:serviceaccount:control:default').exchangeTemporal(`Bearer ${saToken}`), { status: 403 });
  // The dispatcher may get Temporal tokens but never an API worker token.
  await assert.rejects(identity(dispatcher).exchange(`Bearer ${saToken}`), { status: 403 });
  assert.throws(() => new WorkloadIdentity({ serviceAccount: worker, audience: 'crawlsystem-control', workspaceId: 'w', signingKey: randomBytes(32), reviewer: async () => undefined,
    temporal: { issuer, permissions: { [worker]: ['system:admin'] } } }));
});
