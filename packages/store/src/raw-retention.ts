import {randomUUID} from 'node:crypto';
import type {PoolClient,Pool} from 'pg';
import {StepManifestSchema,PipelineFactSchema} from '../../contracts/src/pipeline.ts';
import {RawCleanupItemSchema,RawCleanupResultSchema,RawRetentionStatusSchema,type RawCleanupResult} from '../../contracts/src/raw-retention.ts';
import {StoreError} from './index.ts';

// A full day AFTER both completion and durable ingestion. Every current step must
// have all its receipts; unresolved failures, replay and unarchived messages veto.
const planEligible=`p.workspace_id=$1 AND p.status='COMPLETED'
 AND p.finished_at<clock_timestamp()-interval '24 hours'
 AND EXISTS(SELECT 1 FROM control.pipeline_steps s WHERE s.plan_id=p.plan_id AND s.execution_epoch=p.execution_epoch)
 AND NOT EXISTS(SELECT 1 FROM control.pipeline_steps s WHERE s.plan_id=p.plan_id AND s.execution_epoch=p.execution_epoch
   AND (s.state<>'APPLIED' OR s.created_at>=clock_timestamp()-interval '24 hours'
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.manifest->'units') u WHERE NOT EXISTS(
       SELECT 1 FROM crawl_data.ingest_units i WHERE i.plan_id=s.plan_id AND i.execution_epoch=s.execution_epoch AND i.step=s.step
         AND i.workspace_id=p.workspace_id AND i.unit_id=u->>'unit_id' AND i.raw_key=u->>'key' AND i.raw_hash=u->>'sha256'
         AND i.applied_at<clock_timestamp()-interval '24 hours'))))
 AND NOT EXISTS(SELECT 1 FROM control.failures f WHERE (f.plan_id=p.plan_id OR f.retry_plan_id=p.plan_id)
   AND (f.state IN ('OPEN','RETRYING') OR f.evidence_state='PENDING'))
 AND NOT EXISTS(SELECT 1 FROM control.failure_replays r JOIN control.failures f USING(failure_id)
   WHERE (f.plan_id=p.plan_id OR f.retry_plan_id=p.plan_id) AND r.state IN ('PENDING','LEASED'))
 AND NOT EXISTS(SELECT 1 FROM telemetry.outbox o WHERE o.workspace_id=$1 AND o.event->>'plan_id'=p.plan_id::text AND o.archived_at IS NULL)`;
const searchEligible=`q.workspace_id=$1 AND q.state='SUCCEEDED' AND q.finished_at<clock_timestamp()-interval '24 hours'
 AND q.qualification_pending=0 AND q.clock_settled_at IS NOT NULL
 AND (SELECT count(*) FROM control.query_run_pages s WHERE s.run_id=q.run_id AND s.attempt=q.attempt)=q.pages
 AND NOT EXISTS(SELECT 1 FROM control.failures f WHERE f.run_id=q.run_id AND (f.state IN ('OPEN','RETRYING') OR f.evidence_state='PENDING'))
 AND NOT EXISTS(SELECT 1 FROM control.failure_replays r JOIN control.failures f USING(failure_id) WHERE f.run_id=q.run_id AND r.state IN ('PENDING','LEASED'))
 AND NOT EXISTS(SELECT 1 FROM telemetry.outbox o WHERE o.workspace_id=$1 AND o.event->>'plan_id'=q.run_id::text AND o.archived_at IS NULL)`;
