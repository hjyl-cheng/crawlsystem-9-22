import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream, realpathSync } from 'node:fs';
import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json' };
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function cleanHeaders(headers) {
  const out = { ...headers };
  for (const name of [...hopHeaders, ...String(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase())]) delete out[name];
  return out;
}

/** A release gateway: loopback only; static SPA and authenticated Control API. */
export function createGateway({ root, publicHost, target, browserOrigin, port = 18103, proxyTimeout = 30000 }) {
  const current = resolve(root, 'current');
  const upstream = new URL(target);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== '/') throw new Error('Invalid API target');
  if (!publicHost || !/^[a-z0-9.-]+$/i.test(publicHost)) throw new Error('An exact public host is required');
  const hosts = new Set([publicHost, `127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`https://${publicHost}`, `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const json = (res, status, code) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { code, message: status === 503 ? '服务暂时不可用，请稍后重试' : '请求未被允许', retryable: status === 503, correlation_id: 'console-gateway' } }));
  };
  async function asset(directory, path) {
    try {
      const base = await realpath(directory), file = await realpath(resolve(base, '.' + path));
      if (!file.startsWith(base + sep)) return null;
      const info = await stat(file);
      return info.isFile() ? { file, size: info.size } : null;
    } catch { return null; }
  }
  return createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-robots-tag', 'noindex, nofollow');
    res.setHeader('referrer-policy', 'no-referrer');
    if (!hosts.has(req.headers.host ?? '')) { json(res, 403, 'FORBIDDEN'); return; }
    let path;
    try {
      path = decodeURIComponent((req.url ?? '/').split('?')[0]);
      if (!path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x1f]/.test(path) || path.split('/').some(s => s === '..' || s.startsWith('.'))) throw new Error();
    } catch { json(res, 400, 'INVALID_REQUEST'); return; }
    if (path.startsWith('/api/')) {
      if (!path.startsWith('/api/v1/')) { json(res, 404, 'NOT_FOUND'); return; }
      if (req.headers.origin && !origins.has(req.headers.origin)) { json(res, 403, 'FORBIDDEN'); return; }
      const headers = cleanHeaders(req.headers);
      headers.host = upstream.host;
      if (headers.origin) headers.origin = browserOrigin;
      // Backend still validates sessions, CSRF, role and workspace. Never insert credentials.
      const proxy = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(new URL((req.url ?? '').slice(4), upstream), { method: req.method, headers }, response => {
        res.writeHead(response.statusCode ?? 503, { ...cleanHeaders(response.headers), 'cache-control': 'no-store' });
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      proxy.setTimeout(proxyTimeout, () => proxy.destroy(new Error('timeout')));
      proxy.on('error', () => json(res, 503, 'UNAVAILABLE'));
      req.on('aborted', () => proxy.destroy());
      res.on('close', () => { if (!res.writableFinished) proxy.destroy(); });
      req.pipe(proxy);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.setHeader('allow', 'GET, HEAD'); json(res, 405, 'INVALID_REQUEST'); return; }
    try {
      const release = JSON.parse(await readFile(resolve(current, 'release.json'), 'utf8'));
      res.setHeader('x-console-release', release.id);
      if (path === '/healthz') {
        if (!await asset(current, '/index.html')) throw new Error();
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ready', release: release.id }));
        return;
      }
      let found = await asset(current, path);
      const isAsset = path.startsWith('/assets/');
      if (!found && isAsset) {
        // Tabs opened before activation retain their immutable chunks across releases/rollback.
        for (const name of (await readdir(resolve(root, 'releases'))).filter(n => /^[a-f0-9]{12}-[a-f0-9]{12}$/.test(n))) {
          found = await asset(resolve(root, 'releases', name), path);
          if (found) break;
        }
      }
      if (!found && !isAsset && !extname(path) && (req.headers.accept ?? '').includes('text/html')) found = await asset(current, '/index.html');
      if (!found && path === '/') found = await asset(current, '/index.html');
      if (!found) { json(res, 404, 'NOT_FOUND'); return; }
      res.writeHead(200, { 'content-type': types[extname(found.file)] ?? 'application/octet-stream', 'content-length': found.size, 'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-store' });
      if (req.method === 'HEAD') res.end();
      else createReadStream(found.file).on('error', () => res.destroy()).pipe(res);
    } catch { json(res, 503, 'UNAVAILABLE'); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const server = createGateway({ root: process.env.CONSOLE_RELEASE_ROOT, publicHost: process.env.CONSOLE_PREVIEW_HOST, target: process.env.CONTROL_API_PROXY_TARGET, browserOrigin: process.env.CONTROL_API_BROWSER_ORIGIN, port: 18103 });
  server.listen(18103, '127.0.0.1', () => console.log('Console release gateway ready on loopback:18103'));
  const shutdown = () => { server.close(); setTimeout(() => process.exit(0), 10000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
