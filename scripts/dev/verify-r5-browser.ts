import {chromium,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
const token=await issueToken({subject:'r5-browser-acceptance',workspace_id:'m1-main',role:'operator'},loadSigningKey(),600),state=JSON.parse(readFileSync('.runtime/r5/recovery-state.json','utf8'));
const browser=await chromium.launch({headless:true}),errors:string[]=[];
try {
 const page=await browser.newPage({viewport:{width:1586,height:992},extraHTTPHeaders:{authorization:`Bearer ${token}`}});page.on('pageerror',e=>errors.push(e.name));
 const pages=[['/analytics','采集统计'],['/quality','质量分析'],['/storage','存储与流水线'],[`/failures?failure=${state.failure_id}`,'失败处理'],['/','采集链路总览'],['/agent','Agent 任务'],['/data-api','数据 API'],['/history/UC3L23SlbXIkxvttMI-mDOsw','指标历史']] as const;
 for(const [path,title] of pages) {
  await page.goto('http://127.0.0.1:18103'+path);await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);
  if(path==='/analytics')await expect(page.getByRole('img',{name:'每日采集趋势'})).toBeVisible();
  if(path.startsWith('/failures')){await expect(page.getByRole('heading',{name:'失败详情',exact:true})).toBeVisible();await expect(page.locator('.badge').filter({hasText:'已恢复'}).first()).toBeVisible();await expect(page.getByText('原始证据保留 90 天；页面展示响应状态和大小',{exact:true})).toBeVisible();}
  if(path==='/storage')await expect(page.getByText('小时 / 日汇总',{exact:true})).toBeVisible();
  if(path.startsWith('/history')){await expect(page.getByRole('columnheader',{name:'订阅',exact:true})).toBeVisible();await page.getByLabel('观察对象',{exact:true}).selectOption({index:1});await expect(page.getByRole('cell',{name:'存量快照',exact:true}).first()).toBeVisible();}
  await expect(page.getByRole('alert')).toHaveCount(0);await page.screenshot({path:`.runtime/r5/page-${path.split('?')[0]!.replaceAll('/','')||'overview'}.png`,fullPage:true});
 }
 await page.setViewportSize({width:390,height:844});await page.goto('http://127.0.0.1:18103/quality');await expect(page.getByRole('heading',{name:'质量分析',exact:true})).toBeVisible();await page.screenshot({path:'.runtime/r5/mobile-quality.png',fullPage:true});
 expect(errors).toEqual([]);const result={result:'PASSED',pages:pages.map(p=>p[0]),runtime_errors:0,mobile_verified:true,verified_at:new Date().toISOString()};writeFileSync('.runtime/r5/browser-evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
