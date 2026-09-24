import type { WorkflowStarter } from '@crawlsystem/contracts';
import { Store } from '@crawlsystem/store';

export class IntentDispatcher {
  constructor(private store:Store,private starter:WorkflowStarter,private workspaceId:string) {}
  async tick():Promise<boolean> {
    await this.store.expirePlans(20,this.workspaceId);
    const intent=await this.store.claimIntent(30,this.workspaceId);
    if(!intent) return false;
    try {
      if(intent.kind==='START') {
        if(['COMPLETED','FAILED','CANCELLED'].includes(intent.plan_status)||Date.parse(intent.deadline_at)<=Date.now()) {
          await this.store.finishIntent(intent,'SKIPPED');return true;
        }
        const result=await withTimeout(this.starter.start(intent.input),10_000);
        if(result.workflow_id!==intent.input.workflow_id) throw new Error('Workflow identity mismatch');
        await this.store.finishIntent(intent,'DONE',result.run_id);
      } else {
        if(intent.start_never_dispatched) {
          await this.store.finishIntent(intent,'SKIPPED');return true;
        }
        await withTimeout(this.starter.cancel(intent.input.workflow_id),10_000);
        await this.store.finishIntent(intent,'DONE');
      }
    } catch {
      // Do not retain arbitrary SDK errors, which can contain endpoints or credentials.
      await this.store.retryIntent(intent,'Temporal operation not acknowledged; retry stable workflow identity');
    }
    return true;
  }
}
async function withTimeout<T>(promise:Promise<T>,ms:number):Promise<T> {
  let timer:NodeJS.Timeout|undefined;
  try {return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Temporal acknowledgement deadline')),ms);})]);}
  finally {clearTimeout(timer);}
}
