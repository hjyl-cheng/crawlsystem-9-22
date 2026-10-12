import {chromium,expect,type Page} from '@playwright/test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {StorageCapacitySchema,type StorageCapacity} from '../../packages/contracts/src/storage-capacity.ts';
import {unknownStorageCapacity} from '../../apps/control-api/src/storage-capacity.ts';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';

const dir='.runtime/homepage-minio',local='http://127.0.0.1:18103';
mkdirSync(dir,{recursive:true,mode:0o700});
const token=await issueToken({subject:'homepage-minio-reader',workspace_id:'m1-main',role:'reader'},loadSigningKey(),900);
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1920,height:937},extraHTTPHeaders:{authorization:'Bearer '+token}});
const errors:string[]=[],failed:string[]=[],layouts:{width:number;height:number;horizontal_overflow:number;vertical_overflow?:number}[]=[];
let phase='load',capacityReads=0,liveData:StorageCapacity|undefined;
const card=page.getByLabel('MinIO 容量',{exact:true}),panel=page.locator('.capacity-panel');
const size=(n:number)=>n>=1024**3?`${(n/1024**3).toFixed(2)} GiB`:`${(n/1024**2).toFixed(2)} MiB`;
const save=(name:string,value:unknown)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(value,null,2)+'\n',{mode:0o600});
page.on('pageerror',error=>errors.push(error.name));
page.on('response',response=>{
 const path=new URL(response.url()).pathname;
 if(path==='/api/v1/storage/capacity'&&response.status()===200)capacityReads++;
 if(path.startsWith('/api/v1/')&&response.status()>=400&&path!=='/api/v1/storage/capacity')failed.push(path+':'+response.status());
});
async function ready(page:Page){
 await expect(page.getByRole('heading',{name:'采集链路总览',exact:true})).toBeVisible();
 await expect(page.locator('.data-freshness')).toContainText('数据已同步');
 await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('alert')).toHaveCount(0);
}
async function live(origin:string){
 const capacityResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/storage/capacity'&&r.status()===200);
 const storageResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/storage'&&r.status()===200);
 await page.goto(origin+'/');
 const data=StorageCapacitySchema.parse(await (await capacityResponse).json());
 const storage=await (await storageResponse).json();
 expect(data.available).toBe(true);
 await ready(page);
 await expect(card.locator('strong')).toHaveText(size(data.buckets.reduce((n,b)=>n+b.used_bytes!,0)));
 await expect(card.locator('small')).toContainText(size(data.buckets.reduce((n,b)=>n+b.quota_bytes!,0)));
 const description=await card.getAttribute('title');
 for(const bucket of data.buckets)expect(description).toContain(`${bucket.label}：${size(bucket.used_bytes!)} / ${size(bucket.quota_bytes!)}`);
 expect(description).toContain('桶配额不等于独占磁盘容量');
 const pg=panel.locator('.capacity-items>div').filter({has:page.getByText('PostgreSQL',{exact:true})});
 const ch=panel.locator('.capacity-items>div').filter({has:page.getByText('ClickHouse',{exact:true})});
 await expect(pg.locator('strong')).toHaveText((storage.postgres_bytes/1024**2).toFixed(1)+' MiB');
 await expect(ch.locator('strong')).toHaveText(storage.clickhouse.bytes===null?'—':(storage.clickhouse.bytes/1024**2).toFixed(1)+' MiB');
 await expect(panel.locator('.capacity-items>div').filter({has:page.getByText('待归档事件',{exact:true})}).locator('strong')).toHaveText(String(storage.outbox.unarchived));
 await expect(panel.locator('.capacity-items>div').filter({has:page.getByText('待处理失败',{exact:true})}).locator('strong')).toHaveText(String(storage.failures.open));
 return data;
}
async function mock(data:StorageCapacity){
 await page.route('**/api/v1/storage/capacity',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)}),{times:1});
 await page.goto(local+'/');await ready(page);
}
try{
 liveData=await live(local);
 for(const [width,height] of [[1920,937],[1586,992],[390,844]] as const){
  phase='layout:'+width;await page.setViewportSize({width,height});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
  if(width>1000){
   await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollHeight-innerHeight)).toBe(0);
   await expect.poll(()=>page.evaluate(()=>{
    const row=document.querySelector('.recent-panel tbody tr'),panel=document.querySelector('.recent-panel'),view=document.querySelector('.recent-panel .table-scroll');
    return !!row&&!!panel&&!!view&&row.getBoundingClientRect().bottom<=Math.min(panel.getBoundingClientRect().bottom,view.getBoundingClientRect().bottom);
   })).toBe(true);
  }
  await expect(card).toBeVisible();
  save('layout-'+width,await card.evaluate(el=>({card:el.getBoundingClientRect().toJSON(),parts:[...el.children].map(child=>({text:child.textContent,box:child.getBoundingClientRect().toJSON(),width:child.clientWidth,scroll_width:child.scrollWidth}))})));
  await page.screenshot({path:`${dir}/overview-${width}.png`,fullPage:true});
  layouts.push({width,height,horizontal_overflow:0,...width>1000?{vertical_overflow:0}:{}});
 }
 phase='details-link';await panel.getByRole('link',{name:'查看详情'}).click();
 await expect(page.getByRole('heading',{name:'MinIO 容量',exact:true})).toBeVisible();
 await page.setViewportSize({width:1920,height:937});
 phase='unknown';await mock(unknownStorageCapacity());
 await expect(card.locator('strong')).toHaveText('—');await expect(card.locator('small')).toHaveText('用量未知');
 await expect(panel).toContainText('PostgreSQL');await expect(panel).toContainText('待归档事件');
 phase='partial-unknown';const partial=structuredClone(liveData);partial.available=false;
 partial.buckets[2]={...partial.buckets[2]!,used_bytes:null,quota_bytes:null,remaining_bytes:null,objects:null,used_percent:null,state:'unknown'};
 await mock(partial);await expect(card.locator('strong')).toHaveText('—');await expect(card.locator('small')).toHaveText('用量未知');
 phase='warning';const warning=structuredClone(liveData);
 warning.buckets[2]={...warning.buckets[2]!,used_bytes:Math.round(warning.buckets[2]!.quota_bytes!*.7),remaining_bytes:Math.round(warning.buckets[2]!.quota_bytes!*.3),used_percent:70,state:'warning'};
 await mock(warning);await expect(card).toHaveClass(/warning/);await expect(card.locator('small')).toContainText('容量预警');
 phase='critical';const critical=structuredClone(warning);
 critical.buckets[2]={...critical.buckets[2]!,used_bytes:Math.round(critical.buckets[2]!.quota_bytes!*.85),remaining_bytes:Math.round(critical.buckets[2]!.quota_bytes!*.15),used_percent:85,state:'critical'};
 // The smallest bucket is critical while total usage remains below 70%.
 expect(critical.buckets.reduce((n,b)=>n+b.used_bytes!,0)/critical.buckets.reduce((n,b)=>n+b.quota_bytes!,0)*100).toBeLessThan(70);
 await mock(critical);await expect(card).toHaveClass(/critical/);await expect(card.locator('small')).toContainText('容量严重');
 phase='critical-with-unknown';const criticalPartial=structuredClone(partial);criticalPartial.buckets[0]={...critical.buckets[0]!,used_bytes:Math.round(critical.buckets[0]!.quota_bytes!*.85),remaining_bytes:Math.round(critical.buckets[0]!.quota_bytes!*.15),state:'critical',used_percent:85};
 await mock(criticalPartial);await expect(card.locator('strong')).toHaveText('—');await expect(card.locator('small')).toContainText('容量严重');
 phase='empty-buckets';const empty=structuredClone(liveData);empty.buckets=empty.buckets.map(b=>({...b,used_bytes:0,remaining_bytes:b.quota_bytes,objects:0,used_percent:0,state:'ok'}));
 await mock(empty);await expect(card.locator('strong')).toHaveText('0.00 MiB');await expect(card.locator('small')).toContainText('正常');
 phase='error-after-success';await live(local);
 await page.route('**/api/v1/storage/capacity',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'UNAVAILABLE',message:'acceptance',retryable:false,correlation_id:'homepage-minio-acceptance'}})}),{times:1});
 await page.getByRole('button',{name:'刷新实时状态',exact:true}).click();
 await expect(card.locator('strong')).toHaveText('—');await expect(card.locator('small')).toContainText('查询失败');
 await expect(card).not.toHaveClass(/\bok\b/);await expect(page.locator('.data-freshness')).toContainText('部分数据查询失败');
 await expect(panel.locator('.capacity-items>div')).toHaveCount(5);
 phase='retry';await card.getByRole('button',{name:'重新查询 MinIO 容量'}).click();
 await expect(card.locator('strong')).not.toHaveText('—');await ready(page);
 phase='initial-error';await page.route('**/api/v1/storage/capacity',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'UNAVAILABLE',message:'acceptance',retryable:false,correlation_id:'homepage-minio-acceptance'}})}),{times:1});
 await page.goto(local+'/');await expect(card.locator('small')).toContainText('查询失败');
 await expect(panel.locator('.capacity-items>div')).toHaveCount(5);await expect(panel).toContainText('ClickHouse');
 await page.getByRole('button',{name:'刷新实时状态',exact:true}).click();await ready(page);await expect(card.locator('strong')).not.toHaveText('—');
 phase='polling';const readsBefore=capacityReads;
 await expect.poll(()=>capacityReads,{timeout:40000,intervals:[1000]}).toBeGreaterThan(readsBefore);
 phase='public';const publicUrl=readFileSync('/home/ubuntu/workspace/crawlsystem-console/.runtime/console-preview/url','utf8').trim();
 await live(publicUrl);await page.reload();await ready(page);await expect(card).toBeVisible();
 await page.screenshot({path:`${dir}/overview-public.png`,fullPage:true});
 expect(errors).toEqual([]);expect(failed).toEqual([]);
 const evidence={result:'PASSED',at:new Date().toISOString(),layouts,values_match_api:true,original_storage_values_preserved:true,unknown_not_zero:true,partial_unknown_not_summed:true,single_bucket_warning_critical:true,known_critical_not_hidden_by_unknown:true,empty_buckets_zero:true,error_clears_stale_value:true,initial_failure_isolated:true,local_retry:true,global_refresh:true,polling:true,details_link:true,reader:true,public:true,runtime_errors:errors,failed_api_reads:failed,live_capacity:liveData};
 save('evidence',evidence);console.log(JSON.stringify({result:'PASSED',layouts:layouts.length,public:true,unknown_not_zero:true,error_recovery:true}));
}catch(error){
 await page.screenshot({path:`${dir}/failure.png`,fullPage:true}).catch(()=>{});
 save('failure',{result:'FAILED',at:new Date().toISOString(),phase,error:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:undefined,runtime_errors:errors,failed_api_reads:failed});
 console.error(JSON.stringify({result:'FAILED',phase,error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;
}finally{await browser.close();}
