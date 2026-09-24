import { writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { createWorkflowStarter } from '@crawlsystem/execution-client';
import { watchTlsFiles } from '@crawlsystem/execution-client/config';
import { RequestTracing } from '@crawlsystem/http/tracing';
import { IntentDispatcher } from './dispatcher.ts';
import { temporalOptions } from './temporal-config.ts';
function required(name:string):string {const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}
// The real Temporal adapter is linked statically; there is no mock workflow fallback.
const starter=await createWorkflowStarter(temporalOptions());
const tracing=new RequestTracing('intent-dispatcher',record=>process.stdout.write(JSON.stringify({time:new Date().toISOString(),...record})+'\n'),Number(process.env.TRACE_SAMPLE_RATIO??'0.1'));
const pool=createPool(),dispatcher=new IntentDispatcher(new Store(pool),starter,required('M1_WORKSPACE_ID'),tracing);
let stopping=false;process.once('SIGINT',()=>{stopping=true;});process.once('SIGTERM',()=>{stopping=true;});
// Renewed mTLS files: exit cleanly (intents are leased) and let Kubernetes restart us.
watchTlsFiles(process.env,()=>{process.stderr.write('Temporal client certificate changed; restarting\n');stopping=true;});
// Liveness: a hung loop stops touching this file and the probe restarts the Pod.
const alive=process.env.DISPATCHER_ALIVE_FILE;
try {
  while(!stopping) {
    if(alive)writeFileSync(alive,String(Date.now()));
    try {const worked=await dispatcher.tick();if(!worked)await setTimeout(1000);}
    catch {process.stderr.write('Dispatcher dependency unavailable; durable intents retained\n');await setTimeout(3000);}
  }
} finally {await tracing.close();await starter.close();await pool.end();}
