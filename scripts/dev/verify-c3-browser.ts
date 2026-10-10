import {chromium,expect,type Page} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {OverviewResourcesSchema,type OverviewResources} from '@crawlsystem/contracts';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';

const dir='.runtime/c3',origin='http://127.0.0.1:18103';
mkdirSync(dir,{recursive:true,mode:0o700});
const token=await issueToken({subject:'c3-browser',workspace_id:'m1-main',role:'operator'},loadSigningKey(),600);
const reader=await issueToken({subject:'c3-browser-reader',workspace_id:'m1-main',role:'reader'},loadSigningKey(),600);
const browser=await chromium.launch({headless:true});
const errors:string[]=[],failed:string[]=[],reads=new Map<string,any>(),windows=new Set<number>();
const stage=(page:Page,id:string)=>page.locator(`.react-flow__node[data-id="${id}"] .stage-value`);
const count=(n:number)=>n.toLocaleString('zh-CN');
let phase='load';
async function loaded(page:Page){
 await expect(page.getByRole('heading',{name:'采集链路总览',exact:true})).toBeVisible();
 await expect(page.locator('.data-freshness')).toContainText('数据已同步');
 await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('alert')).toHaveCount(0);
 await expect(page.locator('.nodes-panel tbody tr').first()).toBeVisible();
 await expect(page.locator('.ip-donut strong')).toBeVisible();
 await expect(stage(page,'discover')).toHaveText(/^[\d,]+$/);
 await expect(stage(page,'business')).toHaveText(/^\d+$/);
 await expect(page.locator('#trends .analytics-trend')).toBeVisible();
}
try{
 const page=await browser.newPage({viewport:{width:1920,height:937},extraHTTPHeaders:{authorization:`Bearer ${token}`}});
 page.on('pageerror',e=>errors.push(e.name));
 page.on('response',async response=>{
  const url=new URL(response.url());if(!url.pathname.startsWith('/api/v1/'))return;
  if(response.status()>=400){failed.push(url.pathname+':'+response.status());return;}
  if(response.request().method()!=='GET')return;
  try{reads.set(url.pathname,await response.json());if(url.pathname==='/api/v1/analytics')windows.add(Number(url.searchParams.get('days')));}catch{/* Non-JSON responses are checked by the page's error state. */}
 });
 await page.goto(origin+'/');await loaded(page);
 await expect.poll(()=>reads.has('/api/v1/overview/resources')).toBe(true);
 phase='resources';
 const resources:OverviewResources=OverviewResourcesSchema.parse(reads.get('/api/v1/overview/resources'));
 expect(resources.monitoring.available).toBe(true);
 expect(Object.values(resources.proxies.by_state).reduce((a,b)=>a+b,0)).toBe(resources.proxies.total);
 const sampled=resources.monitoring.nodes.filter(n=>n.cpu_percent!==null&&n.memory_used_bytes!==null);
 expect(sampled.length).toBeGreaterThan(0);
 await expect(page.locator('.ip-donut strong')).toHaveText(resources.proxies.total.toLocaleString('zh-CN'));
 const workers=reads.get('/api/v1/workers').items;
 for(const worker of workers){
  const row=page.locator('.nodes-panel tbody tr').filter({has:page.locator('a.node-name',{hasText:worker.server_id})});
  const node=resources.monitoring.nodes.find(n=>n.server_id===worker.server_id);
  const assigned=resources.proxies.assignments.filter(n=>n.server_id.replace(/^crawl-/,'')===worker.server_id.replace(/^crawl-/,'')).reduce((n,r)=>n+r.assigned,0);
  await expect(row.locator('td').nth(4)).toHaveText(node?.cpu_percent===null||node?.cpu_percent===undefined?'—':`${node.cpu_percent.toFixed(1)}%`);
  await expect(row.locator('td').nth(5)).toHaveText(node?.memory_used_bytes===null||node?.memory_used_bytes===undefined||node.memory_total_bytes===null?'—':`${(node.memory_used_bytes/1024**3).toFixed(1)} / ${(node.memory_total_bytes/1024**3).toFixed(1)} GiB`);
  await expect(row.locator('td').last()).toHaveText(String(assigned));
 }
 phase='queues';
 const q=reads.get('/api/v1/queries/summary'),c=reads.get('/api/v1/candidates/summary'),imports=reads.get('/api/v1/channels/imports'),u=reads.get('/api/v1/updates/summary'),a=reads.get('/api/v1/agent/summary'),d=reads.get('/api/v1/data-api/summary'),delivery=reads.get('/api/v1/deliveries/summary');
 await expect(stage(page,'discover')).toHaveText(count(q.runs.new_channels_today));
 await expect(stage(page,'candidate')).toHaveText(count(c.by_state.DISCOVERED));
 await expect(stage(page,'full')).toHaveText(count(imports.counts.queued+imports.counts.planned));
 await expect(stage(page,'clock')).toHaveText(count(u.due));await expect(stage(page,'update')).toHaveText(count(u.running));
 await expect(page.locator('.completeness-metrics .freshness strong').last()).toHaveText(count(u.overdue));
 await expect(page.locator('.react-flow__node[data-id="agent"]')).toContainText(`排队 ${a.waiting} · 运行 ${a.running}`);
 await expect(page.locator('.react-flow__node[data-id="data-api"]')).toContainText(`已用 ${d.used_units} / ${d.limit}`);
 await expect(stage(page,'business')).toHaveText(String(delivery.delivered));
 await expect(page.locator('#pipeline')).not.toContainText('未接入');await expect(page.locator('#pipeline')).not.toContainText('固定样本');
 phase='desktop-layout';
 const layouts=[];
 for(const [width,height] of [[1920,937],[1586,992]] as const){
  await page.setViewportSize({width,height});
  await expect.poll(()=>page.evaluate(()=>({x:document.documentElement.scrollWidth-innerWidth,y:document.documentElement.scrollHeight-innerHeight}))).toEqual({x:0,y:0});
  await expect.poll(()=>page.evaluate(()=>[...document.querySelectorAll('#pipeline .react-flow__node')].filter(n=>getComputedStyle(n).visibility==='hidden').length)).toBe(0);
  const columns=await page.evaluate(()=>[...document.querySelectorAll('.dashboard-row')].map(row=>[...row.children].map(cell=>Math.round(cell.getBoundingClientRect().left))));expect(columns[0]).toEqual(columns[1]);
  layouts.push({width,height,horizontal_overflow:0,vertical_overflow:0});
  await page.screenshot({path:`${dir}/overview-${width}.png`,fullPage:true});
 }
 phase='history-ranges';
 await page.getByRole('button',{name:'近30天',exact:true}).click();await expect.poll(()=>windows.has(30)).toBe(true);
 await expect(page.getByRole('heading',{name:'采集趋势 · 近30天',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'近7天',exact:true}).click();await expect.poll(()=>windows.has(7)).toBe(true);
 phase='mobile-layout';
 await page.setViewportSize({width:390,height:844});await page.goto(origin+'/');await loaded(page);
 await page.getByRole('button',{name:'今天（UTC）',exact:true}).click();await expect.poll(()=>windows.has(1)).toBe(true);
 await expect(page.getByRole('heading',{name:'采集趋势 · 今天（UTC）',exact:true})).toBeVisible();
 await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
 await page.screenshot({path:`${dir}/overview-mobile.png`,fullPage:true});
 phase='reader';
 const readonly=await browser.newContext({extraHTTPHeaders:{authorization:`Bearer ${reader}`}});
 const response=await readonly.request.get(origin+'/api/v1/overview/resources');expect(response.status()).toBe(200);OverviewResourcesSchema.parse(await response.json());await readonly.close();
 expect(errors).toEqual([]);expect(failed).toEqual([]);
 const evidence={result:'PASSED',at:new Date().toISOString(),layouts,mobile:{width:390,height:844,horizontal_overflow:0},history_days:[...windows].sort((x,y)=>x-y),live_queue_values:{new_channels_today:q.runs.new_channels_today,candidates:c.by_state.DISCOVERED,imports:imports.counts.queued+imports.counts.planned,due:u.due,overdue:u.overdue,updates_running:u.running,agent_waiting:a.waiting,agent_running:a.running,data_api_used:d.used_units,delivery_pending:delivery.pending,delivery_delivered:delivery.delivered},resources,reader_status:response.status(),runtime_errors:0,failed_api_reads:0};
 writeFileSync(`${dir}/browser-evidence.json`,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(evidence));
}catch(error){
 // Never print Playwright request stacks: they can include the bearer header.
 writeFileSync(`${dir}/browser-failure.json`,JSON.stringify({result:'FAILED',at:new Date().toISOString(),phase,error:error instanceof Error?error.name:'UnknownError',runtime_errors:errors,failed_api_reads:failed},null,2),{mode:0o600});
 console.error('C3 browser acceptance failed; inspect the local page and sanitized failure record.');process.exitCode=1;
}finally{await browser.close();}
