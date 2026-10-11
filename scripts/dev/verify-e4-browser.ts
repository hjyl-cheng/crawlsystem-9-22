import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {createPool} from '@crawlsystem/store/config';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {WorkerMetricsSchema} from '../../packages/contracts/src/workers.ts';
import {dir,workspace,workerId,apiClient,save} from './e4-common.ts';

const origin='http://127.0.0.1:18103',pool=createPool(),browser=await chromium.launch({headless:true});
let phase='initial',changed=false;const errors:string[]=[],failed:string[]=[],evidence:any={};
const {headers,api}=await apiClient();
const worker=async()=>(await api('/v1/workers?limit=100')).items.find((w:any)=>w.worker_id===workerId);
const wait=async(status:string)=>expect.poll(async()=>(await worker())?.control?.status,{timeout:45000,intervals:[2000]}).toBe(status);
try{
 await wait('RUNNING');
 const page=await browser.newPage({viewport:{width:1920,height:937},extraHTTPHeaders:headers});
 page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.url().includes('/api/v1/')&&r.status()>=400)failed.push(new URL(r.url()).pathname+':'+r.status());});
 await page.goto(origin+'/workers?highlight='+workerId);await expect(page.locator('.worker-list tbody tr')).toHaveCount(2);await expect(page.locator('.worker-detail')).toContainText(workerId);
 const metrics:any[]=[];
 for(const id of ['execution-worker-0',workerId]){const m=WorkerMetricsSchema.parse(await api('/v1/workers/'+id+'/metrics'));assert.ok(m.monitoring_available&&m.process&&m.resources.length);assert.ok(m.node.cpu_percent!==null);assert.equal(m.tasks.length,24);metrics.push({worker_id:id,server_id:m.server_id,node:m.node,process:m.process,samples:m.resources.length});}
 evidence.metrics=metrics;
 const action=async(name:string)=>{
  await page.getByRole('button',{name,exact:true}).click();await page.getByLabel('操作原因').fill('E4 第二节点验收：'+name+'，结束后恢复');
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/v1/workers/'+workerId+'/'+(name==='暂停接单'?'pause':name==='排空'?'drain':'resume')));
  await page.getByRole('button',{name:'确认'+name,exact:true}).click();assert.equal((await response).status(),200);
 };
 phase='pause';changed=true;await action('暂停接单');await wait('PAUSED');const paused=await worker();evidence.cutoff=paused.control.changed_at;
 phase='drain';await action('排空');await expect.poll(async()=>(await worker())?.control?.status,{timeout:120000,intervals:[2000]}).toBe('DRAINED');
 const admitted=(await pool.query(`SELECT (SELECT count(*) FROM control.worker_plans WHERE workspace_id=$1 AND worker_id=$2 AND assigned_at>$3::timestamptz)::int plans,(SELECT count(*) FROM control.query_runs WHERE workspace_id=$1 AND coalesce(worker_id,last_worker_id)=$2 AND claimed_at>$3::timestamptz)::int searches`,[workspace,workerId,evidence.cutoff])).rows[0];assert.deepEqual(admitted,{plans:0,searches:0});evidence.closed_gate=admitted;
 const drained=await worker();assert.deepEqual(drained.control.active_plan_ids,[]);assert.deepEqual(drained.control.active_query_run_ids,[]);evidence.drained=true;
 phase='resume';await action('恢复接单');await wait('RUNNING');changed=false;
 phase='layout';const layouts=[];
 for(const width of [1920,390])for(const path of ['/workers','/','/proxies']){
  await page.setViewportSize({width,height:937});await page.goto(origin+path+(path==='/workers'?'?highlight='+workerId:''));
  await expect(page.getByRole('heading',{level:1})).toBeVisible();await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);await expect(page.getByRole('alert')).toHaveCount(0);
  if(path==='/workers'){await expect(page.locator('.worker-list tbody tr')).toHaveCount(2);await expect(page.locator('.worker-detail')).toContainText(workerId);}
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
  await page.screenshot({path:dir+'/'+(path.slice(1)||'overview')+'-'+width+'.png',fullPage:true});layouts.push({path,width,horizontal_overflow:0});
 }
 const reader=await issueToken({subject:'e4-reader',workspace_id:workspace,role:'reader'},loadSigningKey(),300),readonly=await browser.newPage({viewport:{width:390,height:844},extraHTTPHeaders:{authorization:'Bearer '+reader}});
 await readonly.goto(origin+'/workers?highlight='+workerId);await expect(readonly.locator('.worker-list tbody tr')).toHaveCount(2);await expect(readonly.getByRole('button',{name:'暂停接单',exact:true})).toBeDisabled();
 const w=await worker();assert.equal((await readonly.request.post(origin+'/api/v1/workers/'+workerId+'/pause',{data:{command_id:crypto.randomUUID(),expected_version:w.control.version,reason:'E4 reader 权限验收'}})).status(),403);
 const publicResponse=await fetch('https://controversy-roughly-kiss-genealogy.trycloudflare.com/workers',{signal:AbortSignal.timeout(30000)});assert.equal(publicResponse.status,200);
 assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);save('browser',{result:'PASSED',at:new Date().toISOString(),...evidence,layouts,reader_write_status:403,public_status:200,page_errors:errors,api_errors:failed});console.log(JSON.stringify({result:'PASSED',layouts,closed_gate:evidence.closed_gate,public_status:200}));
}catch(error){save('browser-failure',{phase,error:error instanceof Error?error.name:'UnknownError',...evidence,page_errors:errors,api_errors:failed});console.error(JSON.stringify({result:'FAILED',phase,error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;}
finally{
 if(changed){try{const w=await worker();await api('/v1/workers/'+workerId+'/resume',{command_id:crypto.randomUUID(),expected_version:w.control.version,reason:'E4 验收退出后恢复正常接单'});await wait('RUNNING');}catch{console.error('E4 second Worker restoration needs review');process.exitCode=1;}}
 await browser.close();await pool.end();
}
