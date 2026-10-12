import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createPool} from '@crawlsystem/store/config';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {ChannelFilterOptionsSchema,ChannelListItemSchema,pageSchema,type ChannelListFilters} from '@crawlsystem/contracts';
import {dir,workspace,kube,object,save,load,client} from './channel-filters-common.ts';
const mode=process.argv[2],pool=createPool(),local='http://127.0.0.1:18103';
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,phase=mode,page:Awaited<ReturnType<NonNullable<typeof browser>['newPage']>>|undefined;
try{
 const {api}=await client();
 if(mode==='browser'){
  const metadata=ChannelFilterOptionsSchema.parse(await api('/v1/channels/filters'));
  const sample=(await pool.query(`SELECT c.channel_id FROM control.channel_overview c
   WHERE c.workspace_id=$1 AND c.management_state='managed' AND c.agent IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM control.plans p WHERE p.workspace_id=c.workspace_id AND p.channel_id=c.channel_id AND p.status IN ('QUEUED','RUNNING','WAITING'))
   ORDER BY c.updated_at,c.channel_id LIMIT 1`,[workspace])).rows[0];assert.ok(sample);
  const first=pageSchema(ChannelListItemSchema).parse(await api('/v1/channels?include_details=1'));
  assert.ok(!first.items.some(c=>c.channel_id===sample.channel_id),'Search sample must start beyond the first page');
  const read=await issueToken({subject:'channel-filters-reader',workspace_id:workspace,role:'reader'},loadSigningKey(),900);
  browser=await chromium.launch({headless:true});page=await browser.newPage({extraHTTPHeaders:{authorization:'Bearer '+read},viewport:{width:1920,height:937}});
  const errors:string[]=[],bad:string[]=[],layouts:any[]=[];
  page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.url().includes('/api/v1/')&&r.status()>=400&&!r.url().includes('/channels/filters'))bad.push(new URL(r.url()).pathname+':'+r.status());});
  const rows=()=>page!.locator('.channels-list tbody tr');
  const check=async(filter:ChannelListFilters)=>{
   const q=new URLSearchParams(filter as Record<string,string>),response=pageSchema(ChannelListItemSchema).parse(await api('/v1/channels?include_details=1&'+q));
   await expect(rows()).toHaveCount(response.items.length);
   if(response.items.length)await expect(rows().locator('td:first-child .mono')).toHaveText(response.items.map(c=>c.channel_id));
   else await expect(page!.getByText('当前条件下没有频道',{exact:true})).toBeVisible();
  };
  for(const width of [1920,390]){
   phase='layouts:'+width;await page.setViewportSize({width,height:937});await page.goto(local+'/channels');await expect(page.getByRole('heading',{name:'频道管理',exact:true})).toBeVisible();await expect(rows()).toHaveCount(first.items.length);
   for(const label of ['搜索频道','国家 / 地区','业务分类','更新状态','Agent 状态'])await expect(page.getByLabel(label,{exact:true})).toBeEnabled();
   phase='search:'+width;await page.getByLabel('搜索频道',{exact:true}).fill(sample.channel_id);await expect(page).toHaveURL(new RegExp('search='+sample.channel_id));await check({search:sample.channel_id});
   await page.reload();await expect(page.getByLabel('搜索频道',{exact:true})).toHaveValue(sample.channel_id);await check({search:sample.channel_id});
   await page.screenshot({path:dir+'/channels-search-'+width+'.png',fullPage:true});
   await page.getByRole('button',{name:'清除筛选',exact:true}).click();await expect(page.getByLabel('搜索频道',{exact:true})).toHaveValue('');
   phase='tabs:'+width;await page.getByRole('tab',{name:/^已暂停/}).click();await check({state:'paused'});await expect(page.getByRole('tab',{name:/^已暂停/})).toHaveAttribute('aria-selected','true');
   await page.getByRole('tab',{name:/^逾期/}).click();await check({state:'overdue'});
   await page.getByRole('tab',{name:/^正常/}).click();await check({state:'ok'});
   await page.getByRole('tab',{name:/^全部/}).click();
   const country=metadata.countries.find(c=>c.value==='BR')??metadata.countries.find(c=>c.value!=='__missing'&&c.count>20);assert.ok(country);
   const category=metadata.categories.find(c=>c.value==='Music')??metadata.categories.find(c=>c.value!=='__missing');assert.ok(category);
   phase='combined:'+width;await page.getByLabel('国家 / 地区',{exact:true}).selectOption(country.value);await page.getByLabel('业务分类',{exact:true}).selectOption(category.value);await page.getByLabel('更新状态',{exact:true}).selectOption('managed');await page.getByLabel('Agent 状态',{exact:true}).selectOption('completed');
   await check({country:country.value,category:category.value,management_state:'managed',agent_state:'completed'});
   await expect.poll(()=>page!.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
   await page.screenshot({path:dir+'/channels-filtered-'+width+'.png',fullPage:true});layouts.push({width,horizontal_overflow:0});
   await page.getByRole('button',{name:'清除筛选',exact:true}).click();await expect(rows()).toHaveCount(first.items.length);
   phase='paging:'+width;await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page).toHaveURL(/cursor=20/);await page.getByLabel('搜索频道',{exact:true}).fill(sample.channel_id);await check({search:sample.channel_id});assert.equal(new URL(page.url()).searchParams.has('cursor'),false);
   phase='empty:'+width;await page.getByLabel('搜索频道',{exact:true}).fill('missing-channel-filter-'+Date.now());await expect(page.getByText('当前条件下没有频道',{exact:true})).toBeVisible();await expect(page.locator('.channel-detail .detail-head')).toHaveCount(0);
  }
  phase='filter-error-recovery';await page.route('**/api/v1/channels/filters*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'UNAVAILABLE',message:'test',retryable:false,correlation_id:'filter-acceptance'}})}),{times:1});await page.goto(local+'/channels');await expect(page.getByRole('button',{name:'重试筛选信息',exact:true})).toBeVisible();await page.getByRole('button',{name:'重试筛选信息',exact:true}).click();await expect(page.getByRole('button',{name:'重试筛选信息',exact:true})).toHaveCount(0);
  phase='public';const publicUrl=readFileSync('/home/ubuntu/workspace/crawlsystem-console/.runtime/console-preview/url','utf8').trim();await page.goto(publicUrl+'/channels?search='+sample.channel_id);await check({search:sample.channel_id});await page.reload();await check({search:sample.channel_id});
  await expect(page.getByRole('button',{name:'导入频道',exact:true})).toHaveCount(0);
  assert.deepEqual(errors,[]);assert.deepEqual(bad,[]);
  save('browser',{result:'PASSED',at:new Date().toISOString(),layouts,search_beyond_first_page:true,combined_filters:true,tabs:true,pagination_reset:true,url_refresh:true,empty_state:true,selection_cleared:true,filter_error_recovery:true,reader:true,public:true,page_errors:errors,api_errors:bad});console.log(JSON.stringify({result:'PASSED',layouts:layouts.length,public:true,search_beyond_first_page:true,combined_filters:true}));
 }else if(mode==='runtime'){
  const before=load('before'),settings=(await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0];assert.deepEqual(settings,before.settings);
  assert.deepEqual((await pool.query('SELECT version,checksum FROM m1.migrations ORDER BY version')).rows,before.migrations);
  const originals=load('video-identities'),ids=new Set((await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos')).rows.map(r=>JSON.stringify([r.workspace_id,r.channel_id,r.video_id])));assert.ok(originals.every((r:any)=>ids.has(JSON.stringify([r.workspace_id,r.channel_id,r.video_id]))));
  for(const old of before.active_plans){const row=(await pool.query('SELECT plan_id,input_hash,workflow_id,run_id,deadline_at FROM control.plans WHERE plan_id=$1',[old.plan_id])).rows[0];assert.deepEqual(JSON.parse(JSON.stringify(row)),old);}
  const workloads=object(['get','deployment,statefulset,daemonset','-A']).items;
  for(const old of before.workloads.filter((w:any)=>!(w.namespace==='control'&&w.name==='control-api-preview'))){const w=workloads.find((w:any)=>w.metadata.namespace===old.namespace&&w.metadata.name===old.name);assert.ok(w);assert.equal(createHash('sha256').update(JSON.stringify(w.spec)).digest('hex'),old.spec_hash);}
  const pods=object(['get','pods','-A']).items;for(const old of before.pods.filter((p:any)=>!(p.namespace==='control'&&p.name.startsWith('control-api-preview-')))){const p=pods.find((p:any)=>p.metadata.uid===old.uid);assert.ok(p,'Unrelated Pod preserved: '+old.name);assert.deepEqual(p.status.containerStatuses?.map((c:any)=>({name:c.name,n:c.restartCount})),old.restarts);}
  const workers=(await api('/v1/workers?limit=100')).items;assert.equal(workers.length,2);assert.ok(workers.every((w:any)=>!w.stale&&w.control.status==='RUNNING'&&w.collector.gateway==='ready'));
  const delivery=await api('/v1/deliveries/summary');assert.equal(delivery.failed,0);
  const cdc=JSON.parse(kube(['-n','kafka','exec','deployment/debezium-connect','--','curl','--silent','--fail','http://127.0.0.1:8083/connectors/c1-delivery/status']));assert.equal(cdc.connector.state,'RUNNING');assert.ok(cdc.tasks.every((t:any)=>t.state==='RUNNING'));
  const tunnel=Number(execFileSync('systemctl',['--user','show','console-preview-tunnel','--property=MainPID','--value'],{encoding:'utf8'}).trim());assert.equal(tunnel,1882);
  save('runtime-after',{result:'PASSED',at:new Date().toISOString(),schema:before.migrations.length,settings_version:settings.version,preserved_video_identities:originals.length,current_video_identities:ids.size,unrelated_specs_pods_restarts_preserved:true,active_plan_identities_preserved:true,workers:workers.map((w:any)=>({worker_id:w.worker_id,status:w.control.status})),delivery,cdc:'RUNNING',tunnel_pid:tunnel});console.log(JSON.stringify({result:'PASSED',delivery,preserved_video_identities:originals.length}));
 }else if(mode==='operations'){
  const resources=await api('/v1/overview/resources'),storage=await api('/v1/storage');
  const proxies=(await pool.query(`SELECT p.kind,p.provider,p.server_id,count(*)::int total,
   count(*) FILTER(WHERE o.state='healthy' AND o.reported_at>clock_timestamp()-interval '90 seconds')::int healthy
   FROM control.proxies p LEFT JOIN control.proxy_observations o ON o.workspace_id=p.workspace_id AND o.proxy_id=p.proxy_id AND o.server_id=p.server_id AND o.generation=p.generation
   WHERE p.workspace_id=$1 AND p.enabled GROUP BY 1,2,3 ORDER BY 1,2,3`,[workspace])).rows;
  const removed=(await pool.query(`SELECT c.channel_id FROM control.channels c JOIN control.failures f ON f.workspace_id=c.workspace_id
   JOIN control.plans p ON p.plan_id=f.plan_id AND p.channel_id=c.channel_id
   WHERE c.workspace_id=$1 AND c.management_state IN ('managed','paused') AND f.code='NOT_FOUND' GROUP BY c.channel_id LIMIT 10`,[workspace])).rows;
  const disks=JSON.parse(kube(['-n','monitoring','exec','deployment/prometheus','--','wget','-qO-','http://127.0.0.1:9090/api/v1/query?query=(node_filesystem_avail_bytes%7Bmountpoint%3D%22%2F%22%7D%2Fnode_filesystem_size_bytes%7Bmountpoint%3D%22%2F%22%7D)*100']));
  const workloads=object(['get','deployment,statefulset','-A']).items.filter((w:any)=>['temporal-frontend','temporal-history','minio','clickhouse'].some(n=>w.metadata.name.includes(n))).map((w:any)=>({namespace:w.metadata.namespace,name:w.metadata.name,replicas:w.spec.replicas,node:w.spec.template.spec.nodeSelector??null}));
  save('operations',{at:new Date().toISOString(),resources,storage,proxies,deleted_candidate_ids:removed.map(r=>r.channel_id),root_disk_free_percent:disks.data?.result.map((r:any)=>({node:r.metric.node,value:Number(r.value[1])})),single_point_workloads:workloads});
  console.log(JSON.stringify({proxies:proxies.map(p=>({kind:p.kind,provider:p.provider,node:p.server_id,enabled:p.total,healthy:p.healthy})),real_deleted_candidates:removed.length,monitoring_available:resources.monitoring.available,postgres_bytes:storage.postgres_bytes,single_points:workloads.map((w:any)=>({name:w.name,replicas:w.replicas}))}));
 }else throw new Error('Usage: verify-channel-filters browser|runtime|operations');
}catch(error){if(page)await page.screenshot({path:dir+'/browser-failure.png',fullPage:true}).catch(()=>{});save('failure',{phase,error:error instanceof Error?error.name:'UnknownError',guard:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined});console.error(JSON.stringify({result:'FAILED',phase,error:error instanceof Error?error.name:'UnknownError',guard:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined}));process.exitCode=1;}
finally{await browser?.close();await pool.end();}
