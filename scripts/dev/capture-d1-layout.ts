import {chromium,expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
const token=await issueToken({subject:'d1-browser',workspace_id:'m1-main',role:'operator'},loadSigningKey(),300);
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({extraHTTPHeaders:{authorization:'Bearer '+token}}),layouts=[];
 for(const [width,height] of [[1920,937],[1586,992],[390,844]] as const){
  await page.setViewportSize({width,height});await page.goto('http://127.0.0.1:18103/config');
  await expect(page.locator('.config-list tbody tr')).toHaveCount(24);await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.getByLabel('配置值')).toHaveValue('true');
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
  if(width<=680)await expect.poll(()=>page.locator('.sidebar').evaluate(n=>n.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.screenshot({path:'.runtime/d1/config-'+width+'.png',fullPage:true});layouts.push({width,height,horizontal_overflow:0,navigation_covers_page:false});
 }
 writeFileSync('.runtime/d1/layout-evidence.json',JSON.stringify({result:'PASSED',at:new Date().toISOString(),layouts},null,2),{mode:0o600});
 console.log('D1 current desktop and mobile layouts passed with the navigation transition settled');
}catch(e){console.error('D1 layout verification failed:',e instanceof Error?e.name:'UnknownError');process.exitCode=1;}finally{await browser.close();}
