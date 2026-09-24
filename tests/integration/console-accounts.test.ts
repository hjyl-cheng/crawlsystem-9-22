import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '@crawlsystem/store/config';
import {prepareDatabase} from './database-ready.ts';
import { PgConsoleSessions } from '@crawlsystem/store/console-sessions';
import { StoreError } from '@crawlsystem/store';
import { ConsoleAuth,passwordRecord } from '../../apps/control-api/src/console-auth.ts';
import { PgAccountStore } from '../../apps/control-api/src/console-db.ts';
import { setAccountPassword,setAccountDisabled } from '../../apps/control-api/src/console-account-ops.ts';

const pool=createPool(),budget=new PgConsoleSessions(pool),password='isolated-account-password';
before(async()=>{
  await prepareDatabase(pool);
  // Apply the account schema only inside createPool's isolated M1 test database.
  // Production ownership/grants are deployment concerns, never edited by tests.
  const present=await pool.query("SELECT to_regclass('console.accounts') AS name");
  if(!present.rows[0].name){
    const sql=await readFile(new URL('../../database/console/001_console.sql',import.meta.url),'utf8');
    await pool.query(sql.replace('CREATE SCHEMA console AUTHORIZATION crawler_owner','CREATE SCHEMA console').replace(/^GRANT .*;$/gm,''));
  }
});
after(()=>pool.end());
async function account(){
  const username=`test-${randomUUID()}`,record=await passwordRecord(password);
  const a={username,subject:username,workspace_id:username,role:'reader' as const,...record};
  await pool.query('INSERT INTO console.accounts(username,subject,workspace_id,role,password_salt,password_hash) VALUES($1,$1,$1,$2,$3,$4)',[username,a.role,a.salt,a.password_hash]);
  return a;
}
const store=()=>new PgAccountStore(pool,budget);
test('database accounts restore sessions across instances and resolve current permissions',async()=>{
  const a=await account(),first=new ConsoleAuth(store()),second=new ConsoleAuth(store());
  const login=await first.login(a.username,password),cookie=login.cookie.split(';')[0]!;
  assert.equal((await second.authenticate(cookie)).role,'reader');
  await pool.query("UPDATE console.accounts SET role='operator' WHERE username=$1",[a.username]);
  assert.equal((await second.authenticate(cookie)).role,'operator');
  await setAccountDisabled(pool,a.username,true);
  await assert.rejects(()=>first.authenticate(cookie),e=>e instanceof StoreError&&e.code==='UNAUTHENTICATED');
  await setAccountDisabled(pool,a.username,false);
  await assert.rejects(()=>second.authenticate(cookie),e=>e instanceof StoreError&&e.code==='UNAUTHENTICATED');
});
test('password update atomically revokes sessions and fences an already-verified old password',async()=>{
  const a=await account(),repository=store(),auth=new ConsoleAuth(repository);
  const cookie=(await auth.login(a.username,password)).cookie.split(';')[0]!;
  const changed=await passwordRecord('replacement-account-password');
  await setAccountPassword(pool,a.username,changed);
  await assert.rejects(()=>auth.authenticate(cookie),e=>e instanceof StoreError&&e.code==='UNAUTHENTICATED');
  await assert.rejects(()=>repository.createSession(randomBytes(32).toString('hex'),a.username,new Date(),new Date(Date.now()+60000),a),e=>e instanceof StoreError&&e.code==='UNAUTHENTICATED');
  await assert.rejects(()=>auth.login(a.username,password),e=>e instanceof StoreError&&e.code==='UNAUTHENTICATED');
  const fresh=await auth.login(a.username,'replacement-account-password');assert.equal(fresh.principal.subject,a.subject);
  await auth.revoke(fresh.cookie.split(';')[0]);
});
test('parallel database account logins cannot exceed the global session cap',async()=>{
  const a=await account(),repository=store();
  const current=Number((await pool.query('SELECT count(*) FROM console.sessions WHERE expires_at>clock_timestamp()')).rows[0].count);
  assert.ok(current<198);
  await pool.query(`INSERT INTO console.sessions(token_hash,username,expires_at)
    SELECT repeat(md5($1||i::text),2),$1,clock_timestamp()+interval '1 hour' FROM generate_series(1,$2::integer) i`,[a.username,198-current]);
  try {
    const results=await Promise.all(Array.from({length:5},()=>repository.createSession(randomBytes(32).toString('hex'),a.username,new Date(),new Date(Date.now()+60000),a)));
    assert.equal(results.filter(Boolean).length,2);
    assert.equal(Number((await pool.query('SELECT count(*) FROM console.sessions WHERE expires_at>clock_timestamp()')).rows[0].count),200);
  } finally {await pool.query('DELETE FROM console.sessions WHERE username=$1',[a.username]);}
});
test('account listing stays inside the workspace, reports disabled accounts and counts only live sessions',async()=>{
  const a=await account(),other=await account(),repository=store(),auth=new ConsoleAuth(repository);
  const second=`test-${randomUUID()}`,record=await passwordRecord(password);
  await pool.query('INSERT INTO console.accounts(username,subject,workspace_id,role,password_salt,password_hash,disabled_at) VALUES($1,$1,$2,$3,$4,$5,clock_timestamp())',[second,a.workspace_id,'operator',record.salt,record.password_hash]);
  const cookie=(await auth.login(a.username,password)).cookie.split(';')[0]!;
  await pool.query(`INSERT INTO console.sessions(token_hash,username,created_at,expires_at) VALUES(repeat(md5($1),2),$1,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')`,[a.username]);
  try {
    const listed=await auth.listAccounts({subject:a.subject,workspace_id:a.workspace_id,role:'operator'});
    assert.equal(listed.source,'DATABASE');
    assert.deepEqual(listed.items.map(i=>i.username).sort(),[a.username,second].sort());
    assert.ok(!listed.items.some(i=>i.username===other.username));
    const mine=listed.items.find(i=>i.username===a.username)!,disabled=listed.items.find(i=>i.username===second)!;
    assert.equal(mine.active_sessions,1);assert.equal(mine.status,'ACTIVE');assert.ok(mine.latest_session_at&&mine.created_at);
    assert.equal(disabled.status,'DISABLED');assert.equal(disabled.role,'operator');assert.equal(disabled.active_sessions,0);assert.equal(disabled.latest_session_at,null);
    assert.doesNotMatch(JSON.stringify(listed),new RegExp(`${a.salt}|${a.password_hash}`));
    for(const role of ['reader','worker'] as const)await assert.rejects(()=>auth.listAccounts({subject:'w',workspace_id:a.workspace_id,role}),e=>e instanceof StoreError&&e.code==='FORBIDDEN');
  } finally {await auth.revoke(cookie);await pool.query('DELETE FROM console.sessions WHERE username=$1',[a.username]);}
});
