import {chromium,expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
const token=await issueToken({subject:'d2-layout',workspace_id:'m1-main',role:'operator'},loadSigningKey(),300);
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({extraHTTPHeaders:{authorization:'Bearer '+token}}),layouts=[];
 for(const [width,height] of [[1920,937],[1586,992],[390,844]] as const){
  await page.setViewportSize({width,height});await page.goto('http://127.0.0.1:18103/workers');
  await expect(page.getByRole('button',{name:'execution-worker-0',exact:true})).toBeVisible();await expect(page.getByRole('img',{name:'所选 Worker 近 24 小时任务趋势'})).toBeVisible();
  await expect(page.locator('.worker-detail')).toContainText('已确认 v');await expect(page.getByRole('alert')).toHaveCount(0);
  await page.locator('.worker-detail .detail-body').evaluate(n=>{n.scrollTop=0;});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
  if(width<=680)await expect.poll(()=>page.locator('.sidebar').evaluate(n=>n.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.screenshot({path:'.runtime/d2/workers-'+width+'.png',fullPage:true});layouts.push({width,height,horizontal_overflow:0,navigation_covers_page:false});
 }
 writeFileSync('.runtime/d2/layout-evidence.json',JSON.stringify({result:'PASSED',at:new Date().toISOString(),layouts},null,2),{mode:0o600});console.log('D2 desktop and mobile layouts passed');
}catch(e){console.error('D2 layout verification failed:',e instanceof Error?e.name:'UnknownError');process.exitCode=1;}finally{await browser.close();}
