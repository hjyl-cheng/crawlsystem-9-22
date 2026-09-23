import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium,expect } from '@playwright/test';
import { preview } from 'vite';
import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { PgConsoleSessions } from '@crawlsystem/store/console-sessions';
import { issueToken } from '@crawlsystem/http/auth';
import { PlanSchema,PlanInputSchema,ReceiptSchema } from '@crawlsystem/contracts';
import { fixtureSubmission } from '@crawlsystem/contracts/hash';
import { createControlApi } from '../../apps/control-api/src/app.ts';
import { ConsoleAuth,passwordRecord } from '../../apps/control-api/src/console-auth.ts';
import { createIngestApi } from '../../apps/ingest/src/app.ts';

// Main-owned verification of the merged production build against real HTTP/PG.
// No Temporal execution is claimed; fixed results are submitted through Ingest.
const workspace=`main-browser-${randomUUID()}`,password=randomBytes(24).toString('base64url'),key=randomBytes(48);
const accounts=[{username:'main-test',subject:'main-test-operator',workspace_id:workspace,role:'operator' as const,...await passwordRecord(password)}];
const origin='http://127.0.0.1:18114';
let controlPool=createPool(),ingestPool=createPool();
const makeControl=()=>createControlApi({store:new Store(controlPool),signingKey:key,allowedOrigin:origin,metricsWorkspace:workspace,consoleAuth:new ConsoleAuth(accounts,false,Date.now,new PgConsoleSessions(controlPool))});
let control=makeControl();
const ingest=createIngestApi({store:new Store(ingestPool),signingKey:key});
const controlUrl=await control.listen({host:'127.0.0.1',port:0}),ingestUrl=await ingest.listen({host:'127.0.0.1',port:0});
const frontend=await preview({configFile:false,root:resolve('apps/console'),logLevel:'error',preview:{host:'127.0.0.1',port:18114,strictPort:true,proxy:{'/api':{target:controlUrl,rewrite:path=>path.replace(/^\/api/,'')}}}});
const browser=await chromium.launch({headless:true});
const workerToken=await issueToken({subject:'main-browser-worker',workspace_id:workspace,role:'worker'},key);
async function api(path:string,body?:unknown,base=controlUrl):Promise<unknown> {
  for(let attempt=0;attempt<3;attempt++) {
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${workerToken}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
    if(response.status===503&&attempt<2){await setTimeout(500);continue;}
    if(!response.ok)throw new Error(`Integrated API ${path}: ${response.status}`);
    return response.json();
  }
  throw new Error('Integrated API retry budget exhausted');
}
try {
  const context=await browser.newContext({viewport:{width:1586,height:992}}),page=await context.newPage();
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/plans');
  await page.getByLabel('账号',{exact:true}).fill(accounts[0]!.username);
  await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'进入控制台'}).click();
  await expect(page.getByRole('navigation',{name:'主导航'})).toBeVisible({timeout:15_000});
  async function create(requireAgent=false) {
    await page.goto(origin+'/plans');
    await page.getByRole('link',{name:'创建样本计划',exact:true}).click();
    if(requireAgent)await page.getByRole('checkbox',{name:/Agent 分析/}).check();
    const result=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/v1/plans')&&r.request().method()==='POST');
    await page.getByRole('button',{name:'创建并查看计划'}).click();
    const plan=PlanSchema.parse(await (await result).json());
    await expect(page.getByRole('heading',{name:'Plan 详情',exact:true})).toBeVisible();return plan;
  }
  async function apply(id:string) {
    const input=PlanInputSchema.parse(await api(`/v1/plans/${id}/input`));
    for(const domain of ['ABOUT','VIDEO'] as const)ReceiptSchema.parse(await api('/v1/submissions',fixtureSubmission(input,domain),ingestUrl));
    await page.getByRole('button',{name:'刷新数据',exact:true}).first().click();
  }
  const completed=await create();await apply(completed.plan_id);
  await expect(page.getByText('本轮已完成',{exact:true})).toBeVisible();
  const oldCookie=(await context.cookies()).find(cookie=>cookie.name==='crawlsystem-session');assert.ok(oldCookie?.httpOnly);
  await control.close();await controlPool.end();controlPool=createPool();control=makeControl();
  await control.listen({host:'127.0.0.1',port:Number(new URL(controlUrl).port)});
  await page.reload();await expect(page.getByText('本轮已完成',{exact:true})).toBeVisible({timeout:15_000});
  assert.equal((await context.cookies()).find(cookie=>cookie.name==='crawlsystem-session')?.value,oldCookie.value);
  const waiting=await create(true);await apply(waiting.plan_id);
  await expect(page.getByText('等待依赖',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'取消本轮',exact:true}).click();
  await page.getByRole('button',{name:'确认取消',exact:true}).click();
  await expect(page.getByText('已取消',{exact:true})).toBeVisible();
  const persisted=await api(`/v1/plans/${waiting.plan_id}/input`);assert.equal(PlanInputSchema.parse(persisted).plan.status,'CANCELLED');
  mkdirSync('docs/m1/reports',{recursive:true});
  await page.screenshot({path:'docs/m1/reports/main-browser-cancelled.png',fullPage:true});
  await page.getByRole('button',{name:'退出登录'}).click();
  await expect(page.getByLabel('账号',{exact:true})).toBeVisible();
  assert.equal((await fetch(controlUrl+'/v1/session',{headers:{cookie:`${oldCookie.name}=${oldCookie.value}`}})).status,401);
  assert.deepEqual(errors,[]);
  const evidence={verified_at:new Date().toISOString(),scope:'Merged console + Control/Ingest + PG; controlled fixture, not Temporal business execution',browser:browser.version(),workspace_id:workspace,completed_plan_id:completed.plan_id,cancelled_plan_id:waiting.plan_id,password_login:'passed',api_restart_same_cookie:'passed',waiting_and_cancel:'passed',logout_replay_status:401,browser_errors:errors.length};
  writeFileSync('docs/m1/reports/main-browser.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
} finally {
  await browser.close();await new Promise<void>((resolve,reject)=>frontend.httpServer.close(error=>error?reject(error):resolve()));
  await control.close();await ingest.close();await controlPool.end();await ingestPool.end();
}
