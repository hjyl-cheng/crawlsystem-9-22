/** Local development supervisor. All children remain in check-safe.sh's scope. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';

const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`${key} is required`); return value; };
const backendFile = required('EXECUTION_BACKEND_ENV_FILE');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const backend = parseEnv(await readFile(backendFile, 'utf8'));
const control = new URL(required('CONTROL_API_URL')), ingest = new URL(required('INGEST_API_URL'));
const temporal = required('TEMPORAL_ADDRESS');
const pg = new URL(backend.DATABASE_URL!);
if (control.hostname !== '127.0.0.1' || ingest.hostname !== '127.0.0.1' || pg.hostname !== '127.0.0.1' || !/^127\.0\.0\.1:\d+$/.test(temporal)) throw new Error('Local dependency supervisor requires loopback endpoints');
const children: { process: ChildProcess; name: string; log: string }[] = [];
const out = resolve(root, '.runtime/execution-evidence');
await mkdir(out, { recursive: true, mode: 0o700 });
let stopped = false;
const stop = () => { stopped = true; for (const child of children) child.process.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
function start(name: string, command: string, args: string[], env: NodeJS.ProcessEnv) {
  const processChild = spawn(command, args, { cwd: root, env, stdio: ['ignore','pipe','pipe'] });
  const entry = { process: processChild, name, log: '' }; children.push(entry);
  for (const stream of [processChild.stdout!, processChild.stderr!]) stream.on('data', data => { entry.log = (entry.log + String(data)).slice(-30_000); });
  return processChild;
}
async function open(port: number): Promise<boolean> {
  return new Promise(resolveOpen => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (result: boolean) => { socket.destroy(); resolveOpen(result); };
    socket.setTimeout(1000); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}
async function wait(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !stopped) { if (await check()) return; await delay(200); }
  throw new Error(`Local dependency did not become ready: ${label}`);
}
const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '--max-old-space-size=128' };
try {
  for (const tunnel of [{ name: 'pg', port: Number(pg.port), namespace: 'db', service: 'crawler-pg-pool', target: 5432 },
    { name: 'temporal', port: Number(temporal.split(':')[1]), namespace: 'temporal', service: 'temporal-frontend', target: 7233 }]) {
    if (!(await open(tunnel.port))) {
      const tunnelEnv = { ...base, K3S_CONFIG_FILE: '/dev/null', KUBECONFIG: process.env.KUBECONFIG ?? '/home/ubuntu/.kube/config' };
      if (tunnel.name === 'pg') {
        // Existing main-owned helper restarts kubectl after connection-reset exits.
        start('pg-tunnel', process.execPath, ['--import', 'tsx', 'scripts/dev/pg-tunnel.ts', String(tunnel.port)], tunnelEnv);
      } else {
        start('temporal-tunnel', 'kubectl', ['-n', tunnel.namespace, 'port-forward', '--address', '127.0.0.1', `service/${tunnel.service}`, `${tunnel.port}:${tunnel.target}`], tunnelEnv);
      }
      await wait(() => open(tunnel.port), tunnel.name);
    }
  }
  for (const api of [{ name: 'control', url: control }, { name: 'ingest', url: ingest }]) {
    // Never replace or stop an existing listener.
    if (!(await open(Number(api.url.port)))) start(api.name, process.execPath,
      [`--env-file=${backendFile}`, '--import', 'tsx', `apps/${api.name === 'control' ? 'control-api' : 'ingest'}/src/main.ts`],
      { ...base, HOST: '127.0.0.1', CONTROL_PORT: control.port, INGEST_PORT: ingest.port, PG_POOL_MAX: '1', CONSOLE_PG_POOL_MAX: '1' });
    await wait(async () => { try { return (await fetch(new URL('/readyz', api.url), { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, api.name);
  }
  const acceptance = start('acceptance', process.execPath, ['--import', 'tsx', 'apps/execution-worker/scripts/live-acceptance.ts'], { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' });
  const [code] = await once(acceptance, 'exit');
  if (code !== 0) throw new Error('Live acceptance failed; inspect private acceptance log');
  const result = JSON.parse(await readFile(resolve(out, 'results.json'), 'utf8')) as { result: string; checks: string[] };
  console.log(JSON.stringify({ result: result.result, checks: result.checks, evidence_directory: out }, null, 2));
} finally {
  for (const entry of [...children].reverse()) {
    const child = entry.process;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await writeFile(resolve(out, `${entry.name}.log`), entry.log, { mode: 0o600 });
  }
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
