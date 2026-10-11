import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import type {Store} from '@crawlsystem/store';
import {requireRole} from '@crawlsystem/store';
import type {ProxyStore} from '@crawlsystem/store/proxies';
import {issueToken} from '@crawlsystem/http/auth';
import {createControlApi} from '../src/app.ts';
test('availability route authenticates the workspace and permits bounded filters for readers and operators',async()=>{
  const key=randomBytes(32),calls:unknown[]=[];
  const proxies={async availability(p:Parameters<ProxyStore['availability']>[0],q:Parameters<ProxyStore['availability']>[1]){requireRole(p,'reader','operator');calls.push([p.workspace_id,q]);return {ok:true};}} as unknown as ProxyStore;
  const app=createControlApi({store:{} as Store,signingKey:key,proxies});
  try{
    assert.equal((await app.inject({url:'/v1/proxies/availability'})).statusCode,401);
    for(const role of ['reader','operator','node','worker'] as const){const t=await issueToken({subject:role,workspace_id:'only-this-space',role},key);assert.equal((await app.inject({url:'/v1/proxies/availability?resolution=hour&provider=example',headers:{authorization:'Bearer '+t}})).statusCode,['reader','operator'].includes(role)?200:403);}
    assert.deepEqual(calls,[['only-this-space',{resolution:'hour',provider:'example'}],['only-this-space',{resolution:'hour',provider:'example'}]]);
    const token=await issueToken({subject:'rd',workspace_id:'space',role:'reader'},key);
    for(const q of ['resolution=minute','workspace_id=other','provider=','server_id=%20','resolution=hour&days=999'])assert.equal((await app.inject({url:'/v1/proxies/availability?'+q,headers:{authorization:'Bearer '+token}})).statusCode,400);
  }finally{await app.close();}
});
