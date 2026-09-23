import { readFileSync } from 'node:fs';
import { DEFAULT_TASK_QUEUE } from '@crawlsystem/contracts';
export function temporalOptions(env:NodeJS.ProcessEnv=process.env) {
  const required=(name:string)=>{const value=env[name];if(!value)throw new Error(`${name} is required`);return value;};
  const namespace=required('TEMPORAL_NAMESPACE');
  if(!/^crawlsystem-m1-[a-z0-9-]+$/.test(namespace))throw new Error('M1 requires an isolated crawlsystem-m1-* namespace');
  return {address:required('TEMPORAL_ADDRESS'),namespace,taskQueue:env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE,
    tls:{serverRootCACertificate:readFileSync(required('TEMPORAL_TLS_CA_FILE')),clientCertPair:{crt:readFileSync(required('TEMPORAL_TLS_CERT_FILE')),key:readFileSync(required('TEMPORAL_TLS_KEY_FILE'))},serverNameOverride:required('TEMPORAL_TLS_SERVER_NAME')}};
}
