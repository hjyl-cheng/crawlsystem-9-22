import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient,QueryResultRow} from 'pg';
import {ChannelFactsSchema,AgentResultSchema,VideoItemSchema} from '@crawlsystem/contracts';
import {DeliveryRecordSchema,DeliverySummarySchema,DeliveryReceiptSchema,type DeliveryRecord,type DeliveryReceipt} from '../../contracts/src/delivery.ts';
import {contentHash} from '@crawlsystem/contracts/hash';
import {mapPublication,type PublicationSnapshot,type PublicationState} from './publication-map.ts';
import {StoreError} from './index.ts';
const iso=(v:Date|string)=>new Date(v).toISOString();
export async function queuePublication(client:PoolClient,workspace:string,channelId:string,planId:string|null,removed=false,bootstrap=false) {
 const target=(await client.query('SELECT * FROM delivery.targets WHERE workspace_id=$1 AND enabled=true',[workspace])).rows[0];
 if(!target)return;
 // Serialize publications with channel operations; retain the exact completion snapshot.
 const channel=(await client.query('SELECT o.*,p.source_mode FROM control.channel_overview o JOIN control.channels c USING(workspace_id,channel_id) JOIN control.plans p ON p.plan_id=o.latest_plan_id WHERE o.workspace_id=$1 AND o.channel_id=$2 FOR UPDATE OF c',[workspace,channelId])).rows[0];
 if(!channel||channel.source_mode!=='youtube')return;
 const existing=planId?(await client.query('SELECT delivery_id FROM delivery.records WHERE workspace_id=$1 AND plan_id=$2',[workspace,planId])).rows[0]:undefined;
 if(existing)return;
 if(bootstrap&&(await client.query("SELECT 1 FROM control.plans WHERE workspace_id=$1 AND channel_id=$2 AND status IN ('QUEUED','RUNNING','WAITING')",[workspace,channelId])).rowCount)return;
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`publication:${workspace}:${channelId}`]);
 const oldRow=(await client.query('SELECT state FROM delivery.channel_state WHERE workspace_id=$1 AND channel_id=$2 FOR UPDATE',[workspace,channelId])).rows[0];
 const old=oldRow?.state as PublicationState|undefined,deliveryId=randomUUID();
 if(removed&&!old)return;
 const time=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
 const plan=planId?(await client.query('SELECT status,frozen_input FROM control.plans WHERE plan_id=$1',[planId])).rows[0]:undefined;
 let error:string|null=null;
 if(!removed&&(!channel.about||!channel.agent||!['managed','paused'].includes(channel.management_state)))error='required_data_not_finalized';
 if(!removed&&plan&&plan.status!=='COMPLETED')error='plan_not_completed';
 if(!removed&&!old&&plan&&(plan.frozen_input.scope.video_limit<30||plan.frozen_input.scope.max_age_days<90))error='initial_window_scope_incomplete';
 if(!removed) {
  const ready=(await client.query("SELECT count(*)::int AS n FROM control.plans WHERE workspace_id=$1 AND channel_id=$2 AND status='COMPLETED' AND source_revision=ANY($3::bigint[])",[workspace,channelId,[channel.about_revision,channel.agent_revision]])).rows[0].n;
  if(ready!==new Set([String(channel.about_revision),String(channel.agent_revision)]).size)error='source_observation_not_finalized';
  const incomplete=(await client.query("SELECT 1 FROM crawl_data.videos v LEFT JOIN control.plans p ON p.source_revision=v.source_revision AND p.workspace_id=v.workspace_id AND p.channel_id=v.channel_id WHERE v.workspace_id=$1 AND v.channel_id=$2 AND (p.status IS DISTINCT FROM 'COMPLETED') LIMIT 1",[workspace,channelId])).rowCount;
  if(incomplete)error='source_observation_not_finalized';
  const window=(await client.query("SELECT 1 FROM control.plans p JOIN control.domains d USING(plan_id) JOIN control.plan_video_targets t USING(plan_id) WHERE p.workspace_id=$1 AND p.channel_id=$2 AND p.status='COMPLETED' AND d.domain='VIDEO' AND d.state='APPLIED' AND (p.frozen_input->'scope'->>'video_limit')::int>=30 AND (p.frozen_input->'scope'->>'max_age_days')::int>=90 LIMIT 1",[workspace,channelId])).rowCount;
  if(!window)error='initial_window_scope_incomplete';
 }
 if(error) {
  await client.query("INSERT INTO delivery.records(delivery_id,workspace_id,channel_id,title,plan_id,revision,status,error_code) VALUES($1,$2,$3,$4,$5,$6,'NOT_READY',$7)",[deliveryId,workspace,channelId,channel.about?.title??null,planId,old?.revision??0,error]);
  if(planId)await client.query("UPDATE control.plans SET publication_status='NOT_READY' WHERE plan_id=$1",[planId]);
  return;
 }
 const data=(await client.query("SELECT data-'comments_first_page'-'comments_ref'-'comments_summary' AS data FROM crawl_data.videos WHERE workspace_id=$1 AND channel_id=$2 ORDER BY video_id",[workspace,channelId])).rows;
 const videos=data.map(r=>VideoItemSchema.parse(r.data.unavailable?r.data:{...r.data,comments_first_page:null}));
 const snapshot:PublicationSnapshot={channel_id:channelId,about:ChannelFactsSchema.parse(channel.about),agent:AgentResultSchema.parse(channel.agent),videos,observed_at:iso(time),removed,source:{plan_id:planId,source_deployment:'crawlsystem-new',bootstrap}};
 const mapped=mapPublication(snapshot,old,target.stream_id,deliveryId),status=mapped.shard?'PENDING':'UNCHANGED';
 await client.query('INSERT INTO delivery.records(delivery_id,workspace_id,channel_id,title,plan_id,revision,status,domains,shard,version_vector) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[deliveryId,workspace,channelId,snapshot.about.title,planId,mapped.shard?mapped.state.revision:old?.revision??0,status,mapped.envelopes.map(e=>e.domain),mapped.shard,mapped.state.vector]);
 if(mapped.shard) {
  await client.query('INSERT INTO delivery.channel_state(workspace_id,channel_id,state) VALUES($1,$2,$3) ON CONFLICT(workspace_id,channel_id) DO UPDATE SET state=EXCLUDED.state,updated_at=clock_timestamp()',[workspace,channelId,mapped.state]);
  await client.query('INSERT INTO delivery.outbox(id,aggregateid,payload,delivery_id) VALUES($1,$2,$3,$1)',[deliveryId,channelId,{schema_version:'delivery.v1',delivery_id:deliveryId,stream_id:target.stream_id,channel_id:channelId,shard:mapped.shard,version_vector:mapped.state.vector}]);
 }
 if(planId)await client.query('UPDATE control.plans SET publication_status=$2 WHERE plan_id=$1',[planId,status]);
}
function record(r:QueryResultRow):DeliveryRecord{return DeliveryRecordSchema.parse({delivery_id:r.delivery_id,channel_id:r.channel_id,title:r.title,plan_id:r.plan_id,revision:r.revision,status:r.status,target:r.target,created_at:iso(r.created_at),received_at:r.received_at?iso(r.received_at):null,error_code:r.error_code,attempts:r.attempts,domains:r.domains,receipt:r.receipt});}
export async function readDeliveries(pool:Pool,workspace:string,limit=50,offset=0,status?:string,search?:string) {
 const rows=(await pool.query('SELECT r.*,t.name AS target FROM delivery.records r JOIN delivery.targets t USING(workspace_id) WHERE workspace_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR channel_id ILIKE $3 OR title ILIKE $3) ORDER BY created_at DESC,delivery_id LIMIT $4 OFFSET $5',[workspace,status??null,search?`%${search}%`:null,limit+1,offset])).rows;
 return {items:rows.slice(0,limit).map(record),next_cursor:rows.length>limit?String(offset+limit):null};
}
export async function getDelivery(pool:Pool|PoolClient,workspace:string,id:string) {
 const r=(await pool.query('SELECT r.*,t.name AS target FROM delivery.records r JOIN delivery.targets t USING(workspace_id) WHERE workspace_id=$1 AND delivery_id=$2',[workspace,id])).rows[0];
 if(!r)throw new StoreError('NOT_FOUND','Delivery not found',404);return record(r);
}
export async function deliverySummary(pool:Pool,workspace:string) {
 const t=(await pool.query('SELECT name,enabled FROM delivery.targets WHERE workspace_id=$1',[workspace])).rows[0];
 const r=(await pool.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status='PENDING')::int AS pending,count(*) FILTER(WHERE status='DELIVERED')::int AS delivered,count(*) FILTER(WHERE status='FAILED')::int AS failed,count(*) FILTER(WHERE status='NOT_READY')::int AS not_ready,count(*) FILTER(WHERE status='UNCHANGED')::int AS unchanged,count(*) FILTER(WHERE status='DELIVERED' AND received_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS delivered_today,min(created_at) FILTER(WHERE status='PENDING') AS oldest_pending_at FROM delivery.records WHERE workspace_id=$1",[workspace])).rows[0];
 return DeliverySummarySchema.parse({...r,enabled:t?.enabled??false,target:t?.name??null,oldest_pending_at:r.oldest_pending_at?iso(r.oldest_pending_at):null});
}
export async function retryDelivery(client:PoolClient,workspace:string,id:string,command:{command_id:string;reason:string},actor:string) {
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`delivery-retry:${command.command_id}`]);
 const h=contentHash({id,...command}),old=(await client.query('SELECT request_hash FROM delivery.retry_commands WHERE command_id=$1',[command.command_id])).rows[0];
 if(old){if(old.request_hash!==h)throw new StoreError('CONFLICT','Retry command identity differs');return getDelivery(client,workspace,id);}
 const r=(await client.query('SELECT r.*,t.stream_id,t.enabled FROM delivery.records r JOIN delivery.targets t USING(workspace_id) WHERE workspace_id=$1 AND delivery_id=$2 FOR UPDATE OF r',[workspace,id])).rows[0];
 if(!r)throw new StoreError('NOT_FOUND','Delivery not found',404);
 if(!r.enabled||!r.shard||['DELIVERED','UNCHANGED','NOT_READY'].includes(r.status))throw new StoreError('CONFLICT','Only pending or failed delivery payloads can be resent');
 await client.query('INSERT INTO delivery.retry_commands(command_id,workspace_id,delivery_id,request_hash,actor,reason) VALUES($1,$2,$3,$4,$5,$6)',[command.command_id,workspace,id,h,actor,command.reason]);
 await client.query("UPDATE delivery.records SET status='PENDING',attempts=attempts+1,error_code=NULL WHERE delivery_id=$1",[id]);
 await client.query('INSERT INTO delivery.outbox(id,aggregateid,payload,delivery_id) VALUES($1,$2,$3,$4)',[command.command_id,r.channel_id,{schema_version:'delivery.v1',delivery_id:id,stream_id:r.stream_id,channel_id:r.channel_id,shard:r.shard,version_vector:r.version_vector},id]);
 if(r.plan_id)await client.query("UPDATE control.plans SET publication_status='PENDING' WHERE plan_id=$1",[r.plan_id]);return getDelivery(client,workspace,id);
}
export async function applyDeliveryReceipt(client:PoolClient,value:DeliveryReceipt) {
 const receipt=DeliveryReceiptSchema.parse(value),r=(await client.query('SELECT r.*,t.stream_id FROM delivery.records r JOIN delivery.targets t USING(workspace_id) WHERE delivery_id=$1 FOR UPDATE OF r',[receipt.delivery_id])).rows[0];
 if(!r||r.stream_id!==receipt.stream_id||r.channel_id!==receipt.channel_id||r.shard?.manifest_hash!==receipt.manifest_hash)throw new Error('RECEIPT_IDENTITY_MISMATCH');
 if(receipt.status==='DELIVERED'&&contentHash(receipt.version_vector)!==contentHash(r.version_vector))throw new Error('RECEIPT_VERSION_MISMATCH');
 if(r.status==='DELIVERED')return;
 await client.query('UPDATE delivery.records SET status=$2,received_at=clock_timestamp(),error_code=$3,receipt=$4 WHERE delivery_id=$1',[receipt.delivery_id,receipt.status,receipt.code,receipt]);
 if(r.plan_id)await client.query('UPDATE control.plans SET publication_status=$2 WHERE plan_id=$1',[r.plan_id,receipt.status]);
}
