import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createPool} from '@crawlsystem/store/config';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {dir,workspace,client,save} from './finish-common.ts';
const pool=createPool(),browser=await chromium.launch({headless:true}),local='http://127.0.0.1:18103',publicUrl=readFileSync('/home/ubuntu/workspace/crawlsystem-console/.runtime/console-preview/url','utf8').trim();
let phase='layouts',restore:string|undefined;const errors:string[]=[],failed:string[]=[],layouts:any[]=[];
let activePage:Awaited<ReturnType<typeof browser.newPage>>|undefined;
const networkFailures:{path:string;error:string}[]=[];
try{
 const {headers}=await client(),page=await browser.newPage({extraHTTPHeaders:headers,viewport:{width:1920,height:937}});
 activePage=page;
 page.on('requestfailed',r=>networkFailures.push({path:new URL(r.url()).pathname,error:r.failure()?.errorText??'unknown'}));
 page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.url().includes('/api/v1/')&&r.status()>=400)failed.push(new URL(r.url()).pathname+':'+r.status());});
 for(const width of [1920,390])for(const path of ['/','/channels','/workers','/delivery','/storage','/failures']){
  phase=path+':'+width;await page.setViewportSize({width,height:937});await page.goto(local+path);await expect(page.getByRole('heading',{level:1})).toBeVisible();await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);await page.screenshot({path:dir+'/'+(path.slice(1)||'overview')+'-'+width+'.png',fullPage:true});layouts.push({path,width,horizontal_overflow:0});
 }
 phase='handles';const channel=(await pool.query("SELECT channel_id,about->>'handle' handle FROM control.channel_overview WHERE workspace_id=$1 AND management_state='managed' AND about->>'handle' ~ '^@[A-Za-z0-9._-]{3,30}$' ORDER BY channel_id LIMIT 1",[workspace])).rows[0];assert.ok(channel);
 await page.goto(publicUrl+'/channels');phase='handle-open';await page.getByRole('button',{name:'导入频道',exact:true}).click();phase='handle-fill';await page.getByLabel('频道列表').fill([channel.handle,'https://www.youtube.com/'+channel.handle,channel.channel_id,'@finishmissing'+randomUUID().replaceAll('-','').slice(0,10)].join('\n'));
 const result=page.waitForResponse(r=>r.url().endsWith('/v1/channels/import')&&r.request().method()==='POST');phase='handle-submit';await page.getByRole('button',{name:'加入队列',exact:true}).click();phase='handle-response';const response=await result;assert.equal(response.status(),200);const imported=await response.json();assert.deepEqual(imported.items.map((i:any)=>i.outcome),['known','duplicate','duplicate','handle_not_found']);phase='handle-result';
 await expect(page.getByText('已有这个频道',{exact:true})).toBeVisible();await expect(page.getByText('没有找到这个频道名称',{exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);await page.screenshot({path:dir+'/handle-import-390.png',fullPage:true});
 const reader=await issueToken({subject:'completion-reader',workspace_id:workspace,role:'reader'},loadSigningKey(),300);
 assert.equal((await fetch(local+'/api/v1/channels/import',{method:'POST',headers:{authorization:'Bearer '+reader,'content-type':'application/json'},body:JSON.stringify({request_id:randomUUID(),lines:[channel.handle]})})).status,403);
 phase='public-login';const credentials=JSON.parse(readFileSync('/home/ubuntu/workspace/crawlsystem-console/.runtime/console-preview/login.json','utf8'));
 const publicPage=await browser.newPage({viewport:{width:390,height:844}});publicPage.on('pageerror',e=>errors.push(e.name));
 await publicPage.goto(publicUrl+'/channels');await publicPage.getByLabel('账号',{exact:true}).fill(credentials.username);await publicPage.getByLabel('密码',{exact:true}).fill(credentials.password);await publicPage.getByRole('button',{name:'进入控制台'}).click();await expect(publicPage.getByRole('heading',{level:1})).toBeVisible();
 const cookie=(await publicPage.context().cookies()).find(c=>c.name==='__Host-crawlsystem-session');assert.ok(cookie&&cookie.secure&&cookie.httpOnly&&cookie.sameSite==='Strict');await publicPage.reload();await expect(publicPage.getByRole('heading',{level:1})).toBeVisible();
 phase='rollback';restore=realpathSync('.runtime/console-release/current').split('/').pop()!;
 execFileSync('node',['scripts/dev/release-console.mjs','rollback'],{stdio:'pipe'});execFileSync('systemctl',['--user','restart','console-release-web'],{stdio:'pipe'});
 await expect.poll(async()=>{try{return(await fetch(local+'/healthz')).status;}catch{return 0;}}).toBe(200);
 const previous=(await(await fetch(local+'/healthz')).json()).release;assert.notEqual(previous,restore);
 await publicPage.reload();await expect(publicPage.getByRole('heading',{level:1})).toBeVisible();assert.ok((await publicPage.context().cookies()).some(c=>c.name===cookie.name&&c.value===cookie.value));
 execFileSync('node',['scripts/dev/release-console.mjs','activate',restore],{stdio:'pipe'});execFileSync('systemctl',['--user','restart','console-release-web'],{stdio:'pipe'});
 await expect.poll(async()=>{try{return(await(await fetch(local+'/healthz')).json()).release;}catch{return '';}}).toBe(restore);
 await publicPage.reload();await expect(publicPage.getByRole('heading',{level:1})).toBeVisible();
 await publicPage.getByRole('button',{name:'退出登录',exact:true}).click();await expect(publicPage.getByLabel('账号',{exact:true})).toBeVisible();
 const status=(await fetch(publicUrl+'/api/v1/session',{headers:{cookie:cookie.name+'='+cookie.value}})).status;assert.equal(status,401);
 assert.equal((await fetch(publicUrl+'/channels')).status,200);assert.equal((await fetch(publicUrl+'/api/v1/session')).status,401);
 assert.equal((await fetch(publicUrl+'/api/v1/auth/login',{method:'POST',headers:{origin:'https://unrelated.example','content-type':'application/json','x-console-request':'1'},body:JSON.stringify(credentials)})).status,403);
 assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);save('browser',{result:'PASSED',at:new Date().toISOString(),layouts,handle_outcomes:imported.items.map((i:any)=>i.outcome),reader_write_status:403,public_status:200,cookie_session_across_rollback:true,logout_replay_status:401,current_release:restore,previous_release:previous,page_errors:errors,api_errors:failed});console.log(JSON.stringify({result:'PASSED',layouts:layouts.length,handle_outcomes:imported.items.map((i:any)=>i.outcome),cookie_session_across_rollback:true,public_status:200}));
}catch(error){if(activePage&&phase.startsWith('handle'))await activePage.screenshot({path:dir+'/handle-failure.png',fullPage:true}).catch(()=>{});save('browser-failure',{phase,error:error instanceof Error?error.name:'UnknownError',page_errors:errors,api_errors:failed,network_failures:networkFailures});console.error(JSON.stringify({result:'FAILED',phase,error:error instanceof Error?error.name:'UnknownError',guard:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined,network_failures:networkFailures}));process.exitCode=1;}
finally{
 if(restore&&realpathSync('.runtime/console-release/current').split('/').pop()!==restore){execFileSync('node',['scripts/dev/release-console.mjs','activate',restore],{stdio:'pipe'});execFileSync('systemctl',['--user','restart','console-release-web'],{stdio:'pipe'});}
 await browser.close();await pool.end();
}
