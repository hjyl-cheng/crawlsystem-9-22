import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {createPool} from '@crawlsystem/store/config';
import {migrate} from '@crawlsystem/store/migrate';
import {Store} from '@crawlsystem/store';
import {fixtureChannel,fixtureVideo} from '@crawlsystem/contracts/fixtures';
import {AgentResultSchema,ChannelFactsSchema,type Principal,type VideoFacts} from '@crawlsystem/contracts';
import {mapPublication,type PublicationSnapshot} from '../../packages/store/src/publication-map.ts';
import {queuePublication,applyDeliveryReceipt,retryDelivery} from '../../packages/store/src/publication.ts';
import {BusinessReceiver,DeliveryValidationError} from '../../apps/business-sink/src/receiver.ts';
import {buildPublicationShard,normalizePublicationEnvelope,observationFactsHash} from '../../packages/legacy-publication/src/index.js';
import type {DeliveryReceipt} from '../../packages/contracts/src/delivery.ts';
const pool=createPool(),uri=process.env.BUSINESS_DATABASE_URL!;
assert.notEqual(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
assert.match(new URL(uri).pathname,/^\/crawlsystem_business_c1_test(?:_\d+)?$/);
const biz=new Pool({connectionString:uri,max:2,ssl:{ca:readFileSync(process.env.PG_CA_FILE!,'utf8'),rejectUnauthorized:true,servername:process.env.PG_TLS_SERVERNAME}}),receiver=new BusinessReceiver(biz);
before(async()=>{await migrate(pool);assert.equal((await biz.query('SELECT database_kind FROM publication.database_identity')).rows[0].database_kind,'business');});
after(async()=>{await pool.end();await biz.end();});
const stamp='2026-10-10T09:00:00.000Z';
function snapshot():PublicationSnapshot & {videos:VideoFacts[]} {
 const id='UC'+randomUUID().replaceAll('-','').slice(0,22),fact=(value:unknown)=>({value,source:'test-model',confidence:'medium',evidence:[],source_urls:[],reason:null});
 const about=ChannelFactsSchema.parse({...fixtureChannel,channel_id:id,channel_url:`https://www.youtube.com/channel/${id}`,observed_at:stamp});
 const agent=AgentResultSchema.parse({channel_id:id,input_hash:'sha256:'+'1'.repeat(64),model_version:'c1-test',taxonomy_version:'v2',observed_at:stamp,facts:{country:fact('BR'),creator_gender:fact('male'),creator_age_range:fact(30),creator_language:fact('pt'),audience_region:fact([{region:'BR',percentage:100}]),audience_language:fact([{language:'pt',percentage:100}]),audience_age_gender:fact(['18-24','25-34','35-44','45-54','55-64','65+'].map((age_range,i)=>({age_range,male:i===0?50:5,female:i===0?25:0}))),active_subscriber_ratio:fact(12),channel_tags:fact({tags:Array.from({length:10},(_,i)=>'tag'+i),top_5_distribution:[{tag:'tag0',percentage:100}]}),channel_categories:fact({level_1:'Gaming',level_2:['Action']})}});
 const videoId=randomUUID().replaceAll('-','').slice(0,11);
 const video:VideoFacts={...structuredClone(fixtureVideo),channel_id:id,source_content_id:videoId,url:`https://www.youtube.com/watch?v=${videoId}`,published_at:stamp,observed_at:stamp};
 return {channel_id:id,about,agent,videos:[video],observed_at:stamp,source:{test:true}};
}
async function stream(){const id=randomUUID();await biz.query("INSERT INTO publication.stream(publication_stream_id,source_deployment_key,source_identity_json,status,automatic_onboarding_projection_mode,registered_by,registered_reason,status_changed_by,status_reason) VALUES($1,$2,'{}','active','online','test','isolated integration','test','isolated integration')",[id,'c1-test-'+id]);return id;}
function message(mapped:ReturnType<typeof mapPublication>,stream_id:string){return {schema_version:'delivery.v1',delivery_id:mapped.shard!.shard_id,stream_id,channel_id:mapped.envelopes[0]!.channel_id,shard:mapped.shard!,version_vector:mapped.state.vector};}
async function receipts(){const out:DeliveryReceipt[]=[];for(let i=0;i<5;i++)await receiver.tick(async r=>{out.push(r);});return out;}
test('legacy 64-table schema accepts finalized payloads and publishes public snapshots',async()=>{
 const s=snapshot(),streamId=await stream(),p=mapPublication(s,undefined,streamId,randomUUID());
 await receiver.accept(message(p,streamId));const got=await receipts();
 assert.equal(got.find(r=>r.delivery_id===p.shard!.shard_id)?.status,'DELIVERED');
 assert.equal((await biz.query('SELECT title FROM public.channel_snapshots WHERE channel_id=$1',[s.channel_id])).rows[0].title,s.about.title);
 assert.equal((await biz.query('SELECT count(*)::int n FROM public.content_snapshots WHERE channel_id=$1',[s.channel_id])).rows[0].n,1);
 assert.equal((await biz.query('SELECT count(*)::int n FROM public.channel_profile_facts WHERE channel_id=$1',[s.channel_id])).rows[0].n,10);
 assert.ok(!JSON.stringify(p.shard).includes('固定样本评论'));
 assert.ok(!JSON.stringify(p.shard).includes('comments_first_page'));
});
test('duplicate delivery reissues a receipt without adding business snapshots',async()=>{
 const s=snapshot(),id=await stream(),p=mapPublication(s,undefined,id,randomUUID()),m=message(p,id);
 await receiver.accept(m);await receipts();const before=(await biz.query('SELECT count(*)::int n FROM public.channel_snapshots WHERE channel_id=$1',[s.channel_id])).rows[0].n;
 await receiver.accept(m);const got=await receipts();assert.equal(got.find(r=>r.delivery_id===m.delivery_id)?.status,'DELIVERED');
 assert.equal((await biz.query('SELECT count(*)::int n FROM public.channel_snapshots WHERE channel_id=$1',[s.channel_id])).rows[0].n,before);
});
test('newer observations without business changes do not create a new revision',async()=>{
 const s=snapshot(),id=await stream(),p=mapPublication(s,undefined,id,randomUUID());
 const later=structuredClone(s);later.observed_at='2026-10-10T09:10:00.000Z';later.about.observed_at=later.observed_at;
 assert.equal(mapPublication(later,p.state,id,randomUUID()).shard,null);
});
test('out-of-order revisions wait durably and resume when the missing predecessor arrives',async()=>{
 const s=snapshot(),id=await stream(),p1=mapPublication(s,undefined,id,randomUUID());
 const s2=structuredClone(s);s2.about.title='revision two';s2.videos[0]!.title='video revision two';
 const p2=mapPublication(s2,p1.state,id,randomUUID());const s3=structuredClone(s2);s3.about.title='revision three';const p3=mapPublication(s3,p2.state,id,randomUUID());
 await receiver.accept(message(p3,id));assert.equal((await receipts()).find(r=>r.delivery_id===p3.shard!.shard_id),undefined);
 await receiver.accept(message(p1,id));await receipts();await receiver.accept(message(p2,id));const got=await receipts();
 assert.equal(got.find(r=>r.delivery_id===p3.shard!.shard_id)?.status,'DELIVERED');
 assert.equal((await biz.query("SELECT payload_json->>'title' AS title FROM result.entity_current WHERE channel_id=$1",[s.channel_id])).rows[0].title,'revision three');
});
test('source removal retracts the channel from the public business projection',async()=>{
 const s=snapshot(),id=await stream(),p1=mapPublication(s,undefined,id,randomUUID());await receiver.accept(message(p1,id));await receipts();
 const p2=mapPublication({...s,removed:true},p1.state,id,randomUUID());await receiver.accept(message(p2,id));const got=await receipts();
 assert.equal(got.find(r=>r.delivery_id===p2.shard!.shard_id)?.status,'DELIVERED');
 assert.equal((await biz.query('SELECT is_retracted FROM result.entity_current WHERE channel_id=$1',[s.channel_id])).rows[0].is_retracted,true);
 assert.equal((await biz.query('SELECT count(*)::int n FROM public.creator_search_live WHERE channel_id=$1',[s.channel_id])).rows[0].n,0);
});
test('a crash after durable acceptance recovers with a fresh receiver',async()=>{
 const s=snapshot(),id=await stream(),p=mapPublication(s,undefined,id,randomUUID());await receiver.accept(message(p,id));
 const got:DeliveryReceipt[]=[];await new BusinessReceiver(biz).tick(async r=>{got.push(r);});assert.equal(got.find(r=>r.delivery_id===p.shard!.shard_id)?.status,'DELIVERED');
});
test('a rejected domain quarantines its new siblings before another message can activate them',async()=>{
 const s=snapshot(),id=await stream(),p1=mapPublication(s,undefined,id,randomUUID());await receiver.accept(message(p1,id));await receipts();
 const changed=structuredClone(s);changed.about.title='must not leak';changed.videos[0]!.title='rejected video';
 const p2=mapPublication(changed,p1.state,id,randomUUID()),items=structuredClone(p2.envelopes),video=items.find(i=>i.domain==='video')!;
 video.payload.upserts[0].item_hash='sha256:'+'0'.repeat(64);video.payload_hash=observationFactsHash(video.payload);
 const shard=buildPublicationShard(items.map(i=>normalizePublicationEnvelope(i)),{shardId:p2.shard!.shard_id,createdAt:stamp});
 await receiver.accept({...message(p2,id),shard});const failed=(await receipts()).find(r=>r.delivery_id===shard.shard_id);assert.equal(failed?.status,'FAILED');
 const next=structuredClone(changed);next.about.title='still waiting for rejected predecessor';const p3=mapPublication(next,p2.state,id,randomUUID());await receiver.accept(message(p3,id));await receipts();
 assert.equal((await biz.query("SELECT payload_json->>'title' title FROM result.entity_current WHERE channel_id=$1",[s.channel_id])).rows[0].title,s.about.title);
 assert.equal((await biz.query("SELECT activation_status FROM publication.revision WHERE revision_id=$1",[items.find(i=>i.domain==='channel')!.revision_id])).rows[0].activation_status,'quarantined');
});
test('invalid nested transport evidence is classified without storing business data',async()=>{
 const s=snapshot(),id=await stream(),p=mapPublication(s,undefined,id,randomUUID()),m=message(p,id);
 await assert.rejects(()=>receiver.accept({...m,shard:{...m.shard,manifest_hash:'sha256:'+'0'.repeat(64)}}),DeliveryValidationError);
 await assert.rejects(()=>receiver.accept({...m,version_vector:{}}),DeliveryValidationError);
 assert.equal((await biz.query('SELECT count(*)::int n FROM publication.inbox WHERE channel_id=$1',[s.channel_id])).rows[0].n,0);
});
test('explicit inaccessible videos retract instead of being mislabeled as window exits',async()=>{
 const s=snapshot(),id=await stream(),p1=mapPublication(s,undefined,id,randomUUID());
 const p2=mapPublication({...s,videos:[{unavailable:true,channel_id:s.channel_id,source_content_id:s.videos[0]!.source_content_id,access_status:'private',reason:'private',source:'test',observed_at:stamp}]},p1.state,id,randomUUID());
 assert.deepEqual(p2.envelopes.find(i=>i.domain==='video')!.payload.retractions,[{content_id:s.videos[0]!.source_content_id,reason:'source_private'}]);
});
async function source() {
 const s=snapshot(),id=await stream(),workspace='c1-'+randomUUID(),op:Principal={subject:'c1-test',workspace_id:workspace,role:'operator'};
 const store=new Store(pool),plan=await store.createPlan(op,{request_id:randomUUID(),source_mode:'youtube',channel_id:s.channel_id} as never);
 await pool.query('INSERT INTO delivery.targets(workspace_id,stream_id,name,enabled) VALUES($1,$2,\'isolated legacy business\',true)',[workspace,id]);
 await pool.query("INSERT INTO crawl_data.channels(workspace_id,channel_id,about,agent,about_revision,agent_revision) VALUES($1,$2,$3,$4,$5,$5)",[workspace,s.channel_id,s.about,s.agent,plan.source_revision]);
 await pool.query("UPDATE control.channels SET management_state='managed' WHERE workspace_id=$1 AND channel_id=$2",[workspace,s.channel_id]);
 await pool.query('INSERT INTO crawl_data.videos(workspace_id,channel_id,video_id,source_revision,data,observed_at) VALUES($1,$2,$3,$4,$5,$6)',[workspace,s.channel_id,s.videos[0]!.source_content_id,plan.source_revision,{...s.videos[0],comments_first_page:null},stamp]);
 await pool.query("UPDATE control.domains SET state='APPLIED' WHERE plan_id=$1",[plan.plan_id]);
 await pool.query('INSERT INTO control.plan_video_targets(plan_id,submission_id,manifest) VALUES($1,$2,$3)',[plan.plan_id,randomUUID(),{video_ids:s.videos.map(v=>v.source_content_id)}]);
 await pool.query("UPDATE control.plans SET status='COMPLETED',finished_at=now() WHERE plan_id=$1",[plan.plan_id]);
 return {s,id,workspace,op,store,plan};
}
test('source completion and outbox insert roll back together; queued data is immutable',async()=>{
 const t=await source(),c=await pool.connect();try{await c.query('BEGIN');await queuePublication(c,t.workspace,t.s.channel_id,t.plan.plan_id);await c.query('ROLLBACK');}finally{c.release();}
 assert.equal((await pool.query('SELECT count(*)::int n FROM delivery.records WHERE workspace_id=$1',[t.workspace])).rows[0].n,0);
 const c2=await pool.connect();try{await c2.query('BEGIN');await queuePublication(c2,t.workspace,t.s.channel_id,t.plan.plan_id);await c2.query('COMMIT');}finally{c2.release();}
 const row=(await pool.query('SELECT shard FROM delivery.records WHERE workspace_id=$1',[t.workspace])).rows[0];
 await pool.query("UPDATE crawl_data.channels SET about=jsonb_set(about,'{title}','\"later incomplete update\"') WHERE workspace_id=$1",[t.workspace]);
 assert.equal((await pool.query('SELECT shard FROM delivery.records WHERE workspace_id=$1',[t.workspace])).rows[0].shard.items[0].payload.title,row.shard.items[0].payload.title);
});
test('failed plans are not published',async()=>{
 const t=await source();await pool.query("UPDATE control.plans SET status='FAILED' WHERE plan_id=$1",[t.plan.plan_id]);const c=await pool.connect();try{await c.query('BEGIN');await queuePublication(c,t.workspace,t.s.channel_id,t.plan.plan_id);await c.query('COMMIT');}finally{c.release();}
 assert.equal((await pool.query('SELECT status FROM delivery.records WHERE workspace_id=$1',[t.workspace])).rows[0].status,'NOT_READY');
 assert.equal((await pool.query('SELECT count(*)::int n FROM delivery.outbox o JOIN delivery.records r ON r.delivery_id=o.delivery_id WHERE workspace_id=$1',[t.workspace])).rows[0].n,0);
});
test('a completed ABOUT plan cannot bootstrap a missing window or publish failed partial facts',async()=>{
 const t=await source();await pool.query('DELETE FROM control.plan_video_targets WHERE plan_id=$1',[t.plan.plan_id]);
 const c=await pool.connect();try{await c.query('BEGIN');await queuePublication(c,t.workspace,t.s.channel_id,t.plan.plan_id);await c.query('COMMIT');}finally{c.release();}
 assert.equal((await pool.query('SELECT error_code FROM delivery.records WHERE workspace_id=$1',[t.workspace])).rows[0].error_code,'initial_window_scope_incomplete');
 const other=await source();await pool.query('UPDATE crawl_data.channels SET agent_revision=0 WHERE workspace_id=$1',[other.workspace]);
 const x=await pool.connect();try{await x.query('BEGIN');await queuePublication(x,other.workspace,other.s.channel_id,other.plan.plan_id);await x.query('COMMIT');}finally{x.release();}
 assert.equal((await pool.query('SELECT error_code FROM delivery.records WHERE workspace_id=$1',[other.workspace])).rows[0].error_code,'source_observation_not_finalized');
});
test('receipt identity and vector are verified; successful confirmation is monotonic',async()=>{
 const t=await source(),c=await pool.connect();try{await c.query('BEGIN');await queuePublication(c,t.workspace,t.s.channel_id,t.plan.plan_id);await c.query('COMMIT');}finally{c.release();}
 const row=(await pool.query('SELECT * FROM delivery.records WHERE workspace_id=$1',[t.workspace])).rows[0];
 const receipt:DeliveryReceipt={delivery_id:row.delivery_id,stream_id:t.id,channel_id:t.s.channel_id,manifest_hash:row.shard.manifest_hash,status:'DELIVERED',code:null,verified_at:stamp,business_batch_id:'test-batch',version_vector:row.version_vector};
 await assert.rejects(async()=>{const x=await pool.connect();try{await x.query('BEGIN');await applyDeliveryReceipt(x,{...receipt,manifest_hash:'sha256:'+'0'.repeat(64)});}finally{await x.query('ROLLBACK');x.release();}},/RECEIPT_IDENTITY/);
 const x=await pool.connect();try{await x.query('BEGIN');await applyDeliveryReceipt(x,receipt);await applyDeliveryReceipt(x,{...receipt,status:'FAILED',code:'delayed_failure'});await x.query('COMMIT');}finally{x.release();}
 assert.equal((await pool.query('SELECT status FROM delivery.records WHERE delivery_id=$1',[row.delivery_id])).rows[0].status,'DELIVERED');
});
test('operator retry is idempotent and keeps the same finalized payload',async()=>{
 const t=await source(),c=await pool.connect();try{await c.query('BEGIN');await queuePublication(c,t.workspace,t.s.channel_id,t.plan.plan_id);await c.query('COMMIT');}finally{c.release();}
 const r=(await pool.query('SELECT * FROM delivery.records WHERE workspace_id=$1',[t.workspace])).rows[0],command={command_id:randomUUID(),reason:'isolated retry verification'};
 const x=await pool.connect();try{await x.query('BEGIN');await retryDelivery(x,t.workspace,r.delivery_id,command,'test');await retryDelivery(x,t.workspace,r.delivery_id,command,'test');await x.query('COMMIT');}finally{x.release();}
 const retry=(await pool.query('SELECT attempts,shard FROM delivery.records WHERE delivery_id=$1',[r.delivery_id])).rows[0];assert.equal(retry.attempts,2);assert.deepEqual(retry.shard,r.shard);
 await assert.rejects(()=>t.store.retryDelivery({...t.op,role:'reader'},r.delivery_id,command),/role/);
});
test('cleanup removes only old acknowledged outbox rows',async()=>{
 const t=await source(),c=await pool.connect();try{await c.query('BEGIN');await queuePublication(c,t.workspace,t.s.channel_id,t.plan.plan_id);await c.query('COMMIT');}finally{c.release();}
 const r=(await pool.query('SELECT delivery_id FROM delivery.records WHERE workspace_id=$1',[t.workspace])).rows[0];
 await pool.query("UPDATE delivery.outbox SET created_at=now()-interval '2 days' WHERE delivery_id=$1",[r.delivery_id]);
 await pool.query('SELECT delivery.cleanup_outbox(200)');assert.equal((await pool.query('SELECT count(*)::int n FROM delivery.outbox WHERE delivery_id=$1',[r.delivery_id])).rows[0].n,1);
 await pool.query("UPDATE delivery.records SET status='DELIVERED' WHERE delivery_id=$1",[r.delivery_id]);await pool.query('SELECT delivery.cleanup_outbox(200)');assert.equal((await pool.query('SELECT count(*)::int n FROM delivery.outbox WHERE delivery_id=$1',[r.delivery_id])).rows[0].n,0);
});
