import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { PgConsoleSessions } from '@crawlsystem/store/console-sessions';
import { loadSigningKey } from '@crawlsystem/http/auth';
import { readFileSync } from 'node:fs';
import { WorkloadIdentity, kubernetesTokenReviewer } from '@crawlsystem/http/workload';
import { TemporalTokenIssuer } from '@crawlsystem/http/temporal-token';
import { listen } from '@crawlsystem/http/runtime';
import { createControlApi } from './app.ts';
import { ConsoleAuth } from './console-auth.ts';
import { createConsolePool,PgAccountStore } from './console-db.ts';
const pool=createPool(),shared=new PgConsoleSessions(pool);
const consolePool=process.env.CONSOLE_DATABASE_URL?createConsolePool():undefined;
const secure=process.env.CONSOLE_COOKIE_SECURE!=='false',signingKey=loadSigningKey();
// Enabled only in-cluster, where Workers authenticate with their projected ServiceAccount token.
// Temporal namespace tokens: ES256 key only here; Temporal trusts the public JWKS ConfigMap.
const temporal=process.env.TEMPORAL_JWT_KEY_FILE?{issuer:await TemporalTokenIssuer.fromPem(readFileSync(process.env.TEMPORAL_JWT_KEY_FILE,'utf8'),Number(process.env.TEMPORAL_TOKEN_SECONDS??'900')),
  permissions:JSON.parse(process.env.TEMPORAL_WORKLOAD_PERMISSIONS??'{}') as Record<string,string[]>}:undefined;
const workloadIdentity=process.env.WORKLOAD_SERVICE_ACCOUNT?new WorkloadIdentity({reviewer:kubernetesTokenReviewer(),serviceAccount:process.env.WORKLOAD_SERVICE_ACCOUNT,
  audience:process.env.WORKLOAD_TOKEN_AUDIENCE??'crawlsystem-control',workspaceId:process.env.M1_WORKSPACE_ID??'',signingKey,lifetimeSeconds:Number(process.env.WORKLOAD_TOKEN_SECONDS??'900'),temporal}):undefined;
const consoleAuth=consolePool?new ConsoleAuth(new PgAccountStore(consolePool,shared),secure):process.env.M1_CONSOLE_ACCOUNTS_FILE?ConsoleAuth.fromFile(process.env.M1_CONSOLE_ACCOUNTS_FILE,secure,shared):undefined;
const app=createControlApi({store:new Store(pool),signingKey,workloadIdentity,logger:true,allowedOrigin:process.env.CONSOLE_ORIGIN,consoleAuth,readiness:consolePool?async()=>{await consolePool.query('SELECT 1 FROM console.accounts LIMIT 0');await pool.query('SELECT 1 FROM m1.console_login_limits LIMIT 0');}:undefined,metricsWorkspace:process.env.M1_WORKSPACE_ID});
if(consolePool)app.addHook('onClose',async()=>{await consolePool.end();});
await listen(app,pool,Number(process.env.CONTROL_PORT??'18100'));
