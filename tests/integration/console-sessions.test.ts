import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { createPool } from '@crawlsystem/store/config';
import {prepareDatabase} from './database-ready.ts';
import { Store } from '@crawlsystem/store';
import { PgConsoleSessions } from '@crawlsystem/store/console-sessions';
import { contentHash } from '@crawlsystem/contracts/hash';
import { ConsoleAuth,passwordRecord } from '../../apps/control-api/src/console-auth.ts';
import { createControlApi } from '../../apps/control-api/src/app.ts';

const pool=createPool(),key=randomBytes(48),headers={'x-console-request':'1'},password='test-durable-session-password';
before(()=>prepareDatabase(pool));after(()=>pool.end());
async function account() {return {username:'reader',subject:'test-reader',workspace_id:`auth-test-${randomUUID()}`,role:'reader' as const,...await passwordRecord(password)};}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
function app(accounts:unknown,db=pool) {return createControlApi({store:new Store(db),signingKey:key,consoleAuth:new ConsoleAuth(accounts,true,Date.now,new PgConsoleSessions(db))});}
test('cookie survives a fresh API and connection pool; revocation propagates between replicas',async()=>{
  const a=await account(),first=app([a]),otherPool=createPool();
  let second:ReturnType<typeof app>|undefined;
  try {
    const response=await first.inject({method:'POST',url:'/v1/auth/login',headers,payload:{username:a.username,password}});
    assert.equal(response.statusCode,200);
    const cookie=String(response.headers['set-cookie']).split(';')[0]!;
    const secret=cookie.split('=')[1]!;
    const stored=(await pool.query('SELECT session_hash,role FROM m1.console_sessions WHERE workspace_id=$1',[a.workspace_id])).rows[0];
    assert.equal(stored.session_hash,digest(secret));assert.notEqual(stored.session_hash,secret);
    await first.close();second=app([a],otherPool);
    const restored=await second.inject({url:'/v1/session',headers:{cookie}});assert.equal(restored.statusCode,200);assert.equal(restored.json().role,'reader');
    const denied=await second.inject({method:'POST',url:'/v1/plans',headers:{...headers,cookie},payload:{request_id:randomUUID(),fixture_id:'channel-basic-v1'}});assert.equal(denied.statusCode,403);
    assert.equal((await second.inject({method:'POST',url:'/v1/auth/logout',headers:{...headers,cookie},payload:{}})).statusCode,200);
    const third=app([a]);
    try {assert.equal((await third.inject({url:'/v1/session',headers:{cookie}})).statusCode,401);}finally {await third.close();}
  } finally {await first.close();await second?.close();await otherPool.end();}
});
test('database expiration and account changes invalidate cookies without exposing session secrets',async()=>{
  const a=await account(),first=app([a]),changed=app([{...a,role:'operator'}]);
  try {
    const response=await first.inject({method:'POST',url:'/v1/auth/login',headers,payload:{username:a.username,password}});
    const cookie=String(response.headers['set-cookie']).split(';')[0]!;
    assert.equal((await changed.inject({url:'/v1/session',headers:{cookie}})).statusCode,401);
    await pool.query("UPDATE m1.console_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[a.workspace_id]);
    assert.equal((await first.inject({url:'/v1/session',headers:{cookie}})).statusCode,401);
  } finally {await first.close();await changed.close();}
});
test('login budget is shared by replicas and resets at the database deadline',async()=>{
  const a=await account(),first=app([a]),second=app([a]);
  try {
    for(let i=0;i<10;i++)assert.equal((await (i%2?first:second).inject({method:'POST',url:'/v1/auth/login',headers,payload:{username:a.username,password:'incorrect'}})).statusCode,401);
    const exhausted=await first.inject({method:'POST',url:'/v1/auth/login',headers,payload:{username:a.username,password}});
    assert.equal(exhausted.statusCode,429);assert.equal(exhausted.headers['retry-after'],'60');
    await pool.query("UPDATE m1.console_login_limits SET reset_at=clock_timestamp()-interval '1 second' WHERE authority=$1",[contentHash([a])]);
    assert.equal((await second.inject({method:'POST',url:'/v1/auth/login',headers,payload:{username:a.username,password}})).statusCode,200);
  } finally {await first.close();await second.close();}
});
test('concurrent logins cannot exceed the shared active-session capacity',async()=>{
  const a=await account(),authority=contentHash([a]),repository=new PgConsoleSessions(pool);
  await pool.query(`INSERT INTO m1.console_sessions(authority,session_hash,subject,workspace_id,role,expires_at)
    SELECT $1,repeat(md5(i::text),2),$2,$3,'reader',clock_timestamp()+interval '1 hour' FROM generate_series(1,198) i`,[authority,a.subject,a.workspace_id]);
  const outcomes=await Promise.all(Array.from({length:5},()=>repository.save(authority,randomBytes(32).toString('hex'),a,60_000)));
  assert.equal(outcomes.filter(Boolean).length,2);
  assert.equal(Number((await pool.query('SELECT count(*) FROM m1.console_sessions WHERE authority=$1',[authority])).rows[0].count),200);
});
