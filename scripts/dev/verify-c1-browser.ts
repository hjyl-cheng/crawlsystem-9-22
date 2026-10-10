import {chromium,expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
const token=await issueToken({subject:'c1-browser',workspace_id:'m1-main',role:'operator'},loadSigningKey(),600);
const reader=await issueToken({subject:'c1-browser-reader',workspace_id:'m1-main',role:'reader'},loadSigningKey(),600);
const browser=await chromium.launch({headless:true}),errors:string[]=[],failed:string[]=[];
try{
 const page=await browser.newPage({viewport:{width:1586,height:992},extraHTTPHeaders:{authorization:`Bearer ${token}`}});
 page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.url().includes('/v1/')&&r.status()>=400)failed.push(new URL(r.url()).pathname+':'+r.status());});
 await page.goto('http://127.0.0.1:18103/delivery');await expect(page.getByRole('heading',{name:'发布交付',exact:true})).toBeVisible();await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);await expect(page.getByRole('alert')).toHaveCount(0);
 await page.getByLabel('交付状态').selectOption('DELIVERED');await expect(page.getByLabel('交付状态')).toHaveValue('DELIVERED');await expect(page.locator('tbody tr').first()).toBeVisible();
 await page.getByRole('button',{name:'查看',exact:true}).first().click();await expect(page.getByRole('heading',{name:'交付详情',exact:true})).toBeVisible();await expect(page.getByText('业务表入库完成').first()).toBeVisible();const selected=new URL(page.url()).searchParams.get('delivery')!;await page.screenshot({path:'.runtime/c1/delivery-desktop.png',fullPage:true});
 await page.getByLabel('搜索频道').fill('C1-NO-MATCH');await expect(page.getByText('当前范围内没有交付记录')).toBeVisible();await page.getByLabel('搜索频道').fill('');
 await page.setViewportSize({width:390,height:844});await page.goto('http://127.0.0.1:18103/delivery');await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.runtime/c1/delivery-mobile.png',fullPage:true});
 const readonly=await browser.newPage({extraHTTPHeaders:{authorization:`Bearer ${reader}`}});
 await readonly.route(`**/v1/deliveries/${selected}`,async route=>{const response=await route.fetch();const json=await response.json();await route.fulfill({response,json:{...json,status:'PENDING'}});});
 await readonly.goto(`http://127.0.0.1:18103/delivery?delivery=${selected}`);await expect(readonly.getByRole('heading',{name:'交付详情',exact:true})).toBeVisible();await expect(readonly.getByRole('button',{name:'重发原版本',exact:true})).toHaveCount(0);
 const denied=await readonly.request.post(`http://127.0.0.1:18103/api/v1/deliveries/${selected}/retry`,{data:{command_id:crypto.randomUUID(),reason:'reader must be denied'}});expect(denied.status()).toBe(403);await readonly.close();
 const pages=[['/','采集链路总览'],['/discover/queries','Query 发现'],['/discover/candidates','候选频道'],['/plans','全量采集'],['/update','更新采集'],['/agent','Agent 任务'],['/workers','Worker 管理'],['/analytics','采集统计'],['/storage','存储与流水线']] as const;
 await page.setViewportSize({width:1586,height:992});for(const [path,title] of pages){await page.goto('http://127.0.0.1:18103'+path);await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);await expect(page.getByRole('alert')).toHaveCount(0);if(path==='/'){await expect(page.getByText('发布交付已启用',{exact:true})).toBeVisible();await page.screenshot({path:'.runtime/c1/overview.png',fullPage:true});}}
 expect(errors).toEqual([]);expect(failed).toEqual([]);const evidence={result:'PASSED',at:new Date().toISOString(),desktop:true,mobile:true,state_filter:true,search:true,detail:true,reader_controls_hidden:true,reader_retry_status:denied.status(),pages:['/delivery',...pages.map(p=>p[0])],runtime_errors:0,failed_api_reads:0};writeFileSync('.runtime/c1/browser-evidence.json',JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence));
}finally{await browser.close();}
