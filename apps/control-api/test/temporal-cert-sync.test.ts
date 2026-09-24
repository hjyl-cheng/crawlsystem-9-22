import test from 'node:test';
import assert from 'node:assert/strict';
import { syncTemporalClientSecrets } from '../src/temporal-cert-sync.ts';
import type { KubernetesCall } from '@crawlsystem/http/kubernetes';

function cluster(secrets: Record<string, Record<string, string> | undefined>) {
  const patches: string[] = [];
  const call: KubernetesCall = async (method, path, body) => {
    const key = path.replace(/^\/api\/v1\/namespaces\/([^/]+)\/secrets\//, '$1/');
    if (method === 'GET') return secrets[key] ? { status: 200, body: { data: secrets[key] } } : { status: 404, body: {} };
    patches.push(key); secrets[key] = { ...secrets[key], ...(body as { data: Record<string, string> }).data }; return { status: 200, body: {} };
  };
  return { call, patches, secrets };
}
const issued = { 'ca.crt': 'Q0E=', 'tls.crt': 'Q0VSVA==', 'tls.key': 'S0VZ' };
test('renewed client certificates are copied once to their single consumer namespace', async () => {
  const c = cluster({ 'temporal/worker-tls': issued, 'crawler/temporal-client-worker': { 'ca.crt': 'b2xk', 'tls.crt': 'b2xk', 'tls.key': 'b2xk' } });
  assert.deepEqual(await syncTemporalClientSecrets(c.call, 'temporal', ['worker-tls:crawler/temporal-client-worker']), [{ target: 'crawler/temporal-client-worker', changed: true }]);
  assert.deepEqual(c.secrets['crawler/temporal-client-worker'], issued);
  assert.deepEqual(await syncTemporalClientSecrets(c.call, 'temporal', ['worker-tls:crawler/temporal-client-worker']), [{ target: 'crawler/temporal-client-worker', changed: false }]);
  assert.deepEqual(c.patches, ['crawler/temporal-client-worker'], 'an unchanged secret is not rewritten, so clients do not restart');
});
test('missing sources, unissued keys, absent targets and malformed pairs fail the job', async () => {
  await assert.rejects(syncTemporalClientSecrets(cluster({}).call, 'temporal', ['worker-tls:crawler/x']));
  await assert.rejects(syncTemporalClientSecrets(cluster({ 'temporal/worker-tls': { 'tls.crt': 'eA==' } }).call, 'temporal', ['worker-tls:crawler/x']));
  await assert.rejects(syncTemporalClientSecrets(cluster({ 'temporal/worker-tls': issued }).call, 'temporal', ['worker-tls:crawler/x']));
  await assert.rejects(syncTemporalClientSecrets(cluster({ 'temporal/worker-tls': issued }).call, 'temporal', ['worker-tls:../kube-system/x']));
});
