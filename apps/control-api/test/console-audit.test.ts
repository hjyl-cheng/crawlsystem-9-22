import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import type {Store} from '@crawlsystem/store';
import {issueToken} from '@crawlsystem/http/auth';
import {createControlApi} from '../src/app.ts';
import {ConsoleAuth,passwordRecord} from '../src/console-auth.ts';
import type {AuditStart,ConsoleAuditRepository} from '../src/console-audit.ts';
const key=randomBytes(32),origin='https://audit.example.test',password='test-audit-password-47';
const account={username:'audit-user',subject:'audit-actor',workspace_id:'audit-workspace',role:'operator' as const,...await passwordRecord(password)};
function fixture(){
  const records:Array<AuditStart&{id:string;status?:number}>=[];let calls=0,failBegin=false,failFinish=false;
  const audit:ConsoleAuditRepository={
    async begin(input){if(failBegin)throw new Error('audit unavailable');const id=crypto.randomUUID();records.push({...input,id});return id;},
    async finish(id,status){if(failFinish)throw new Error('audit finish unavailable');records.find(e=>e.id===id)!.status=status;},
    async account(name){return name===account.username?{workspace_id:account.workspace_id,actor:account.subject,username:name,role:account.role}:undefined;},
    async list(p,q){return {workspace:p.workspace_id,query:q};},async summary(p){return {workspace:p.workspace_id};},
  };
  const store={async queryCommand(p:{role:string}){calls++;if(p.role==='reader'){const {StoreError}=await import('@crawlsystem/store');throw new StoreError('FORBIDDEN','No permission',403);}return {ok:true};}} as unknown as Store;
  const app=createControlApi({store,signingKey:key,allowedOrigin:origin,consoleAuth:new ConsoleAuth([account]),audit});
  return {app,records,failBegin:()=>{failBegin=true;},failFinish:()=>{failFinish=true;},calls:()=>calls};
}
test('login, rejected credentials and logout retain identity without password or cookie material',async()=>{
  const f=fixture(),headers={origin,'x-console-request':'1'};
  try{
    assert.equal((await f.app.inject({method:'POST',url:'/v1/auth/login',headers,payload:{username:account.username,password:'wrong-password'}})).statusCode,401);
    const response=await f.app.inject({method:'POST',url:'/v1/auth/login',headers,payload:{username:account.username,password}});assert.equal(response.statusCode,200);
    const cookie=String(response.headers['set-cookie']).split(';')[0]!;
    assert.equal((await f.app.inject({method:'POST',url:'/v1/auth/logout',headers:{...headers,cookie},payload:{}})).statusCode,200);
    assert.deepEqual(f.records.map(e=>[e.kind,e.actor,e.status]),[['LOGIN',account.subject,401],['LOGIN',account.subject,200],['LOGOUT',account.subject,200]]);
    assert.doesNotMatch(JSON.stringify(f.records),new RegExp(password+'|'+account.password_hash+'|'+cookie.split('=')[1]));
    assert.equal((await f.app.inject({url:'/v1/session',headers:{cookie}})).statusCode,401);
  }finally{await f.app.close();}
});
test('human commands record the actual result and UUID; machine writes are excluded',async()=>{
  const f=fixture(),id=crypto.randomUUID(),command=crypto.randomUUID();
  try{
    for(const role of ['operator','reader','worker'] as const){const token=await issueToken({subject:role,workspace_id:'ws-a',role},key);
      const r=await f.app.inject({method:'POST',url:'/v1/queries/'+id,headers:{authorization:'Bearer '+token},payload:{command_id:command,secret:'do-not-retain'}});assert.equal(r.statusCode,role==='reader'?403:200);}
    assert.equal(f.records.length,2);assert.deepEqual(f.records.map(e=>[e.actor,e.workspace_id,e.target,e.command_id,e.status]),[['operator','ws-a',id,command,200],['reader','ws-a',id,command,403]]);
    assert.ok(!JSON.stringify(f.records).includes('do-not-retain'));
  }finally{await f.app.close();}
});
test('an audit outage fences commands before mutation; a result outage leaves a recoverable pending record',async()=>{
  const f=fixture(),token=await issueToken({subject:'op',workspace_id:'ws',role:'operator'},key),request={method:'POST' as const,url:'/v1/queries/'+crypto.randomUUID(),headers:{authorization:'Bearer '+token},payload:{}};
  try{f.failBegin();assert.equal((await f.app.inject(request)).statusCode,500);assert.equal(f.calls(),0);}finally{await f.app.close();}
  const g=fixture();try{g.failFinish();assert.equal((await g.app.inject(request)).statusCode,200);assert.equal(g.calls(),1);assert.equal(g.records[0]!.status,undefined);}finally{await g.app.close();}
});
test('audit views require an operator and validate finite filters and cursors',async()=>{
  const f=fixture();try{
    for(const role of ['reader','worker'] as const){const token=await issueToken({subject:role,workspace_id:'ws',role},key);for(const url of ['/v1/console/audit','/v1/console/logins/summary'])assert.equal((await f.app.inject({url,headers:{authorization:'Bearer '+token}})).statusCode,403);}
    const token=await issueToken({subject:'op',workspace_id:'ws-only',role:'operator'},key),headers={authorization:'Bearer '+token};
    assert.equal((await f.app.inject({url:'/v1/console/audit?days=91',headers})).statusCode,400);
    assert.equal((await f.app.inject({url:'/v1/console/audit?cursor=bad',headers})).statusCode,400);
    assert.equal((await f.app.inject({url:'/v1/console/audit?workspace_id=other',headers})).statusCode,400);
    assert.equal((await f.app.inject({url:'/v1/console/audit?kind=LOGIN',headers})).json().workspace,'ws-only');
  }finally{await f.app.close();}
});
