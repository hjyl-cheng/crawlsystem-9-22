import {chmodSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {IdSchema} from '@crawlsystem/contracts';
import {loadSigningKey,issueToken} from '@crawlsystem/http/auth';
import {temporalOptions} from '../../apps/control-api/src/temporal-config.ts';
// Explicit allowlist: PG, account credentials and the signing key never enter
// the generated Worker environment. The token is renewed without changing IDs.
const worker=IdSchema.parse(process.env.WORKER_ID),workspace=IdSchema.parse(process.env.M1_WORKSPACE_ID);
const server=IdSchema.parse(process.env.SERVER_ID);
temporalOptions();
const runtime=resolve('.runtime');mkdirSync(runtime,{recursive:true,mode:0o700});
const path=resolve(process.argv[2]??'.runtime/execution.env');
if(dirname(path)!==realpathSync(runtime))throw new Error('Worker config must be a file directly in .runtime');
const tokenFile=resolve(runtime,'execution-worker-token');
const values:Record<string,string>={WORKER_ID:worker,SERVER_ID:server,M1_WORKSPACE_ID:workspace,WORKER_TOKEN_FILE:tokenFile,BUILD_VERSION:process.env.BUILD_VERSION??'development'};
for(const name of ['CONTROL_API_URL','INGEST_API_URL','TEMPORAL_ADDRESS','TEMPORAL_NAMESPACE','TEMPORAL_TASK_QUEUE','TEMPORAL_TLS_CA_FILE','TEMPORAL_TLS_CERT_FILE','TEMPORAL_TLS_KEY_FILE','TEMPORAL_TLS_SERVER_NAME']){
  const value=process.env[name];if(!value)throw new Error(`${name} is required`);values[name]=value;
}
for(const name of ['CONTROL_API_URL','INGEST_API_URL']){const url=new URL(values[name]!);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error(`${name} must be a credential-free HTTP(S) URL`);}
for(const value of Object.values(values))if(/[\r\n'"]/.test(value))throw new Error('Worker env values cannot contain quotes or newlines');
const token=await issueToken({subject:worker,workspace_id:workspace,role:'worker'},loadSigningKey(),3600);
writeFileSync(tokenFile,token+'\n',{mode:0o600});chmodSync(tokenFile,0o600);
writeFileSync(path,Object.entries(values).map(([k,v])=>`${k}='${v}'`).join('\n')+'\n',{mode:0o600});chmodSync(path,0o600);
console.log(JSON.stringify({configuration:path,worker_id:worker,workspace_id:workspace,token_expires_in_seconds:3600,fields:Object.keys(values),database_credentials:false,signing_key:false}));
