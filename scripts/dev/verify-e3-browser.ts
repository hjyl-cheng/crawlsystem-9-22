import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';

const dir='.runtime/e3',origin='http://127.0.0.1:18103',key=loadSigningKey();
const manifest=JSON.parse(readFileSync(dir+'/manifest.json','utf8'));
const token=await issueToken({subject:'e3-browser',workspace_id:'m1-main',role:'operator'},key,600);
const get=async(path:string,credential=token)=>{const r=await fetch(origin+'/api'+path,{headers:{authorization:'Bearer '+credential},signal:AbortSignal.timeout(15000)});assert.equal(r.status,200,path);return r.json();};
const browser=await chromium.launch({headless:true}),errors:string[]=[],failed:string[]=[],reads=new Map<string,any>();let phase='api';
try{
 const channels=await get('/v1/channels?limit=100&cursor=0');assert.ok(channels.items.length>0);assert.ok(channels.items.every((c:any)=>c.source_mode==='youtube'));
 assert.equal((await get('/v1/channels?source_mode=fixture')).items.length,0);
 const retired=await issueToken({subject:'e3-retired-reader',workspace_id:manifest.selection.workspaces[0],role:'reader'},key,300);
 assert.equal((await get('/v1/channels',retired)).items.length,0);assert.equal((await get('/v1/plans?source_mode=fixture',retired)).items.length,0);
 // The original preview account still has its historical workspace and fixed sample.
 const preview=await issueToken({subject:'e3-preview-reader',workspace_id:'console-e2e-3814487a386c',role:'reader'},key,300);
 assert.ok((await get('/v1/channels?source_mode=fixture',preview)).items.length>0);
 const plans=await get('/v1/plans?source_mode=fixture');assert.ok(plans.items.length>0,'Fixture recovery plans retained');
 phase='browser';const page=await browser.newPage({extraHTTPHeaders:{authorization:'Bearer '+token},viewport:{width:1920,height:937}});
 page.on('pageerror',e=>errors.push(e.name));page.on('response',async r=>{const path=new URL(r.url()).pathname;if(!path.startsWith('/api/v1/'))return;if(r.status()>=400)failed.push(path+':'+r.status());else if(r.request().method()==='GET')try{reads.set(path.slice(4),await r.json());}catch{}});
 const pages=[['/','采集链路总览'],['/channels','频道管理'],['/plans','全量采集'],['/delivery','发布交付'],['/storage','存储与流水线']] as const;
 const layouts=[];
 for(const width of [1920,390]){
  await page.setViewportSize({width,height:937});
  for(const [path,title] of pages){
   phase=path+':'+width;
   reads.clear();await page.goto(origin+path);await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
   await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);await expect(page.getByRole('alert')).toHaveCount(0);
   await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
   if(path==='/channels'){
    await expect.poll(()=>reads.has('/v1/overview/completeness')).toBe(true);
    await expect(page.locator('.discover-kpi strong').first()).toHaveText(reads.get('/v1/overview/completeness').total_channels.toLocaleString('zh-CN'));
   }
   await page.screenshot({path:dir+'/'+(path.slice(1)||'overview')+'-'+width+'.png',fullPage:true});layouts.push({path,width,horizontal_overflow:0});
  }
 }
 const publicResponse=await fetch('https://controversy-roughly-kiss-genealogy.trycloudflare.com/channels',{signal:AbortSignal.timeout(30000)});assert.equal(publicResponse.status,200);
 assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
 const before=JSON.parse(readFileSync(dir+'/runtime-before.json','utf8')),after=JSON.parse(readFileSync(dir+'/runtime-after.json','utf8'));
 assert.deepEqual(after.services.map((s:any)=>[s.name,s.images,s.automatic]),before.services.map((s:any)=>[s.name,s.images,s.automatic]));
 assert.deepEqual(after.pods,before.pods,'Cleanup must preserve every running pod and restart count');
 const evidence={result:'PASSED',at:new Date().toISOString(),layouts,public_status:200,page_errors:errors,api_errors:failed,retired_workspace_empty:true,preview_workspace_preserved:true,fixture_current_removed:true,fixture_recovery_retained:true,images_and_pods_preserved:true};
 writeFileSync(dir+'/browser.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(evidence));
}catch(error){writeFileSync(dir+'/browser-failure.json',JSON.stringify({phase,message:error instanceof Error?error.message:'UnknownError'},null,2)+'\n',{mode:0o600});console.error(JSON.stringify({result:'FAILED',phase,error:error instanceof Error?error.name:'UnknownError',guard:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined}));process.exitCode=1;}
finally{await browser.close();}
