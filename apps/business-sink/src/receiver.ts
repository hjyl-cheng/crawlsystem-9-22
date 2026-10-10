import type {Pool} from 'pg';
import {z} from 'zod';
import {PostgresBusinessPublicationStore,PostgresBusinessPublicationActivator,PostgresBusinessPublicationProjector,normalizePublicationShard,type LegacyValue} from '../../../packages/legacy-publication/src/index.js';
import {DeliveryReceiptSchema,type DeliveryReceipt} from '../../../packages/contracts/src/delivery.ts';
export const DeliveryMessageSchema=z.strictObject({schema_version:z.literal('delivery.v1'),delivery_id:z.uuid(),stream_id:z.uuid(),channel_id:z.string().min(1).max(160),shard:z.record(z.string(),z.unknown()),version_vector:z.record(z.string(),z.unknown())});
export function decodeDelivery(raw:string):unknown{const value:unknown=JSON.parse(raw);return typeof value==='string'?JSON.parse(value):value;}
export class DeliveryValidationError extends Error {
 constructor(readonly code:string){super(code);}
}
export function validateDelivery(value:unknown){
 let m:z.infer<typeof DeliveryMessageSchema>,shard:LegacyValue;
 try {m=DeliveryMessageSchema.parse(value);shard=normalizePublicationShard(m.shard);}catch{throw new DeliveryValidationError('INVALID_MESSAGE');}
 if(shard.shard_id!==m.delivery_id||shard.items.some((i:LegacyValue)=>i.channel_id!==m.channel_id||i.publication_stream_id!==m.stream_id))throw new DeliveryValidationError('DELIVERY_IDENTITY_MISMATCH');
 const vector=z.record(z.enum(['channel','video','agent']),z.strictObject({publication_stream_id:z.uuid(),sequence:z.number().int().positive(),revision_id:z.uuid(),result_hash:z.string().regex(/^sha256:[a-f0-9]{64}$/)})).safeParse(m.version_vector);
 if(!vector.success||shard.items.some((i:LegacyValue)=>{const v=vector.data![i.domain as 'channel'|'video'|'agent'];return !v||v.publication_stream_id!==i.publication_stream_id||v.revision_id!==i.revision_id||v.sequence!==i.data_sequence||v.result_hash!==i.result_hash;}))throw new DeliveryValidationError('DELIVERY_VERSION_MISMATCH');
 return {m,shard};
}
export class BusinessReceiver {
 readonly ingress:PostgresBusinessPublicationStore;readonly activator:PostgresBusinessPublicationActivator;readonly projector:PostgresBusinessPublicationProjector;
 constructor(readonly pool:Pool){this.ingress=new PostgresBusinessPublicationStore(pool);this.activator=new PostgresBusinessPublicationActivator(pool);this.projector=new PostgresBusinessPublicationProjector(pool,{batchSize:25});}
 async accept(value:unknown) {
  const {m,shard}=validateDelivery(value);
  const result=await this.ingress.acceptShard(shard),failed=result.receipts.find((r:LegacyValue)=>['rejected','conflict'].includes(r.status));
  const metadata={delivery_id:m.delivery_id,stream_id:m.stream_id,channel_id:m.channel_id,manifest_hash:shard.manifest_hash,version_vector:m.version_vector,status:failed?'FAILED':'PENDING',code:failed?.error_code??null};
  const saved=await this.pool.query('INSERT INTO delivery_transport.messages(delivery_id,channel_id,stream_id,manifest_hash,metadata,revision_ids) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(delivery_id) DO UPDATE SET receipt_sent=false,last_received_at=now() WHERE delivery_transport.messages.manifest_hash=EXCLUDED.manifest_hash AND delivery_transport.messages.stream_id=EXCLUDED.stream_id AND delivery_transport.messages.channel_id=EXCLUDED.channel_id RETURNING delivery_id',[m.delivery_id,m.channel_id,m.stream_id,shard.manifest_hash,metadata,shard.items.map((i:LegacyValue)=>i.revision_id)]);
  if(!saved.rowCount)throw new Error('DELIVERY_IDENTITY_MISMATCH');
  if(!failed)await this.activator.activateReady(m.channel_id);
  return result;
 }
 async tick(send:(receipt:DeliveryReceipt)=>Promise<void>) {
  const rows=(await this.pool.query('SELECT delivery_id,metadata AS meta,revision_ids FROM delivery_transport.messages WHERE receipt_sent=false ORDER BY last_checked_at NULLS FIRST,created_at LIMIT 100')).rows;
  if(rows.length)await this.pool.query('UPDATE delivery_transport.messages SET last_checked_at=now() WHERE delivery_id=ANY($1::uuid[])',[rows.map(r=>r.delivery_id)]);
  for(const channel of new Set(rows.filter(r=>r.meta.status!=='FAILED').map(r=>r.meta.channel_id as string)))await this.activator.activateReady(channel);
  const projected=await this.projector.runOnce();
  for(const row of rows) {
   const m=row.meta as LegacyValue;
   let batchId:string|null=null,status=m.status as 'PENDING'|'DELIVERED'|'FAILED',code=m.code??null;
   if(status!=='FAILED') {
    const targets=(await this.pool.query("SELECT i.batch_id,i.version_vector FROM publication.projection_batch_item i JOIN publication.projection_batch b USING(batch_id) WHERE i.channel_id=$1 AND b.status='published' ORDER BY i.projected_at DESC LIMIT 100",[m.channel_id])).rows;
    const coverage=targets.find(t=>Object.entries(m.version_vector as Record<string,LegacyValue>).every(([domain,v])=>{
     const p=t.version_vector[domain];return p&&p.publication_stream_id===v.publication_stream_id&&Number(p.sequence)>=Number(v.sequence)&&(Number(p.sequence)!==Number(v.sequence)||p.result_hash===v.result_hash);
    }));
    if(coverage){status='DELIVERED';batchId=coverage.batch_id;}
    else {
     const bad=(await this.pool.query("SELECT q.issue_code FROM publication.quarantine q WHERE q.revision_id=ANY($1::uuid[]) ORDER BY q.last_seen_at DESC LIMIT 1",[row.revision_ids])).rows[0];
     if(bad){status='FAILED';code=bad.issue_code;}
    }
   }
   if(status==='PENDING')continue;
   const receipt=DeliveryReceiptSchema.parse({delivery_id:m.delivery_id,stream_id:m.stream_id,channel_id:m.channel_id,manifest_hash:m.manifest_hash,status,code,verified_at:new Date().toISOString(),business_batch_id:batchId,version_vector:m.version_vector});
   await send(receipt);
   await this.pool.query('UPDATE delivery_transport.messages SET receipt_sent=true WHERE delivery_id=$1',[row.delivery_id]);
  }
  return {pending:rows.length,projection:projected.outcome};
 }
}
