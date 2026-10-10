import {chromium,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';

const token=await issueToken({subject:'r6-browser-acceptance',workspace_id:'m1-main',role:'operator'},loadSigningKey(),600);
const browser=await chromium.launch({headless:true});
const errors:string[]=[],failedReads:string[]=[],pages=[
  ['/','采集链路总览'],['/discover/queries','Query 发现'],['/discover/candidates','候选频道'],['/plans','全量采集'],
  ['/update','更新采集'],['/agent','Agent 任务'],['/workers','Worker 管理'],['/analytics','采集统计'],['/storage','存储与流水线'],
] as const;
mkdirSync('.runtime/r6',{recursive:true,mode:0o700});
try {
  const page=await browser.newPage({viewport:{width:1586,height:992},extraHTTPHeaders:{authorization:`Bearer ${token}`}});
  page.on('pageerror',error=>errors.push(error.name));
  page.on('response',response=>{if(response.url().includes('/v1/')&&response.status()>=400)failedReads.push(new URL(response.url()).pathname+':'+response.status());});
  for(const [path,title] of pages) {
    await page.goto('http://127.0.0.1:18103'+path);
    await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
    await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({path:`.runtime/r6/page-${path.replaceAll('/','-')||'overview'}.png`,fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});await page.goto('http://127.0.0.1:18103/update');
  await expect(page.getByRole('heading',{name:'更新采集',exact:true})).toBeVisible();
  await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'.runtime/r6/mobile-update.png',fullPage:true});
  expect(errors).toEqual([]);expect(failedReads).toEqual([]);
  const result={result:'PASSED',verified_at:new Date().toISOString(),pages:pages.map(p=>p[0]),runtime_errors:0,failed_api_reads:0,mobile_verified:true};
  writeFileSync('.runtime/r6/browser-evidence.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
}finally{await browser.close();}
