import { createPool } from '@crawlsystem/store/config';
import { Store } from '@crawlsystem/store';
import { fixtureSubmission } from '@crawlsystem/contracts/hash';
const pool=createPool();
pool.on('connect',client=>{
  const original=client.query.bind(client);
  client.query=(async(...args:unknown[])=>{
    const result=await (original as (...args:unknown[])=>Promise<unknown>)(...args);
    if(typeof args[0]==='string' && args[0].startsWith('INSERT INTO control.receipts')) {
      process.send?.('receipt-written-before-commit');
      await new Promise(()=>{});
    }
    return result;
  }) as typeof client.query;
});
const worker={subject:'worker',workspace_id:process.env.M1_CRASH_WORKSPACE!,role:'worker' as const};
const store=new Store(pool),context=await store.getInput(worker,process.env.M1_CRASH_PLAN!);
await store.apply(worker,fixtureSubmission(context,'ABOUT'));
throw new Error('Crash fixture should have been killed before commit');
