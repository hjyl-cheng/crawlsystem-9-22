import { readFileSync } from 'node:fs';
import { DEFAULT_TASK_QUEUE } from '@crawlsystem/contracts';

export interface TemporalOptions {
  address: string; namespace: string; taskQueue: string;
  tls?: { serverRootCACertificate: Buffer; clientCertPair: { crt: Buffer; key: Buffer }; serverNameOverride: string };
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
  validateTemporalOptions(options);
  return options;
}
