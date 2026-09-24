import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULT_TASK_QUEUE } from '@crawlsystem/contracts';
import { temporalTokenSource } from './http.ts';

export interface TemporalOptions {
  address: string; namespace: string; taskQueue: string;
  tls?: { serverRootCACertificate: Buffer; clientCertPair: { crt: Buffer; key: Buffer }; serverNameOverride: string };
  /** Temporal namespace token (JWT) source; called before connect and on each refresh. */
  apiKey?: () => Promise<string>;
}
export function validateTemporalOptions(options: TemporalOptions): void {
  if (!options.address || /[\s/@]/.test(options.address)) throw new Error('Invalid TEMPORAL_ADDRESS');
  if (!/^crawlsystem-m1-[a-z0-9-]+$/.test(options.namespace)) throw new Error('An isolated crawlsystem-m1-* namespace is required');
  if (!/^[a-zA-Z0-9:_./-]{1,160}$/.test(options.taskQueue)) throw new Error('Invalid TEMPORAL_TASK_QUEUE');
  if (options.tls && (!options.tls.serverRootCACertificate?.length || !options.tls.clientCertPair?.crt?.length || !options.tls.clientCertPair?.key?.length || !options.tls.serverNameOverride)) throw new Error('Complete Temporal mTLS configuration is required');
  if (!options.tls && !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(options.address)) throw new Error('Temporal TLS is required outside loopback');
}
export function temporalOptions(env: NodeJS.ProcessEnv = process.env): TemporalOptions {
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`${name} is required`); return value; };
  const options: TemporalOptions = { address: required('TEMPORAL_ADDRESS'), namespace: required('TEMPORAL_NAMESPACE'), taskQueue: env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE };
  if (env.TEMPORAL_ALLOW_INSECURE_LOOPBACK !== 'true') options.tls = {
    serverRootCACertificate: readFileSync(required('TEMPORAL_TLS_CA_FILE')),
    clientCertPair: { crt: readFileSync(required('TEMPORAL_TLS_CERT_FILE')), key: readFileSync(required('TEMPORAL_TLS_KEY_FILE')) },
    serverNameOverride: required('TEMPORAL_TLS_SERVER_NAME'),
  };
  // Namespace authorization: a file for local tools, or a ServiceAccount exchange at Control in-cluster.
  if (env.TEMPORAL_API_KEY_FILE && env.TEMPORAL_API_KEY_MODE === 'workload') throw new Error('Set TEMPORAL_API_KEY_FILE or TEMPORAL_API_KEY_MODE=workload, not both');
  if (env.TEMPORAL_API_KEY_FILE) { const file = env.TEMPORAL_API_KEY_FILE; options.apiKey = async () => (await readFile(file, 'utf8')).trim(); }
  else if (env.TEMPORAL_API_KEY_MODE === 'workload') {
    const identityFile = required('WORKLOAD_IDENTITY_TOKEN_FILE');
    options.apiKey = temporalTokenSource({ controlUrl: required('CONTROL_API_URL'), identityToken: () => readFile(identityFile, 'utf8') });
  } else if (env.TEMPORAL_API_KEY_MODE) throw new Error('TEMPORAL_API_KEY_MODE must be workload');
  validateTemporalOptions(options);
  return options;
}
/** Refresh the connection's Temporal token; the source renews at half-life, so polling is cheap. */
export function refreshTemporalApiKey(apiKey: (() => Promise<string>) | undefined, apply: (token: string) => unknown, onError: () => void, intervalMs = 60_000): () => void {
  if (!apiKey) return () => {};
  let last = '';
  const timer = setInterval(() => { void apiKey().then(async token => { if (token !== last) { await apply(token); last = token; } }).catch(onError); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
// Temporal clients read mTLS material once at connect. When cert-manager renews
// the mounted files, stop gracefully so Kubernetes restarts us with the new pair.
export function watchTlsFiles(env: NodeJS.ProcessEnv, onChange: () => void, intervalMs = 60_000): () => void {
  const files = ['TEMPORAL_TLS_CA_FILE', 'TEMPORAL_TLS_CERT_FILE', 'TEMPORAL_TLS_KEY_FILE'].map(name => env[name]).filter((file): file is string => !!file);
  if (!files.length) return () => {};
  const digest = () => { const hash = createHash('sha256'); for (const file of files) { try { hash.update(readFileSync(file)); } catch { hash.update('missing'); } } return hash.digest('hex'); };
  const initial = digest();
  const timer = setInterval(() => { if (digest() !== initial) { clearInterval(timer); onChange(); } }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
