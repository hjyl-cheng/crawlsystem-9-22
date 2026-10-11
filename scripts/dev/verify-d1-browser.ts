import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {ConfigSnapshotSchema,ConfigHistorySchema} from '../../packages/contracts/src/configuration.ts';
const dir='.runtime/d1',origin='http://127.0.0.1:18103';mkdirSync(dir,{recursive:true,mode:0o700});
const token=await issueToken({subject:'d1-browser',workspace_id:'m1-main',role:'operator'},loadSigningKey(),600);
const reader=await issueToken({subject:'d1-browser-reader',workspace_id:'m1-main',role:'reader'},loadSigningKey(),600);
const get=async()=>{const r=await fetch(origin+'/api/v1/config',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return ConfigSnapshotSchema.parse(await r.json());};
const publish=async(version:number,value:number,reason:string)=>{
 const r=await fetch(origin+'/api/v1/config',{method:'POST',headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({command_id:crypto.randomUUID(),expected_version:version,key:'alerts.archive_delay_seconds',value,reason,confirm_risk:false}),signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,200);return ConfigSnapshotSchema.parse(await r.json());
};
const initial=await get(),old=initial.settings.alerts.archive_delay_seconds,changed=old<86400?old+1:old-1;
const browser=await chromium.launch({headless:true}),errors:string[]=[],failed:string[]=[];let restored=false,phase='load';
try{
 const page=await browser.newPage({viewport:{width:1920,height:937},extraHTTPHeaders:{authorization:'Bearer '+token}});
 page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.url().includes('/api/v1/')&&r.status()>=400)failed.push(new URL(r.url()).pathname+':'+r.status());});
 await page.goto(origin+'/config');await expect(page.locator('.config-list tbody tr')).toHaveCount(24);await expect(page.getByLabel('配置值')).toHaveValue('true');
 await expect(page.getByLabel('预览示例数据')).toHaveCount(0);await expect(page.getByRole('alert')).toHaveCount(0);
 phase='publish';await page.getByRole('button',{name:'统计归档延迟告警秒数',exact:true}).click();await page.getByLabel('配置值').fill(String(changed));await page.getByLabel('变更说明').fill('D1 页面发布与告警指标读取验收，随即恢复');
 await page.getByRole('button',{name:'发布配置',exact:true}).click();await expect(page.getByText('配置已发布，版本 v',{exact:false})).toBeVisible();
 const published=await get();assert.equal(published.settings.alerts.archive_delay_seconds,changed);assert.equal(published.version,initial.version+1);
 phase='metrics';
 const metric=()=>execFileSync('kubectl',['-n','monitoring','exec','deployment/prometheus','--','promtool','query','instant','http://localhost:9090','max(m1_config_threshold{state="archive_delay_seconds"})'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}).trim();
 await expect.poll(()=>metric(),{timeout:45000,intervals:[3000]}).toMatch(new RegExp('=> '+changed+' @'));
 phase='rollback';await page.getByRole('button',{name:'载入上个值',exact:true}).click();await expect(page.getByLabel('配置值')).toHaveValue(String(old));await page.getByRole('button',{name:'发布配置',exact:true}).click();
 await expect(page.getByText('配置已发布，版本 v'+(initial.version+2),{exact:false})).toBeVisible();const final=await get();assert.deepEqual(final.settings,initial.settings);restored=true;
 phase='consumption';let consumed=final;
 for(let i=0;i<26;i++){consumed=await get();if(consumed.consumers.filter(c=>c.version===final.version&&Date.now()-Date.parse(c.observed_at)<120000).length>=7)break;await delay(3000);}
 assert.equal(consumed.consumers.filter(c=>c.version===final.version&&Date.now()-Date.parse(c.observed_at)<120000).length,7);
 await page.getByRole('button',{name:'刷新配置',exact:true}).click();await expect(page.locator('.config-consumers .green')).toHaveCount(7);
 phase='layout';const layouts=[];
 for(const [width,height] of [[1920,937],[1586,992],[390,844]] as const){await page.setViewportSize({width,height});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);if(width<=680)await expect.poll(()=>page.locator('.sidebar').evaluate(n=>n.getBoundingClientRect().right)).toBeLessThanOrEqual(0);await page.screenshot({path:dir+'/config-'+width+'.png',fullPage:true});layouts.push({width,height,horizontal_overflow:0});}
 phase='reader';const readonly=await browser.newPage({viewport:{width:390,height:844},extraHTTPHeaders:{authorization:'Bearer '+reader}});await readonly.goto(origin+'/config');await expect(readonly.locator('.config-list tbody tr')).toHaveCount(24);await expect(readonly.getByLabel('配置值')).toBeDisabled();await expect(readonly.getByRole('button',{name:'发布配置',exact:true})).toBeDisabled();
 const denied=await readonly.request.post(origin+'/api/v1/config',{data:{command_id:crypto.randomUUID(),expected_version:final.version,key:'alerts.archive_delay_seconds',value:changed,reason:'reader 权限验收',confirm_risk:false}});assert.equal(denied.status(),403);
 const hr=await readonly.request.get(origin+'/api/v1/config/history');assert.equal(hr.status(),200);const history=ConfigHistorySchema.parse(await hr.json());assert.ok(history.items.length>=2);
 assert.equal(errors.length,0);assert.equal(failed.length,0);
 writeFileSync(dir+'/browser-evidence.json',JSON.stringify({result:'PASSED',at:new Date().toISOString(),initial_version:initial.version,final_version:final.version,items:24,published_and_restored:true,metrics_verified:true,consumers:consumed.consumers,reader_write_status:403,layouts,page_errors:errors,failed_api_reads:failed,history:history.items.slice(0,2)},null,2),{mode:0o600});
 console.log('D1 real browser publication, rollback, seven consumers, metrics and reader permissions passed');
}catch(e){writeFileSync(dir+'/browser-failure.json',JSON.stringify({phase,error:e instanceof Error?e.name:'UnknownError',page_errors:errors,failed_api_reads:failed}),{mode:0o600});console.error('D1 live browser verification failed at '+phase);process.exitCode=1;}
finally{
 if(!restored){try{const current=await get();if(current.operator==='d1-browser'&&current.settings.alerts.archive_delay_seconds===changed)await publish(current.version,old,'恢复 D1 验收前的告警阈值');}catch{console.error('D1 threshold restoration needs review');process.exitCode=1;}}
 await browser.close();
}
