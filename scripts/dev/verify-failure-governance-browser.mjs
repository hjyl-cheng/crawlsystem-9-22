import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {workspace,client} from './finish-common.ts';
import {PlanDetailSchema} from '@crawlsystem/contracts';

const dir='.runtime/failure-governance';let browser;
try {
 const entries=JSON.parse(readFileSync(dir+'/video-recovery-actions.json','utf8')).items.filter(i=>i.plan_id);
 assert.ok(entries.length);const sample=entries[0],{api}=await client();
 const detail=PlanDetailSchema.parse(await api('/v1/plans/'+sample.plan_id));assert.ok(detail.input.recovery_video_ids?.length);
 const token=await issueToken({subject:'failure-governance-reader',workspace_id:workspace,role:'reader'},loadSigningKey(),900);
 const publicUrl=readFileSync('/home/ubuntu/workspace/crawlsystem-console/.runtime/console-preview/url','utf8').trim();
 const bases=['http://127.0.0.1:18103',publicUrl],hosts=new Set(bases.map(b=>new URL(b).host));
 browser=await chromium.launch({headless:true});const page=await browser.newPage(),errors=[],bad=[],layouts=[];
 await page.route('**/api/**',route=>{
  const request=route.request(),url=new URL(request.url());
  return route.continue({headers:{...request.headers(),...(hosts.has(url.host)?{authorization:'Bearer '+token}:{})}});
 });
 page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.url().includes('/api/v1/')&&r.status()>=400)bad.push(new URL(r.url()).pathname+':'+r.status());});
 for(const base of bases)for(const width of [1920,390]) {
  await page.setViewportSize({width,height:937});await page.goto(base+'/plans/'+sample.plan_id);
  await expect(page.getByRole('heading',{name:'本轮目标与业务身份',exact:true})).toBeVisible();
  await expect(page.getByText(sample.plan_id,{exact:true}).first()).toBeVisible();
  await expect(page.getByRole('heading',{name:'采集与入库进度',exact:true})).toBeVisible();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  layouts.push({host:base===publicUrl?'public':'local',width,plan_details:true,no_horizontal_overflow:true});
 }
 await page.goto(publicUrl+'/failures?state=OPEN');await expect(page.getByRole('heading',{name:'失败处理',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'失败记录',exact:true})).toBeVisible();
 assert.deepEqual(errors,[]);assert.deepEqual(bad,[]);
 const result={result:'PASSED',at:new Date().toISOString(),plan_id:sample.plan_id,recovery_videos:detail.input.recovery_video_ids.length,layouts,page_errors:errors,api_errors:bad};
 writeFileSync(dir+'/browser.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
}catch(error) {
 writeFileSync(dir+'/browser-error.json',JSON.stringify({at:new Date().toISOString(),name:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:undefined},null,2)+'\n',{mode:0o600});
 console.error(JSON.stringify({result:'FAILED',error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;
}finally {await browser?.close();}
