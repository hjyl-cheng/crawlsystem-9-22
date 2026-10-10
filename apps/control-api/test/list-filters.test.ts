import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import type {Store} from '@crawlsystem/store';
import {issueToken} from '@crawlsystem/http/auth';
import {createControlApi} from '../src/app.ts';

for(const [path,method,filter] of [
  ['/v1/candidates','candidates',{state:'ADMITTED',category:'Tech',search:'UC3L23SlbXIkxvttMI-mDOsw'}],
  ['/v1/queries','queries',{state:'ACTIVE',category:'Tech',country:'BR',search:'Google Developers tutorials'}],
  ['/v1/updates','updates',{state:'due',search:'Google Developers'}],
  ['/v1/agent/tasks','agentTasks',{state:'waiting'}],
] as const) {
  test(`${path} accepts its page filters and rejects invalid or unknown query fields`,async()=>{
    const key=randomBytes(32),calls:unknown[][]=[],page={items:[],next_cursor:null};
    const store={[method]:async(...args:unknown[])=>{calls.push(args);return method==='updates'?{page}:page;}} as unknown as Store;
    const app=createControlApi({store,signingKey:key});
    const headers={authorization:`Bearer ${await issueToken({subject:'filter-test',workspace_id:'filter-test',role:'reader'},key)}`};
    try {
      const query=new URLSearchParams({limit:'20',cursor:'20',...filter});
      assert.equal((await app.inject({url:`${path}?${query}`,headers})).statusCode,200);
      assert.deepEqual(calls[0]?.slice(1),[20,20,method==='agentTasks'?filter.state:filter]);
      for(const [name,value] of [['state','invalid'],['unexpected','1'],['cursor','-1'],['limit','1000']] as const) {
        const invalid=new URLSearchParams(query);invalid.set(name,value);
        const response=await app.inject({url:`${path}?${invalid}`,headers});
        assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'INVALID_REQUEST');
      }
      assert.equal(calls.length,1,'Rejected filters must not reach the store');
    }finally{await app.close();}
  });
}
