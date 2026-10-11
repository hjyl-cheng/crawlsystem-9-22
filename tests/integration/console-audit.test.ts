import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createPool} from '@crawlsystem/store/config';
import {PgConsoleSessions} from '@crawlsystem/store/console-sessions';
import {prepareDatabase} from './database-ready.ts';
import {createControlApi} from '../../apps/control-api/src/app.ts';
import {ConsoleAuth,passwordRecord} from '../../apps/control-api/src/console-auth.ts';
import {PgAccountStore} from '../../apps/control-api/src/console-db.ts';
import {PgConsoleAudit} from '../../apps/control-api/src/console-audit.ts';
import {addAccount,setAccountPassword,setAccountDisabled} from '../../apps/control-api/src/console-account-ops.ts';
import {ConsoleAuditQuerySchema,ConsoleAuditPageSchema,ConsoleLoginSummarySchema} from '../../packages/contracts/src/console-audit.ts';
import {Store} from '@crawlsystem/store';
const pool=createPool(),workspace='audit-'+randomUUID(),password='isolated-audit-password',audit=new PgConsoleAudit(pool),budget=new PgConsoleSessions(pool),repository=new PgAccountStore(pool,budget);
before(async()=>{
  await prepareDatabase(pool);
  if(!(await pool.query("SELECT to_regclass('console.accounts') AS name")).rows[0].name)await pool.query((await readFile('database/console/001_console.sql','utf8')).replace('CREATE SCHEMA console AUTHORIZATION crawler_owner','CREATE SCHEMA console').replace(/^GRANT .*;$/gm,''));
  if(!(await pool.query("SELECT to_regclass('console.audit') AS name")).rows[0].name)await pool.query((await readFile('database/console/002_audit.sql','utf8')).replace(/^GRANT .*;$/gm,''));
});
after(async()=>{await pool.query('DELETE FROM console.audit WHERE workspace_id=$1',[workspace]);await pool.query('DELETE FROM console.accounts WHERE workspace_id=$1',[workspace]);await pool.end();});
async function account(){const username='audit-'+randomUUID(),a={username,subject:username,workspace_id:workspace,role:'operator' as const,...await passwordRecord(password)};await addAccount(pool,a);return a;}
const operator={subject:'auditor',workspace_id:workspace,role:'operator' as const};
test('real login and logout persist across API instances and session cleanup',async()=>{
  const a=await account(),origin='https://test.example',headers={origin,'x-console-request':'1'};
  const app=createControlApi({store:new Store(pool),signingKey:randomBytes(32),allowedOrigin:origin,consoleAuth:new ConsoleAuth(repository),audit});
  try{
    assert.equal((await app.inject({method:'POST',url:'/v1/auth/login',headers,payload:{username:a.username,password:'wrong-password'}})).statusCode,401);
    const r=await app.inject({method:'POST',url:'/v1/auth/login',headers,payload:{username:a.username,password}});assert.equal(r.statusCode,200);
    const cookie=String(r.headers['set-cookie']).split(';')[0]!;
    assert.equal((await app.inject({method:'POST',url:'/v1/auth/logout',headers:{...headers,cookie},payload:{}})).statusCode,200);
    assert.equal((await pool.query('SELECT count(*)::int n FROM console.sessions WHERE username=$1',[a.username])).rows[0].n,0);
    const persisted=ConsoleAuditPageSchema.parse(await new PgConsoleAudit(pool).list(operator,ConsoleAuditQuerySchema.parse({actor:a.subject})));
    assert.deepEqual(persisted.items.map(e=>[e.kind,e.outcome]),[['LOGOUT','SUCCESS'],['LOGIN','SUCCESS'],['LOGIN','REJECTED']]);
    const listed=await repository.listAccounts(workspace);assert.ok(listed.items.find(i=>i.username===a.username)!.latest_session_at);
    const summary=ConsoleLoginSummarySchema.parse(await audit.summary(operator));assert.equal(summary.points.length,7);assert.equal(summary.points.at(-1)!.success,1);assert.equal(summary.points.at(-1)!.rejected,1);
    assert.doesNotMatch(JSON.stringify(persisted),new RegExp(password+'|'+a.password_hash+'|'+cookie.split('=')[1]));
  }finally{await app.close();}
});
test('workspace, actor and result filters with timestamp ties paginate without gaps or repeats',async()=>{
  const actor='same-time',ids=[];
  for(let i=0;i<6;i++){const id=await audit.begin({workspace_id:workspace,actor,username:null,role:'operator',kind:'COMMAND',action:'POST /v1/config',target:null,request_id:randomUUID(),command_id:null});ids.push(id);await audit.finish(id,i%2?403:200);}
  await pool.query("UPDATE console.audit SET occurred_at=date_trunc('second',clock_timestamp()) WHERE audit_id=ANY($1::uuid[])",[ids]);
  const found:string[]=[];let cursor:string|undefined;
  do{const r=ConsoleAuditPageSchema.parse(await audit.list(operator,ConsoleAuditQuerySchema.parse({actor,limit:2,cursor})));found.push(...r.items.map(e=>e.audit_id));cursor=r.next_cursor??undefined;}while(cursor);
  assert.equal(found.length,6);assert.equal(new Set(found).size,6);
  assert.equal(ConsoleAuditPageSchema.parse(await audit.list(operator,ConsoleAuditQuerySchema.parse({actor,outcome:'REJECTED'}))).items.length,3);
  assert.equal(ConsoleAuditPageSchema.parse(await audit.list({...operator,workspace_id:'another'},ConsoleAuditQuerySchema.parse({actor}))).items.length,0);
  await assert.rejects(()=>audit.list({...operator,role:'reader'},ConsoleAuditQuerySchema.parse({})));
});
test('account maintenance and audit commit atomically and retain revoked-session history',async()=>{
  const a=await account();await setAccountDisabled(pool,a.username,true);await setAccountDisabled(pool,a.username,false);await setAccountPassword(pool,a.username,await passwordRecord('new-isolated-password'));
  const r=await pool.query("SELECT action,outcome FROM console.audit WHERE workspace_id=$1 AND kind='ACCOUNT' AND target=$2 ORDER BY occurred_at,audit_id",[workspace,a.username]);
  assert.deepEqual(r.rows.map(r=>r.action).sort(),['account.add','account.disable','account.enable','account.set_password'].sort());assert.ok(r.rows.every(r=>r.outcome==='SUCCESS'));
  await pool.query(`CREATE FUNCTION console.reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.target='${a.username}' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END$$`);
  await pool.query('CREATE TRIGGER reject_test_audit BEFORE INSERT ON console.audit FOR EACH ROW EXECUTE FUNCTION console.reject_test_audit()');
  try{await assert.rejects(()=>setAccountDisabled(pool,a.username,true));assert.equal((await pool.query('SELECT disabled_at FROM console.accounts WHERE username=$1',[a.username])).rows[0].disabled_at,null);}
  finally{await pool.query('DROP TRIGGER reject_test_audit ON console.audit');await pool.query('DROP FUNCTION console.reject_test_audit()');}
});
