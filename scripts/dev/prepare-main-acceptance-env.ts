import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { issueToken, loadSigningKey } from '@crawlsystem/http/auth';
import { temporalOptions } from '../../apps/control-api/src/temporal-config.ts';

// Run with the private main backend environment. No PG credentials or signing
// keys are copied to the test driver/Worker configuration.
temporalOptions();
const directory = resolve('.runtime');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const workspace = `main-joint-${randomUUID()}`, worker = `main-worker-${randomUUID()}`;
const key = loadSigningKey();
const workerToken = resolve(directory, 'main-joint-worker-token'), operatorToken = resolve(directory, 'main-joint-operator-token');
for (const [path, role, subject] of [[workerToken,'worker',worker],[operatorToken,'operator','main-joint-operator']] as const) {
  writeFileSync(path, await issueToken({ workspace_id: workspace, subject, role }, key, 3600) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}
const values: Record<string,string> = {
  CONTROL_API_URL: 'http://127.0.0.1:18120', INGEST_API_URL: 'http://127.0.0.1:18121',
  WORKER_TOKEN_FILE: workerToken, OPERATOR_TOKEN_FILE: operatorToken,
  WORKER_ID: worker, SERVER_ID: process.env.SERVER_ID ?? 'main-integration',
  BUILD_VERSION: `main-joint-${new Date().toISOString()}`,
  EXECUTION_BACKEND_ENV_FILE: resolve('.runtime/main.env'),
  M1_VERIFY_DISPATCH_RECOVERY: 'true',
};
for (const name of ['TEMPORAL_ADDRESS','TEMPORAL_NAMESPACE','TEMPORAL_TASK_QUEUE','TEMPORAL_TLS_CA_FILE','TEMPORAL_TLS_CERT_FILE','TEMPORAL_TLS_KEY_FILE','TEMPORAL_TLS_SERVER_NAME']) {
  const value = process.env[name]; if (!value) throw new Error(`${name} is required`); values[name] = value;
}
for (const value of Object.values(values)) if (/[\r\n'"]/.test(value)) throw new Error('Environment values cannot contain quotes or newlines');
const output = resolve(directory, 'main-joint.env');
writeFileSync(output, Object.entries(values).map(([name,value]) => `${name}='${value}'`).join('\n') + '\n', { mode: 0o600 });
chmodSync(output, 0o600);
console.log(JSON.stringify({ configuration: output, workspace_id: workspace, worker_id: worker, token_lifetime_seconds: 3600 }));
