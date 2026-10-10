import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { IdentityStore } from '../src/youtube/identity.ts';
import { FingerprintClient, FingerprintError } from '../src/youtube/fingerprint.ts';
test('fingerprint transport restores restarted sidecars, preserves target status/body and saves cookies before releasing', async () => {
  const directory = await mkdtemp('/tmp/crawl-fingerprint-');
  let configured = 0, fetched = 0; const profiles: Record<string, unknown>[] = [];
  const http: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === 'PUT') { configured++; profiles.push(JSON.parse(String(init.body))); return Response.json({ ok: true }); }
    if (init?.method === 'DELETE') return Response.json({ ok: true });
    if (path.endsWith('/snapshot')) return Response.json({ cookies: [{ name: 'TEST', value: 'kept' }] });
    if (path.startsWith('/v1/fetch')) {
      fetched++; if (fetched === 1) return new Response(null, { status: 404 });
      const meta = new Headers(init?.headers);
      const proxy = JSON.parse(Buffer.from(meta.get('x-fingerprint-proxy')!, 'base64url').toString());
      assert.equal(proxy.url, 'https://127.0.0.1/'); assert.equal(proxy.insecure_tls, true);
      return new Response('body', { headers: { 'x-fingerprint-response-status': '429', 'x-fingerprint-response-headers': Buffer.from(JSON.stringify({ 'x-target': 'yes' })).toString('base64url') } });
    }
    throw new Error('unexpected route');
  };
  try {
    const store = new IdentityStore(directory, 's'.repeat(32), 'worker');
    const client = new FingerprintClient('http://127.0.0.1:3099', store, http);
    const lease = { proxy_id: 'p', lease_id: 'l', proxy_url: 'https://127.0.0.1:443#insecure-tls', expires_at: Date.now() + 60_000 };
    for (let run = 0; run < 2; run++) await client.withProfile(lease, new AbortController().signal, async transport => {
      const response = await transport.fetch('https://www.youtube.com/test', { method: 'POST', body: 'payload' });
      assert.equal(response.status, 429); assert.equal(response.headers.get('x-target'), 'yes'); assert.equal(await response.text(), 'body');
    });
    assert.equal(configured, 3); assert.equal(profiles[0]!.visitor_data, profiles[2]!.visitor_data);
    assert.deepEqual(profiles[2]!.cookie_state, { cookies: [{ name: 'TEST', value: 'kept' }] });
    assert.ok(new FingerprintError('upstream_transient', 7).penalizeProxy);
    assert.ok(!new FingerprintError('gateway').penalizeProxy);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
