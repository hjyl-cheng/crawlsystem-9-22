import { setTimeout } from 'node:timers/promises';
import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { type WorkflowStarter } from '@crawlsystem/contracts';
import { IntentDispatcher } from './dispatcher.ts';
import { temporalOptions } from './temporal-config.ts';
function required(name:string):string {const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}
// Execution Agent owns this module. A missing adapter is a startup error, never a mock workflow.
const moduleName='@crawlsystem/execution-client';
const adapter=await import(moduleName);
const starter:WorkflowStarter & {close():Promise<void>}=await adapter.createWorkflowStarter(temporalOptions());
const pool=createPool(),dispatcher=new IntentDispatcher(new Store(pool),starter,required('M1_WORKSPACE_ID'));
let stopping=false;process.once('SIGINT',()=>{stopping=true;});process.once('SIGTERM',()=>{stopping=true;});
try {
  while(!stopping) {
    try {const worked=await dispatcher.tick();if(!worked)await setTimeout(1000);}
    catch {process.stderr.write('Dispatcher dependency unavailable; durable intents retained\n');await setTimeout(3000);}
  }
} finally {await starter.close();await pool.end();}
