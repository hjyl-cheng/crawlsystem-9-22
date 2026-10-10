import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { IdentityStore } from '../src/youtube/identity.ts';
test('browser identity and cookies survive process replacement, encrypted and scoped to the proxy', async () => {
  const directory = await mkdtemp('/tmp/crawl-identities-'), secret = 's'.repeat(32);
  try {
    const first = await new IdentityStore(directory, secret, 'worker-0').load('proxy-a');
    first.cookie_state.cookies.push({ name: 'VISITOR', value: 'private-cookie', domain: '.youtube.com' });
    await new IdentityStore(directory, secret, 'worker-0').save('proxy-a', first);
    const restored = await new IdentityStore(directory, secret, 'worker-0').load('proxy-a');
    assert.deepEqual(restored, first);
    assert.notEqual((await new IdentityStore(directory, secret, 'worker-0').load('proxy-b')).visitor_data, first.visitor_data);
    const files = await readdir(directory);
    for (const file of files) {
      const bytes = await readFile(`${directory}/${file}`, 'utf8');
      assert.ok(!bytes.includes(first.visitor_data) && !bytes.includes('private-cookie'));
      assert.equal((await stat(`${directory}/${file}`)).mode & 0o777, 0o600);
    }
    await assert.rejects(new IdentityStore(directory, 'x'.repeat(32), 'worker-0').load('proxy-a'), /cannot be decrypted/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
