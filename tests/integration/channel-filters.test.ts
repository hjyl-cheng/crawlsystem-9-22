import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Store} from '@crawlsystem/store';
import {createPool} from '@crawlsystem/store/config';
import {ChannelListItemSchema,CreatePlanSchema,pageSchema,type Principal} from '@crawlsystem/contracts';
import {fixtureChannel} from '@crawlsystem/contracts/fixtures';
import {issueToken} from '@crawlsystem/http/auth';
import {createControlApi} from '../../apps/control-api/src/app.ts';
import {prepareDatabase} from './database-ready.ts';
const pool=createPool(),store=new Store(pool),workspace='channel-filters-'+randomUUID(),key=randomBytes(48);
assert.notEqual(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
const as=(role:Principal['role'],workspace_id=workspace):Principal=>({subject:'filter-'+role,workspace_id,role});
const reader=as('reader'),op=as('operator'),ids:string[]=[];
const control=createControlApi({store,signingKey:key});
const model=JSON.parse(readFileSync('apps/profile-agent/tests/expected-profile.json','utf8'));
before(async()=>{
 await prepareDatabase(pool);await control.ready();const at=Date.now();
 for(let i=0;i<26;i++){
  const channel='UC'+randomUUID().replaceAll('-','').slice(0,22);ids.push(channel);
  const plan=await store.createPlan(op,CreatePlanSchema.parse({request_id:randomUUID(),source_mode:'youtube',channel_id:channel,required_domains:i===7?['ABOUT']:['ABOUT','VIDEO','AGENT']}));
  const facts=structuredClone(model.facts);facts.channel_categories.value.level_1=i===1?'Food':'Music';
  const about={...structuredClone(fixtureChannel),channel_id:channel,title:i===25?'仅末页_频道%\\':'频道 '+i,handle:i===25?'@onlylast':'@channel'+i,
   channel_url:'https://www.youtube.com/channel/'+channel,country:i===25?null:i===1?'United States':'Brazil',country_code:i===25?null:i===1?'US':'BR'};
  const profile=[7,25].includes(i)?null:{channel_id:channel,input_hash:plan.input_hash,model_version:model.model_version,taxonomy_version:model.taxonomy_version,observed_at:model.observed_at,facts};
  await pool.query('INSERT INTO crawl_data.channels(workspace_id,channel_id,about,about_revision,agent,agent_revision) VALUES($1,$2,$3,1,$4,1)',[workspace,channel,about,profile]);
  const management=i===1?'paused':i===2?'removed':[3,25].includes(i)?null:'managed';
  await pool.query('UPDATE control.channels SET management_state=$3,updated_at=$4 WHERE workspace_id=$1 AND channel_id=$2',[workspace,channel,management,new Date(at-i*1000)]);
  if(management)await pool.query("INSERT INTO control.channel_clocks(workspace_id,channel_id,clock,due_at,interval_days,reason,policy_version) VALUES($1,$2,'ABOUT',clock_timestamp()+($3*interval '1 day'),1,'test','test')",[workspace,channel,i===0?-1:1]);
  if(![4,5,7,25].includes(i))await pool.query("UPDATE control.domains SET state='APPLIED',completed_at=clock_timestamp() WHERE plan_id=$1",[plan.plan_id]);
  if(i===5)await pool.query("UPDATE control.domains SET state='APPLIED',completed_at=clock_timestamp() WHERE plan_id=$1 AND domain IN ('ABOUT','VIDEO')",[plan.plan_id]);
  if(i===6){await pool.query("UPDATE control.domains SET state='PENDING',completed_at=NULL WHERE plan_id=$1 AND domain='AGENT'",[plan.plan_id]);await pool.query("UPDATE control.plans SET status='FAILED',finished_at=clock_timestamp() WHERE plan_id=$1",[plan.plan_id]);}
 }
 const foreign=await store.createPlan(as('operator',workspace+'-foreign'),CreatePlanSchema.parse({request_id:randomUUID(),source_mode:'youtube',channel_id:'UC'+randomUUID().replaceAll('-','').slice(0,22),required_domains:['ABOUT']}));
 await pool.query('INSERT INTO crawl_data.channels(workspace_id,channel_id,about) VALUES($1,$2,$3)',[workspace+'-foreign',foreign.channel_id,{...fixtureChannel,title:'仅末页_频道%',country:'Foreign only',country_code:null}]);
 await store.createPlan(op,{request_id:randomUUID(),fixture_id:'channel-basic-v1',required_domains:['ABOUT']});
});
after(async()=>{await control.close();await pool.end();});
const list=(filter={},limit=100,offset=0)=>store.listChannels(reader,limit,offset,'youtube',filter,true);
test('server search finds channels beyond the first page and treats %, _ and backslash literally',async()=>{
 const first=await list({},20);assert.equal(first.items.length,20);assert.equal(first.next_cursor,'20');assert.ok(!first.items.some(c=>c.channel_id===ids[25]));
 for(const search of ['仅末页','%','_','\\','@ONLYLAST',ids[25]!])assert.deepEqual((await list({search})).items.map(c=>c.channel_id),[ids[25]],search);
 assert.equal((await list({search:"%' OR true --"})).items.length,0);
 const second=await list({},20,20);assert.equal(second.items.length,6);assert.equal(second.next_cursor,null);
 assert.equal(new Set([...first.items,...second.items].map(c=>c.channel_id)).size,26);
 pageSchema(ChannelListItemSchema).parse(first);
 const legacy=await store.listChannels(reader);assert.ok(!('category' in legacy.items[0]!));assert.ok(!('agent_state' in legacy.items[0]!));
});
test('country, category, management and Agent filters compose over current facts',async()=>{
 const f={country:'US',category:'Food' as const,management_state:'paused' as const,agent_state:'completed' as const};
 assert.deepEqual((await list(f)).items.map(c=>c.channel_id),[ids[1]]);
 assert.equal((await list({...f,country:'BR'})).items.length,0);
 assert.deepEqual((await list({country:'__missing'})).items.map(c=>c.channel_id),[ids[25]]);
 assert.deepEqual((await list({management_state:'removed'})).items.map(c=>c.channel_id),[ids[2]]);
 assert.deepEqual((await list({management_state:'unmanaged'})).items.map(c=>c.channel_id),[ids[3],ids[25]]);
 assert.deepEqual((await list({category:'__missing'})).items.map(c=>c.channel_id),[ids[7],ids[25]]);
 assert.deepEqual((await list({agent_state:'running'})).items.map(c=>c.channel_id),[ids[5]]);
 assert.deepEqual((await list({agent_state:'failed'})).items.map(c=>c.channel_id),[ids[6]]);
 assert.deepEqual((await list({agent_state:'not_scheduled'})).items.map(c=>c.channel_id),[ids[7]]);
 assert.deepEqual((await list({agent_state:'waiting'})).items.map(c=>c.channel_id),[ids[4],ids[25]]);
});
test('tabs and counts share clock semantics, keep paused and removed clocks out of overdue, and respect retry dates',async()=>{
 const summary=await store.channelFilterOptions(reader);assert.deepEqual(summary.counts,{all:26,ok:21,overdue:1,paused:1});
 assert.deepEqual((await list({state:'overdue'})).items.map(c=>c.channel_id),[ids[0]]);
 assert.equal((await list({state:'ok'})).items.length,21);
 assert.deepEqual((await list({state:'paused'})).items.map(c=>c.channel_id),[ids[1]]);
 const onlyUS=await store.channelFilterOptions(reader,'youtube',{country:'US',state:'ok'});assert.deepEqual(onlyUS.counts,{all:1,ok:0,overdue:0,paused:1});
 assert.equal(summary.countries.reduce((n,c)=>n+c.count,0),26);assert.ok(!JSON.stringify(summary).includes('Foreign only'));
 await pool.query("UPDATE control.channel_clocks SET retry_at=clock_timestamp()+interval '1 day' WHERE workspace_id=$1 AND channel_id=$2",[workspace,ids[0]]);
 assert.equal((await list({state:'overdue'})).items.length,0);assert.equal((await store.channelFilterOptions(reader)).counts.ok,22);
 await pool.query('UPDATE control.channel_clocks SET retry_at=NULL WHERE workspace_id=$1 AND channel_id=$2',[workspace,ids[0]]);
});
test('an ABOUT-only update retains the latest Agent task status and stored category',async()=>{
 await store.createPlan(op,CreatePlanSchema.parse({request_id:randomUUID(),source_mode:'youtube',channel_id:ids[6]!,required_domains:['ABOUT']}));
 const row=(await list({search:ids[6]})).items[0]!;assert.equal(row.agent_state,'failed');assert.equal(row.category,'Music');
});
test('HTTP validates filters and cursors, permits reader access, isolates workspaces and rejects node/worker identities',async()=>{
 const headers={authorization:'Bearer '+await issueToken(reader,key)};
 const r=await control.inject({method:'GET',url:'/v1/channels?include_details=1&country=US&category=Food&agent_state=completed&state=paused',headers});
 assert.equal(r.statusCode,200);assert.deepEqual(r.json().items.map((c:any)=>c.channel_id),[ids[1]]);
 assert.equal((await control.inject({method:'GET',url:'/v1/channels/filters?country=US',headers})).json().counts.all,1);
 for(const url of ['/v1/channels?category=Unknown','/v1/channels?agent_state=unknown','/v1/channels?cursor=100001','/v1/channels?state=unknown','/v1/channels?unused=1','/v1/channels/filters?unused=1'])assert.equal((await control.inject({method:'GET',url,headers})).statusCode,400,url);
 for(const role of ['node','worker'] as const)for(const url of ['/v1/channels','/v1/channels/filters'])assert.equal((await control.inject({method:'GET',url,headers:{authorization:'Bearer '+await issueToken(as(role),key)}})).statusCode,403);
 const empty={authorization:'Bearer '+await issueToken(as('reader',workspace+'-empty'),key)};
 assert.equal((await control.inject({method:'GET',url:'/v1/channels/filters',headers:empty})).json().counts.all,0);
});
