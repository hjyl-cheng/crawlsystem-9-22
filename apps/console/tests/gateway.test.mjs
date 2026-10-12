import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../deploy/gateway.mjs';

test('release gateway preserves SPA, sessions and old chunks across activation; rejects unsafe requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'console-release-'));
  const first = 'a'.repeat(12) + '-' + '1'.repeat(12), second = 'b'.repeat(12) + '-' + '2'.repeat(12);
  for (const [id, chunk] of [[first, 'old'], [second, 'new']]) {
    const dir = join(root, 'releases', id); await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), id); await writeFile(join(dir, 'release.json'), JSON.stringify({ id }));
    await writeFile(join(dir, 'assets', chunk + '.js'), chunk);
  }
  await symlink(join(root, 'releases', first), join(root, 'current'));
  const api = createServer((req, res) => {
    assert.equal(req.url, '/v1/console/session?x=1'); assert.equal(req.headers.authorization, 'Bearer test');
    assert.equal(req.headers.cookie, 'session=test'); assert.equal(req.headers.origin, 'http://127.0.0.1:18102');
    res.setHeader('set-cookie', 'session=renewed; HttpOnly; Secure; SameSite=Strict');
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      if (req.method === 'POST') assert.equal(body, '{"request":"import"}');
      res.end('authenticated');
    });
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const options = { root, publicHost: 'console.example.com', target: `http://127.0.0.1:${api.address().port}` };
  assert.throws(() => createGateway({ ...options, browserOrigin: 'http://user:password@localhost/' }), /Invalid backend browser origin/);
  // Existing preview.env can omit the origin mapping; browser POSTs must still work.
  const gateway = createGateway(options);
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  const get = (path, headers = {}, method = 'GET', body = '') => new Promise((resolve, reject) => {
    const call = request({ hostname: '127.0.0.1', port: gateway.address().port, path, method, headers: { host: 'console.example.com', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined) responseHeaders.append(name, entry);
        resolve(new Response(method === 'HEAD' ? null : Buffer.concat(chunks), { status: res.statusCode, headers: responseHeaders }));
      });
    }); call.on('error', reject); call.end(body);
  });
  try {
    assert.equal(await (await get('/channels', { accept: 'text/html' })).text(), first);
    assert.equal((await get('/assets/missing.js')).status, 404);
    assert.equal((await get('/release.json')).status,404);
    assert.equal((await get('/gateway.mjs')).status,404);
    assert.equal((await get('/healthz')).status, 200);
    assert.equal((await get('/', { host: 'evil.example' })).status, 403);
    assert.equal((await get('/api/v1/test', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await get('/api/unknown')).status, 404);
    assert.equal((await get('/%2e%2e%2fsecret')).status, 400);
    assert.equal((await get('/.env')).status, 400);
    assert.equal((await get('/channels', {}, 'POST')).status, 405);
    const proxy = await get('/api/v1/console/session?x=1', { origin: 'https://console.example.com', authorization: 'Bearer test', cookie: 'session=test' });
    assert.equal(proxy.status, 200); assert.equal(proxy.headers.get('set-cookie'), 'session=renewed; HttpOnly; Secure; SameSite=Strict');
    assert.equal(await proxy.text(), 'authenticated');
    const post = await get('/api/v1/console/session?x=1', { origin: 'https://console.example.com', authorization: 'Bearer test', cookie: 'session=test', 'content-type': 'application/json' }, 'POST', '{"request":"import"}');
    assert.equal(post.status, 200); assert.equal(await post.text(), 'authenticated');
    assert.equal((await get('/healthz')).status, 200);
    await symlink(join(root, 'releases', second), join(root, 'next')); await rename(join(root, 'next'), join(root, 'current'));
    assert.equal(await (await get('/channels', { accept: 'text/html' })).text(), second);
    const old = await get('/assets/old.js'); assert.equal(await old.text(), 'old'); assert.match(old.headers.get('cache-control'), /immutable/);
    assert.equal(await (await get('/assets/new.js')).text(), 'new');
    const head = await get('/channels', { accept: 'text/html' }, 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  } finally { await new Promise(r => gateway.close(r)); await new Promise(r => api.close(r)); await rm(root, { recursive: true, force: true }); }
});