export async function populateRawCleanup(c:PoolClient,workspace:string) {
 const steps=(await c.query(`SELECT s.*,p.input_hash,p.channel_id FROM control.pipeline_steps s JOIN control.plans p USING(plan_id)
   WHERE ${planEligible} AND s.execution_epoch=p.execution_epoch AND NOT EXISTS(
     SELECT 1 FROM telemetry.raw_retention r WHERE r.workspace_id=$1 AND r.object_key=$2||s.plan_id||'/'||s.execution_epoch||'/'||s.step||'/_manifest.json.gz')
   ORDER BY p.finished_at,s.step LIMIT 5`,[workspace,`v1/${encodeURIComponent(workspace)}/`])).rows;
 for(const s of steps) {
  const base=`v1/${encodeURIComponent(workspace)}/${s.plan_id}/${s.execution_epoch}/${s.step}/`;
  const block=()=>c.query(`INSERT INTO telemetry.raw_retention(workspace_id,object_key,plan_id,execution_epoch,kind,required_refs,state,last_error)
    VALUES($1,$2,$3,$4,'MANIFEST','[]','BLOCKED','INVALID_MANIFEST') ON CONFLICT DO NOTHING`,[workspace,base+'_manifest.json.gz',s.plan_id,s.execution_epoch]);
  const parsed=StepManifestSchema.safeParse(s.manifest);if(!parsed.success){await block();continue;}
  const m=parsed.data;
  if(m.owner.workspace_id!==workspace||m.owner.plan_id!==s.plan_id||m.owner.execution_epoch!==s.execution_epoch||m.owner.input_hash!==s.input_hash||m.channel_id!==s.channel_id||m.step!==s.step||m.key!==base+'_manifest.json.gz'){await block();continue;}
  const ledger=(await c.query('SELECT unit_id,fact FROM crawl_data.ingest_units WHERE workspace_id=$1 AND plan_id=$2 AND execution_epoch=$3 AND step=$4',[workspace,s.plan_id,s.execution_epoch,s.step])).rows;
  const objects:{key:string;bytes:number|null;refs:unknown[];kind:'UNIT'|'MANIFEST'}[]=[];let valid=true;
  for(const u of m.units) {
   const f=PipelineFactSchema.safeParse(ledger.find(i=>i.unit_id===u.unit_id)?.fact);
   if(!f.success||u.bucket!=='crawl-raw'||u.key!==base+u.unit_id+'.json.gz'||f.data.raw.key!==u.key||f.data.raw.sha256!==u.sha256||f.data.raw.bytes!==u.bytes
     ||f.data.raw.workspace_id!==workspace||f.data.raw.plan_id!==s.plan_id||f.data.raw.execution_epoch!==s.execution_epoch||f.data.raw.step!==s.step
     ||f.data.raw.unit_id!==u.unit_id||f.data.raw.input_hash!==s.input_hash||f.data.raw.channel_id!==s.channel_id
     ||f.data.parsed.bucket!=='crawl-parsed'||f.data.parsed.key!==base+u.unit_id+`.youtube-raw-1.${u.sha256}.json.gz`) {valid=false;break;}
   const refs=[f.data.parsed];
   if(f.data.kind==='VIDEO'&&'comments_ref' in f.data.payload&&f.data.payload.comments_ref) {
    const ref=f.data.payload.comments_ref;
    if(ref.bucket!=='crawl-parsed'||ref.key!==`v1/${encodeURIComponent(workspace)}/${s.plan_id}/${s.execution_epoch}/comments/${u.unit_id}.${u.sha256}.json.gz`) {valid=false;break;}
    refs.push(ref);
   }
   objects.push({key:u.key,bytes:u.bytes,refs,kind:'UNIT'});
  }
  if(!valid){await block();continue;}
  objects.push({key:m.key,bytes:null,refs:objects.flatMap(o=>o.refs),kind:'MANIFEST'});
  await c.query(`INSERT INTO telemetry.raw_retention(workspace_id,object_key,plan_id,execution_epoch,kind,required_refs,expected_bytes)
    SELECT $1,o.key,$2,$3,o.kind,o.refs,o.bytes FROM jsonb_to_recordset($4::jsonb) AS o(key text,kind text,refs jsonb,bytes bigint)
    ON CONFLICT DO NOTHING`,[workspace,s.plan_id,s.execution_epoch,JSON.stringify(objects)]);
 }
 const pages=(await c.query(`SELECT s.*,q.workspace_id FROM control.query_run_pages s JOIN control.query_runs q USING(run_id)
   WHERE ${searchEligible} AND s.attempt=q.attempt AND NOT EXISTS(SELECT 1 FROM telemetry.raw_retention r WHERE r.workspace_id=$1 AND r.object_key=s.raw_reference->>'key')
   ORDER BY q.finished_at,s.page LIMIT 100`,[workspace])).rows;
 for(const s of pages) {
  const key=`search/v1/${encodeURIComponent(workspace)}/${s.run_id}/${s.attempt}/page-${s.page}.json.gz`;
  if(s.raw_reference?.bucket!=='crawl-raw'||s.raw_reference.key!==key||!Number.isSafeInteger(s.raw_reference.bytes)||s.raw_reference.bytes<0)continue;
  await c.query(`INSERT INTO telemetry.raw_retention(workspace_id,object_key,run_id,kind,required_refs,expected_bytes)
    VALUES($1,$2,$3,'SEARCH','[]',$4) ON CONFLICT DO NOTHING`,[workspace,key,s.run_id,s.raw_reference.bytes]);
 }
}
export async function claimRawCleanup(c:PoolClient,workspace:string,limit=100,dryRun=false) {
 await c.query("SELECT pg_advisory_xact_lock(hashtext('raw-retention:'||$1))",[workspace]);
 if(!dryRun)await populateRawCleanup(c,workspace);
 const rows=(await c.query(`SELECT r.* FROM telemetry.raw_retention r
   LEFT JOIN control.plans p ON p.plan_id=r.plan_id LEFT JOIN control.query_runs q ON q.run_id=r.run_id
   WHERE r.workspace_id=$1 AND (r.state='PENDING' OR r.state='LEASED' AND r.lease_until<clock_timestamp())
     AND (r.retry_at IS NULL OR r.retry_at<clock_timestamp())
     AND ((r.plan_id IS NOT NULL AND r.execution_epoch=p.execution_epoch AND (${planEligible})) OR (r.run_id IS NOT NULL AND (${searchEligible})))
   ORDER BY r.created_at,r.object_key LIMIT $2 FOR UPDATE OF r SKIP LOCKED`,[workspace,limit])).rows;
 const items=[];
 for(const r of rows) {
  const token=randomUUID(),item=RawCleanupItemSchema.parse({workspace_id:workspace,key:r.object_key,kind:r.kind,plan_id:r.plan_id,run_id:r.run_id,execution_epoch:r.execution_epoch,
    lease_token:token,required_refs:r.required_refs,expected_bytes:r.expected_bytes===null?null:Number(r.expected_bytes)});
  if(!dryRun)await c.query("UPDATE telemetry.raw_retention SET state='LEASED',lease_token=$3,lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1 WHERE workspace_id=$1 AND object_key=$2",[workspace,r.object_key,token]);
  items.push(item);
 }
 return items;
}
export async function finishRawCleanup(c:PoolClient,workspace:string,raw:RawCleanupResult[]) {
 for(const value of raw) {
  const r=RawCleanupResultSchema.parse(value);
  const updated=await c.query(`UPDATE telemetry.raw_retention SET
    state=CASE WHEN $4='ERROR' THEN 'PENDING' ELSE 'DELETED' END,lease_until=NULL,
    retry_at=CASE WHEN $4='ERROR' THEN clock_timestamp()+interval '5 minutes' ELSE NULL END,last_error=$6,
    deleted_at=CASE WHEN $4='ERROR' THEN NULL ELSE clock_timestamp() END,
    deleted_bytes=CASE WHEN $4='DELETED' THEN $5 ELSE 0 END,outcome=CASE WHEN $4='ERROR' THEN NULL ELSE $4 END
    WHERE workspace_id=$1 AND object_key=$2 AND lease_token=$3 AND state='LEASED'`,[workspace,r.key,r.lease_token,r.outcome,r.bytes,r.error??null]);
  if(!updated.rowCount) {
   const prior=(await c.query('SELECT state,lease_token,outcome,deleted_bytes,last_error FROM telemetry.raw_retention WHERE workspace_id=$1 AND object_key=$2',[workspace,r.key])).rows[0];
   if(!prior||prior.lease_token!==r.lease_token||!(r.outcome==='ERROR'?prior.state==='PENDING'&&prior.last_error===(r.error??null):prior.state==='DELETED'&&prior.outcome===r.outcome&&Number(prior.deleted_bytes)===(r.outcome==='DELETED'?r.bytes:0)))
     throw new StoreError('STALE_EXECUTION','Raw cleanup lease is no longer held');
  }
 }
 return {accepted:true as const};
}
export async function rawRetentionStatus(pool:Pool,workspace:string) {
 const r=(await pool.query(`SELECT count(*) FILTER(WHERE state='PENDING')::int pending,count(*) FILTER(WHERE state='LEASED')::int leased,
   count(*) FILTER(WHERE state='DELETED')::int deleted,coalesce(sum(deleted_bytes),0)::float8 deleted_bytes,
   count(*) FILTER(WHERE outcome='MISSING')::int missing,count(*) FILTER(WHERE last_error IS NOT NULL)::int errors,max(deleted_at) last_deleted_at
   FROM telemetry.raw_retention WHERE workspace_id=$1`,[workspace])).rows[0];
 return RawRetentionStatusSchema.parse({...r,retention_hours:24,last_deleted_at:r.last_deleted_at?.toISOString()??null});
}
