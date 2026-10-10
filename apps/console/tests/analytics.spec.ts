import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import type {Page} from '@playwright/test';
import {CONTRACT_VERSION} from '@crawlsystem/contracts';
import {FailureSchema,AnalyticsSchema} from '@crawlsystem/contracts/analytics';
async function setup(page:Page,role='operator') {
 const now=new Date().toISOString(),id=randomUUID(),plan=randomUUID();
 let f=FailureSchema.parse({failure_id:id,workspace_id:'test',stage:'PARSER',code:'INVALID_FACT',plan_id:plan,run_id:null,channel_id:'channel',execution_epoch:1,step:'ABOUT',unit_id:'channel',state:'OPEN',occurrences:2,attempts:6,first_at:now,last_at:now,retry_at:null,resolved_at:null,version:1,reason:null,decided_by:null,retry_plan_id:null,raw:null,raw_object:null,manifest:null,evidence:null,evidence_state:'NONE',retryable:true,retry_blocked_reason:null});
 const totals={collected:3,videos:1,about:1,agent:1,completed:1,failed:0,searches:0,raw_bytes:100,metric_total:7,metric_missing:2},analytics=AnalyticsSchema.parse({source:'clickhouse',observed_at:now,days:7,totals,trend:[{at:now,...totals}],quality:[{domain:'VIDEO',status:'PARTIAL',count:1,total:4,missing:2}],failures:[],baseline:9692,event_count:3,last_event_at:now});
 const commands:unknown[]=[];let lose=false;
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname.replace('/api','');
  if(path==='/v1/session')return route.fulfill({json:{subject:'browser-r5',workspace_id:'test',role,contract_version:CONTRACT_VERSION}});
  if(path==='/v1/failures')return route.fulfill({json:{items:[f],next_cursor:null}});
  if(path.endsWith('/commands')) {
   commands.push(route.request().postDataJSON());f={...f,state:'RETRYING',version:2};
   if(lose){lose=false;return route.abort('failed');}return route.fulfill({json:f});
  }
  if(path.endsWith('/evidence'))return route.fulfill({json:{available:false,sha256:null,bytes:0,responses:[],note:'仅失败元数据'}});
  if(path.startsWith('/v1/failures/'))return route.fulfill({json:f});
  if(path==='/v1/analytics')return route.fulfill({json:analytics});
  return route.fulfill({status:404,json:{error:{code:'NOT_FOUND',message:'missing',retryable:false,correlation_id:'test'}}});
 });return {id,commands,lose:()=>{lose=true;}};
}
test('an ambiguous retry response reuses the command identity and tracks recovery',async({page})=>{
 const state=await setup(page);state.lose();await page.goto(`/failures?failure=${state.id}`);
 await expect(page.getByRole('heading',{name:'失败处理',exact:true})).toBeVisible();
 await page.getByRole('textbox',{name:'处理原因'}).fill('解析修复后重试');await page.getByRole('button',{name:'提交处理',exact:true}).click();
 await expect(page.getByRole('alert')).toBeVisible();await page.getByRole('button',{name:'提交处理',exact:true}).click();
  await expect(page.locator('.badge').filter({hasText:'重试中'}).first()).toBeVisible();expect(state.commands).toHaveLength(2);expect((state.commands[0] as {command_id:string}).command_id).toBe((state.commands[1] as {command_id:string}).command_id);
});
test('readers inspect evidence but cannot act on failures',async({page})=>{
 const state=await setup(page,'reader');await page.goto(`/failures?failure=${state.id}`);await expect(page.getByRole('heading',{name:'失败详情',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'提交处理'})).toHaveCount(0);
});
test('quality and trend pages distinguish baseline from new collections',async({page})=>{
 await setup(page);await page.goto('/quality');await expect(page.getByRole('heading',{name:'质量分析',exact:true})).toBeVisible();await expect(page.getByText('50.0%',{exact:true})).toBeVisible();await expect(page.getByText(/存量视频 9,692 条单独记录/)).toBeVisible();
 await page.goto('/analytics');await expect(page.getByRole('img',{name:'每日采集趋势'})).toBeVisible();
});
