import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {StoreError} from './index.ts';
import {OpsEventSchema,StorageSchema} from '../../contracts/src/analytics.ts';
const iso=(x:Date|null)=>x?x.toISOString():null;
export async function outbox(client:PoolClient,workspace:string) {
  const rows=(await client.query(`WITH claimed AS (SELECT seq FROM telemetry.outbox WHERE workspace_id=$1 AND archived_at IS NULL AND (lease_until IS NULL OR lease_until<clock_timestamp())
    AND (published_at IS NULL OR published_at<clock_timestamp()-interval '1 hour') ORDER BY seq LIMIT 100 FOR UPDATE SKIP LOCKED)
    UPDATE telemetry.outbox o SET lease_until=clock_timestamp()+interval '60 seconds' FROM claimed c WHERE c.seq=o.seq RETURNING o.event`,[workspace])).rows;
  return rows.map(r=>OpsEventSchema.parse(r.event));
}
export async function acknowledge(client:PoolClient,workspace:string,ids:string[],archived:boolean) {
  if(!ids.length)return {accepted:true as const};
  await client.query(`UPDATE telemetry.outbox SET ${archived?'archived_at=coalesce(archived_at,clock_timestamp())':'published_at=clock_timestamp()'},lease_until=NULL WHERE workspace_id=$1 AND event->>'event_id'=ANY($2::text[])`,[workspace,ids]);
  return {accepted:true as const};
}
export async function claimReplays(client:PoolClient,workspace:string) {
  const rows=(await client.query(`SELECT r.*,p.status,p.execution_epoch,p.deadline_at FROM control.failure_replays r JOIN control.failures f USING(failure_id) JOIN control.plans p ON p.plan_id=f.plan_id
    WHERE r.workspace_id=$1 AND (r.state='PENDING' OR r.state='LEASED' AND r.lease_until<clock_timestamp()) ORDER BY r.created_at LIMIT 10 FOR UPDATE OF r SKIP LOCKED`,[workspace])).rows;
  const result=[];
  for(const r of rows) {
    if(!['QUEUED','RUNNING','WAITING'].includes(r.status)||(r.raw.execution_epoch??r.raw.owner?.execution_epoch)!==r.execution_epoch||new Date(r.deadline_at)<new Date()||r.attempts>=5) {
      await client.query("UPDATE control.failure_replays SET state='SKIPPED',finished_at=clock_timestamp() WHERE replay_id=$1",[r.replay_id]);
      await client.query("UPDATE control.failures SET state='OPEN',version=version+1 WHERE failure_id=$1 AND state='RETRYING'",[r.failure_id]);continue;
    }
    const token=randomUUID();
    await client.query("UPDATE control.failure_replays SET state='LEASED',lease_token=$2,lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1 WHERE replay_id=$1",[r.replay_id,token]);
    result.push({replay_id:r.replay_id,lease_token:token,raw:r.raw});
  }
  return result;
}
export async function finishReplay(client:PoolClient,workspace:string,id:string,token:string,ok:boolean) {
  const r=(await client.query("UPDATE control.failure_replays SET state=CASE WHEN $4 THEN 'DONE' ELSE 'FAILED' END,finished_at=clock_timestamp() WHERE workspace_id=$1 AND replay_id=$2 AND lease_token=$3 AND state='LEASED' RETURNING failure_id",[workspace,id,token,ok])).rows[0];
  if(!r)throw new StoreError('STALE_EXECUTION','Replay lease is no longer held');
  if(!ok)await client.query("UPDATE control.failures SET state='OPEN',version=version+1 WHERE failure_id=$1 AND state='RETRYING'",[r.failure_id]);
  return {accepted:true as const};
}
export async function storage(pool:Pool,workspace:string,clickhouse:unknown) {
  const r=(await pool.query(`SELECT pg_database_size(current_database())::float8 AS bytes,
    (SELECT count(*)::int FROM telemetry.outbox WHERE workspace_id=$1 AND published_at IS NULL) AS pending,
    (SELECT count(*)::int FROM telemetry.outbox WHERE workspace_id=$1 AND archived_at IS NULL) AS unarchived,
    (SELECT min(created_at) FROM telemetry.outbox WHERE workspace_id=$1 AND archived_at IS NULL) AS oldest,
    (SELECT count(*)::int FROM control.failures WHERE workspace_id=$1 AND state='OPEN') AS open,
    (SELECT count(*)::int FROM control.failures WHERE workspace_id=$1 AND state='RETRYING') AS retrying,
    (SELECT count(*)::int FROM control.failures WHERE workspace_id=$1 AND evidence_state='PENDING') AS evidence,
    (SELECT count(*)::int FROM control.failure_replays WHERE workspace_id=$1 AND state IN ('PENDING','LEASED')) AS replays,
    (SELECT count(*)::int FROM control.failure_replays WHERE workspace_id=$1 AND state='FAILED') AS replay_failed`,[workspace])).rows[0];
  const m=(await pool.query('SELECT * FROM telemetry.maintenance WHERE workspace_id=$1',[workspace])).rows[0];
  return StorageSchema.parse({observed_at:new Date().toISOString(),postgres_bytes:r.bytes,outbox:{pending:r.pending,unarchived:r.unarchived,oldest_pending_at:iso(r.oldest)},failures:{open:r.open,retrying:r.retrying,evidence_pending:r.evidence},replays:{pending:r.replays,failed:r.replay_failed},clickhouse,
    retention:{pg_days:30,events_days:180,evidence_days:90,loki_days:7,summaries:'long_term'},maintenance:{last_at:m?iso(m.last_at):null,result:m?.result??null}});
}
/** Bounded compaction. Live facts and all recovery/idempotence identities survive. */
export async function maintain(client:PoolClient,workspace:string,dryRun:boolean) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('r5-maintenance:'||$1))",[workspace]);
  const eligible=`p.workspace_id=$1 AND p.status IN ('COMPLETED','CANCELLED','FAILED') AND p.finished_at<clock_timestamp()-interval '30 days'
    AND NOT EXISTS(SELECT 1 FROM control.failures f WHERE (f.plan_id=p.plan_id OR f.retry_plan_id=p.plan_id) AND f.state IN ('OPEN','RETRYING'))
    AND NOT EXISTS(SELECT 1 FROM telemetry.outbox o WHERE o.workspace_id=$1 AND o.event->>'plan_id'=p.plan_id::text AND o.archived_at IS NULL)`;
  const events=(await client.query(`SELECT e.plan_id,e.event_id,e.event_hash FROM control.events e JOIN control.plans p USING(plan_id) WHERE ${eligible}
    AND EXISTS(SELECT 1 FROM telemetry.outbox o WHERE o.source_key='event:'||e.plan_id||':'||e.event_id AND o.archived_at IS NOT NULL) ORDER BY e.created_at LIMIT 500`,[workspace])).rows;
  const units=(await client.query(`SELECT u.plan_id,u.execution_epoch,u.step,u.unit_id FROM crawl_data.ingest_units u JOIN control.plans p USING(plan_id) WHERE ${eligible} AND u.fact ? 'kind'
    AND EXISTS(SELECT 1 FROM telemetry.outbox o WHERE o.source_key='unit:'||u.plan_id||':'||u.execution_epoch||':'||u.step||':'||u.unit_id AND o.archived_at IS NOT NULL) ORDER BY u.applied_at LIMIT 500`,[workspace])).rows;
  const failures=(await client.query(`SELECT failure_id FROM control.failures f WHERE workspace_id=$1 AND state IN ('RESOLVED','IGNORED') AND archived_at IS NULL AND resolved_at<clock_timestamp()-interval '30 days'
    AND NOT EXISTS(SELECT 1 FROM telemetry.outbox o WHERE o.event->>'plan_id'=coalesce(f.plan_id::text,f.run_id::text,'') AND o.archived_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM control.failure_replays r WHERE r.failure_id=f.failure_id AND r.state IN ('PENDING','LEASED')) LIMIT 500`,[workspace])).rows;
  if(!dryRun) {
    for(const e of events) {
      await client.query('INSERT INTO control.event_archive_identities(plan_id,event_id,event_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[e.plan_id,e.event_id,e.event_hash]);
      await client.query('DELETE FROM control.events WHERE plan_id=$1 AND event_id=$2',[e.plan_id,e.event_id]);
    }
    // Control has no fact-write grant. A fixed SECURITY DEFINER compactor verifies eligibility again.
    for(const u of units)await client.query('SELECT telemetry.compact_unit($1,$2,$3,$4,$5)',[workspace,u.plan_id,u.execution_epoch,u.step,u.unit_id]);
    if(failures.length)await client.query("UPDATE control.failures SET archived_at=clock_timestamp(),raw=NULL,raw_object=NULL,manifest=NULL WHERE failure_id=ANY($1::uuid[])",[failures.map(f=>f.failure_id)]);
    await client.query(`UPDATE control.plans p SET pipeline_agent_snapshot=NULL WHERE ${eligible} AND pipeline_agent_snapshot IS NOT NULL`,[workspace]);
    // Retain outbox entries while source detail still needs compaction; identities remain after it.
    await client.query(`DELETE FROM telemetry.outbox o WHERE seq IN (SELECT seq FROM telemetry.outbox o WHERE workspace_id=$1 AND archived_at<clock_timestamp()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM control.events e WHERE o.source_key='event:'||e.plan_id||':'||e.event_id)
      AND NOT EXISTS(SELECT 1 FROM crawl_data.ingest_units u WHERE u.fact ? 'kind' AND o.source_key='unit:'||u.plan_id||':'||u.execution_epoch||':'||u.step||':'||u.unit_id)
      AND NOT EXISTS(SELECT 1 FROM control.plans p WHERE p.plan_id::text=o.event->>'plan_id' AND p.status IN ('QUEUED','RUNNING','WAITING'))
      AND NOT EXISTS(SELECT 1 FROM control.failures f WHERE f.workspace_id=$1 AND coalesce(f.plan_id::text,f.run_id::text,'')=o.event->>'plan_id' AND f.state IN ('OPEN','RETRYING')) ORDER BY seq LIMIT 500)`,[workspace]);
  }
  const result={events:events.length,units:units.length,failures:failures.length};
  if(!dryRun)await client.query('INSERT INTO telemetry.maintenance(workspace_id,last_at,result) VALUES($1,clock_timestamp(),$2) ON CONFLICT(workspace_id) DO UPDATE SET last_at=EXCLUDED.last_at,result=EXCLUDED.result',[workspace,result]);
  return {dry_run:dryRun,...result};
}
