import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {createConsolePool} from '../../apps/control-api/src/console-db.ts';
import {passwordRecord} from '../../apps/control-api/src/console-auth.ts';
import {addAccount} from '../../apps/control-api/src/console-account-ops.ts';
import {ConsoleAuditPageSchema,ConsoleLoginSummarySchema} from '../../packages/contracts/src/console-audit.ts';
const dir='.runtime/d3',origin='http://127.0.0.1:18103';mkdirSync(dir,{recursive:true,mode:0o700});
const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['pipe','pipe','pipe'],timeout:30000});
const secret=JSON.parse(kube(['-n','control','get','secret','control-api-preview','-o','json']));
const connection=new URL(Buffer.from(secret.data['console-database-url'],'base64').toString()),forward=new URL(process.env.DATABASE_URL!);connection.hostname=forward.hostname;connection.port=forward.port;
const pool=createConsolePool({...process.env,CONSOLE_DATABASE_URL:connection.toString()}),browser=await chromium.launch({headless:true});
const name='d3-'+randomUUID(),workspace=name,password=randomBytes(24).toString('base64url');
const account={username:name,subject:name,workspace_id:workspace,role:'operator' as const,...await passwordRecord(password)};
const key=loadSigningKey(),token=await issueToken({subject:'d3-live-auditor',workspace_id:workspace,role:'operator'},key,600),headers={authorization:'Bearer '+token};
const evidence:Record<string,unknown>={},errors:string[]=[];let phase='setup';
try{
  await addAccount(pool,account);
  const wrong=await fetch(origin+'/api/v1/auth/login',{method:'POST',headers:{origin,'x-console-request':'1','content-type':'application/json'},body:JSON.stringify({username:name,password:'incorrect-password'}),signal:AbortSignal.timeout(15000)});assert.equal(wrong.status,401);
  const page=await browser.newPage({viewport:{width:1920,height:937}});page.on('pageerror',e=>errors.push(e.name));
  phase='login';await page.goto(origin+'/users');await page.getByLabel('账号',{exact:true}).fill(name);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'进入控制台'}).click();await expect(page.locator('.user-list tbody tr')).toHaveCount(1);
  await expect(page.locator('.user-events')).toContainText('已拒绝 · 401');await expect(page.locator('.user-events')).toContainText('成功');
  await page.getByRole('tab',{name:'登录历史',exact:true}).click();await expect(page.locator('.user-detail .audit-history tbody tr')).toHaveCount(2);
  phase='command';const commandId=randomUUID();
  const rejected=await page.request.post(origin+'/api/v1/workers/'+randomUUID()+'/pause',{headers:{origin,'x-console-request':'1'},data:{expected_version:1,reason:'D3 隔离空间验证不存在的 Worker',command_id:commandId}});assert.equal(rejected.status(),404);
  await page.getByRole('button',{name:'刷新记录',exact:true}).click();await page.getByLabel('记录类型',{exact:true}).selectOption('COMMAND');await expect(page.locator('.user-events')).toContainText('已拒绝 · 404');
  const auditGet=async(extra='')=>{const r=await fetch(origin+'/api/v1/console/audit?limit=25'+extra,{headers,signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return ConsoleAuditPageSchema.parse(await r.json());};
  const records=await auditGet();assert.ok(records.items.some(e=>e.command_id===commandId&&e.http_status===404));evidence.records=records;
  phase='logout';await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.getByRole('button',{name:'进入控制台'})).toBeVisible();
  const persisted=await auditGet('&kind=LOGIN');assert.equal(persisted.items.length,2);assert.ok(persisted.items.some(e=>e.outcome==='SUCCESS'));assert.ok(persisted.items.some(e=>e.outcome==='REJECTED'));evidence.login_history_survived_logout=true;
  assert.equal((await pool.query('SELECT count(*)::int n FROM console.sessions WHERE username=$1',[name])).rows[0].n,0);
  assert.ok((await auditGet('&kind=LOGOUT')).items.some(e=>e.outcome==='SUCCESS'));
  const other=await issueToken({subject:'other',workspace_id:'another-d3-workspace',role:'operator'},key,600);
  const isolated=await fetch(origin+'/api/v1/console/audit?actor='+name,{headers:{authorization:'Bearer '+other}});assert.equal(ConsoleAuditPageSchema.parse(await isolated.json()).items.length,0);evidence.workspace_isolation=true;
  for(const role of ['reader','worker'] as const){const t=await issueToken({subject:'d3-'+role,workspace_id:workspace,role},key,600);for(const path of ['/v1/console/audit','/v1/console/logins/summary']){const r=await fetch(origin+'/api'+path,{headers:{authorization:'Bearer '+t}});assert.equal(r.status,403);}}evidence.reader_worker_read_status=403;
  const summaryResponse=await fetch(origin+'/api/v1/console/logins/summary',{headers});const summary=ConsoleLoginSummarySchema.parse(await summaryResponse.json());assert.equal(summary.points.at(-1)!.success,1);assert.equal(summary.points.at(-1)!.rejected,1);evidence.login_summary=summary;
  phase='layouts';const production=await issueToken({subject:'d3-layout',workspace_id:'m1-main',role:'operator'},key,600);
  const live=await browser.newPage({viewport:{width:1920,height:937},extraHTTPHeaders:{authorization:'Bearer '+production}});live.on('pageerror',e=>errors.push(e.name));await live.goto(origin+'/users');await expect(live.locator('.user-list tbody tr')).not.toHaveCount(0);await expect(live.locator('.audit-pager').first()).toBeVisible();
  const layouts=[];
  for(const [width,height] of [[1920,937],[1586,992],[390,844]] as const){await live.setViewportSize({width,height});await expect.poll(()=>live.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);if(width<=680)await expect.poll(()=>live.locator('.sidebar').evaluate(n=>n.getBoundingClientRect().right)).toBeLessThanOrEqual(0);await live.screenshot({path:dir+'/users-'+width+'.png',fullPage:true});layouts.push({width,height,horizontal_overflow:0});}evidence.layouts=layouts;
  assert.equal(errors.length,0);writeFileSync(dir+'/browser-evidence.json',JSON.stringify({result:'PASSED',at:new Date().toISOString(),...evidence,page_errors:errors},null,2),{mode:0o600});
  console.log('D3 real login, logout history, denied command audit, workspace/role isolation and responsive layouts passed');
}catch(error){writeFileSync(dir+'/browser-failure.json',JSON.stringify({phase,error:error instanceof Error?error.name:'UnknownError',...evidence}),{mode:0o600});console.error('D3 browser verification failed at '+phase);process.exitCode=1;}
finally{
  // Delete only the generated acceptance account in its isolated workspace. Audit survives.
  try{const primary=kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']).trim();kube(['-n','db','exec','-i',primary,'--','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','crawler'],`DELETE FROM console.accounts WHERE username='${name}' AND workspace_id='${workspace}';`);}catch{console.error('D3 acceptance account cleanup failed');process.exitCode=1;}
  await browser.close();await pool.end();
}
