import type {Pool,PoolClient,QueryResultRow} from 'pg';
import {WORKER_STALE_SECONDS,type Worker,type Heartbeat} from '@crawlsystem/contracts';
import {WorkerCommandSchema,WorkerControlSchema,type WorkerControl,type WorkerMetrics} from '../../contracts/src/workers.ts';
import {contentHash} from '@crawlsystem/contracts/hash';
import {StoreError} from './index.ts';
const iso=(v:Date|string)=>new Date(v).toISOString();
/** Serializes assignment, search claims and operator commands. An assignment committed before
 * pause is already admitted work; no assignment can commit behind the closed gate. */
export async function lockWorkerAdmission(db:PoolClient,workspace:string){await db.query("SELECT pg_advisory_xact_lock(hashtext('worker-admission:'||$1))",[workspace]);}
const workerRow=async(db:Pool|PoolClient,workspace:string,id:string)=>{
 const r=(await db.query('SELECT *,last_heartbeat_at<clock_timestamp()-($3*interval \'1 second\') AS stale FROM control.workers WHERE workspace_id=$1 AND worker_id=$2',[workspace,id,WORKER_STALE_SECONDS])).rows[0];
 if(!r)throw new StoreError('NOT_FOUND','Worker not found',404);return r;
};
export async function workerView(db:Pool|PoolClient,r:QueryResultRow):Promise<Worker>{
 const plans=(await db.query("SELECT a.plan_id FROM control.worker_plans a JOIN control.plans p USING(plan_id) WHERE a.workspace_id=$1 AND a.worker_id=$2 AND p.status IN ('QUEUED','RUNNING','WAITING') ORDER BY a.assigned_at LIMIT 100",[r.workspace_id,r.worker_id])).rows.map(p=>p.plan_id as string);
 const queries=(await db.query("SELECT run_id FROM control.query_runs WHERE workspace_id=$1 AND worker_id=$2 AND state='RUNNING' ORDER BY started_at LIMIT 100",[r.workspace_id,r.worker_id])).rows.map(p=>p.run_id as string);
 const legacy=(await db.query(`SELECT count(*)::int AS n FROM control.plans p WHERE p.workspace_id=$1 AND p.status IN ('QUEUED','RUNNING','WAITING')
  AND NOT EXISTS(SELECT 1 FROM control.worker_plans a WHERE a.plan_id=p.plan_id)
  AND EXISTS(SELECT 1 FROM control.intents i WHERE i.plan_id=p.plan_id AND i.kind='START' AND i.attempts>0)`,[r.workspace_id])).rows[0].n as number;
 const hb=r.heartbeat as Heartbeat,applied=hb.management?.applied_version??0;
 const status:WorkerControl['status']=r.stale?'OFFLINE':!hb.management?'UNSUPPORTED':applied!==r.control_version||!hb.management.ready?'PENDING'
  :r.desired_mode==='RUNNING'?'RUNNING':r.desired_mode==='PAUSED'?'PAUSED'
  :plans.length||queries.length||legacy||hb.running_plan_ids.length||(hb.running_query_run_ids?.length??0)?'DRAINING':'DRAINED';
 return {...hb,last_heartbeat_at:iso(r.last_heartbeat_at),stale:r.stale,proxy_status:hb.collector?'CONFIGURED':'NOT_CONFIGURED',
  control:WorkerControlSchema.parse({version:r.control_version,desired:r.desired_mode,applied_version:applied,status,reason:r.control_reason,changed_at:r.control_changed_at?iso(r.control_changed_at):null,active_plan_ids:plans,active_query_run_ids:queries,legacy_pending:legacy})};
}
export async function getWorker(db:Pool|PoolClient,workspace:string,id:string){return workerView(db,await workerRow(db,workspace,id));}
export async function commandWorker(db:PoolClient,workspace:string,id:string,operator:string,mode:WorkerControl['desired'],raw:unknown){
 const c=WorkerCommandSchema.parse(raw),hash=contentHash({id,mode,...c});await lockWorkerAdmission(db,workspace);
 const previous=(await db.query('SELECT request_hash FROM control.worker_commands WHERE workspace_id=$1 AND command_id=$2',[workspace,c.command_id])).rows[0];
 if(previous){if(previous.request_hash!==hash)throw new StoreError('CONFLICT','Command ID has different content');return getWorker(db,workspace,id);}
 const r=await workerRow(db,workspace,id);
 if(!r.heartbeat.management)throw new StoreError('CONFLICT','Worker needs a control-capable version');
 if(r.stale)throw new StoreError('CONFLICT','Worker is offline; reconnect before changing its state');
 if(r.control_version!==c.expected_version)throw new StoreError('CONFLICT','Worker version changed; refresh before retrying');
 await db.query('UPDATE control.workers SET desired_mode=$3,control_version=control_version+1,control_reason=$4,control_changed_at=clock_timestamp() WHERE workspace_id=$1 AND worker_id=$2',[workspace,id,mode,c.reason]);
 await db.query('INSERT INTO control.worker_commands(workspace_id,command_id,worker_id,request_hash,version,mode,reason,operator) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[workspace,c.command_id,id,hash,c.expected_version+1,mode,c.reason,operator]);
 return getWorker(db,workspace,id);
}
export async function queryAdmission(db:PoolClient,workspace:string,id:string){
 await lockWorkerAdmission(db,workspace);
 const r=(await db.query('SELECT *,last_heartbeat_at<clock_timestamp()-($3*interval \'1 second\') AS stale FROM control.workers WHERE workspace_id=$1 AND worker_id=$2',[workspace,id,WORKER_STALE_SECONDS])).rows[0];
 // Old development Workers without a registration keep their pre-D2 contract.
 if(!r)return !(await db.query('SELECT 1 FROM control.worker_routing WHERE workspace_id=$1',[workspace])).rowCount;
 return !r.stale&&r.desired_mode==='RUNNING'&&(!r.heartbeat.management||r.heartbeat.management.ready&&r.heartbeat.management.applied_version===r.control_version&&r.heartbeat.accepting_work);
}
export async function recordWorker(db:PoolClient,workspace:string,input:Heartbeat){
 await lockWorkerAdmission(db,workspace);
 if(input.management){
  const current=(await db.query('SELECT control_version FROM control.workers WHERE workspace_id=$1 AND worker_id=$2',[workspace,input.worker_id])).rows[0];
  if(input.management.applied_version>(current?.control_version??1))throw new StoreError('INVALID_REQUEST','Applied control version exceeds desired version',400);
 }
 await db.query(`INSERT INTO control.workers(workspace_id,worker_id,heartbeat) VALUES($1,$2,$3)
  ON CONFLICT(workspace_id,worker_id) DO UPDATE SET heartbeat=EXCLUDED.heartbeat,last_heartbeat_at=clock_timestamp()`,[workspace,input.worker_id,input]);
 if(input.management){
  await db.query('INSERT INTO control.worker_routing(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[workspace]);
  // During the upgrade, existing shared-queue plans are adopted from actual executing activities.
  await db.query(`INSERT INTO control.worker_plans(workspace_id,worker_id,plan_id,queue_kind)
   SELECT $1,$2,p.plan_id,'LEGACY' FROM control.plans p WHERE p.workspace_id=$1 AND p.plan_id=ANY($3::uuid[])
   ON CONFLICT(plan_id) DO UPDATE SET worker_id=EXCLUDED.worker_id WHERE control.worker_plans.queue_kind='LEGACY'`,[workspace,input.worker_id,input.running_plan_ids]);
 }
 if(input.process){
  const at=Date.parse(input.process.sampled_at);
  if(!Number.isFinite(at)||Math.abs(Date.now()-at)>120000)throw new StoreError('INVALID_REQUEST','Process sample is stale',400);
  await db.query('INSERT INTO control.worker_samples(workspace_id,worker_id,process) VALUES($1,$2,$3)',[workspace,input.worker_id,input.process]);
  await db.query("DELETE FROM control.worker_samples WHERE workspace_id=$1 AND worker_id=$2 AND sampled_at<clock_timestamp()-interval '25 hours'",[workspace,input.worker_id]);
 }
 return getWorker(db,workspace,input.worker_id);
}
/** Slots of the Workers that can take a plan now, and the plans already holding or awaiting one.
 * A legacy Worker without a management protocol counts while it accepts work. */
export async function workerCapacity(db:Pool|PoolClient,workspace:string){
 const r=(await db.query(`SELECT coalesce((SELECT sum((w.heartbeat->>'capacity')::int) FROM control.workers w WHERE w.workspace_id=$1 AND w.desired_mode='RUNNING'
   AND w.last_heartbeat_at>=clock_timestamp()-($2*interval '1 second') AND w.heartbeat->>'accepting_work'='true'
   AND (w.heartbeat->'management' IS NULL OR w.heartbeat->'management'->>'protocol'='worker-control-1' AND w.heartbeat->'management'->>'ready'='true'
     AND (w.heartbeat->'management'->>'applied_version')::int=w.control_version)),0)::int AS slots,
  count(*)::int AS active_plans,count(*) FILTER(WHERE plan_kind='UPDATE')::int AS active_updates
  FROM control.plans WHERE workspace_id=$1 AND status IN ('QUEUED','RUNNING','WAITING')`,[workspace,WORKER_STALE_SECONDS])).rows[0]!;
 return {slots:r.slots as number,active_plans:r.active_plans as number,active_updates:r.active_updates as number};
}
/** While first collections wait, updates keep half of the slots (rounded up); otherwise either side may use all. */
export const updateSlots=(slots:number,importsWaiting:boolean)=>importsWaiting?Math.ceil(slots/2):slots;
/** Frozen ownership is written in the same transaction as the START lease, including RPC retries. */
export async function routePlan(db:PoolClient,workspace:string,planId:string,attempts:number):Promise<string|null|false>{
 const existing=(await db.query('SELECT worker_id,queue_kind FROM control.worker_plans WHERE plan_id=$1',[planId])).rows[0];
 if(existing)return existing.queue_kind==='OWNED'?existing.worker_id:null;
 const enabled=(await db.query('SELECT 1 FROM control.worker_routing WHERE workspace_id=$1',[workspace])).rowCount;
 if(!enabled||attempts>1)return null; // A previously leased legacy RPC may already have committed.
 const r=(await db.query(`SELECT w.worker_id FROM control.workers w WHERE w.workspace_id=$1 AND w.desired_mode='RUNNING'
  AND w.last_heartbeat_at>=clock_timestamp()-($2*interval '1 second') AND w.heartbeat->>'accepting_work'='true'
  AND w.heartbeat->'management'->>'protocol'='worker-control-1' AND w.heartbeat->'management'->>'ready'='true'
  AND (w.heartbeat->'management'->>'applied_version')::int=w.control_version
  AND (SELECT count(*) FROM control.worker_plans a JOIN control.plans p USING(plan_id) WHERE a.workspace_id=w.workspace_id AND a.worker_id=w.worker_id AND p.status IN ('QUEUED','RUNNING','WAITING'))<(w.heartbeat->>'capacity')::int
  ORDER BY (SELECT count(*) FROM control.worker_plans a JOIN control.plans p USING(plan_id) WHERE a.workspace_id=w.workspace_id AND a.worker_id=w.worker_id AND p.status IN ('QUEUED','RUNNING','WAITING')),w.worker_id LIMIT 1`,[workspace,WORKER_STALE_SECONDS])).rows[0];
 if(!r)return false;
 await db.query("INSERT INTO control.worker_plans(workspace_id,worker_id,plan_id,queue_kind) VALUES($1,$2,$3,'OWNED')",[workspace,r.worker_id,planId]);return r.worker_id;
}
export async function workerMetrics(db:Pool,workspace:string,id:string):Promise<Omit<WorkerMetrics,'node'|'monitoring_available'>>{
 const worker=await getWorker(db,workspace,id);
 const resources=(await db.query(`WITH samples AS (SELECT date_bin(interval '5 minutes',sampled_at,timestamptz '2000-01-01') AS at,
  avg((process->>'cpu_cores')::float8) AS cpu_cores,avg((process->>'rss_bytes')::float8) AS rss_bytes
  FROM control.worker_samples WHERE workspace_id=$1 AND worker_id=$2 AND sampled_at>=clock_timestamp()-interval '24 hours' GROUP BY 1),
  buckets AS(SELECT generate_series((SELECT min(at) FROM samples),date_bin(interval '5 minutes',clock_timestamp(),timestamptz '2000-01-01'),interval '5 minutes') AS at)
  SELECT b.at,s.cpu_cores,s.rss_bytes FROM buckets b LEFT JOIN samples s USING(at) ORDER BY b.at`,[workspace,id])).rows.map(r=>({at:iso(r.at),cpu_cores:r.cpu_cores,rss_bytes:r.rss_bytes}));
 const tasks=(await db.query(`WITH hours AS (SELECT generate_series(date_trunc('hour',clock_timestamp())-interval '23 hours',date_trunc('hour',clock_timestamp()),interval '1 hour') AS at),
  plans AS (SELECT date_trunc('hour',p.finished_at) AS at,count(*) FILTER(WHERE p.status='COMPLETED')::int AS ok,count(*) FILTER(WHERE p.status='FAILED')::int AS failed
   FROM control.plans p LEFT JOIN control.worker_plans a USING(plan_id) WHERE p.workspace_id=$1 AND p.finished_at>=date_trunc('hour',clock_timestamp())-interval '23 hours'
    AND coalesce(a.worker_id,(SELECT e.data->>'worker_id' FROM control.events e WHERE e.plan_id=p.plan_id AND e.data->>'worker_id'<>'control-dispatcher' ORDER BY e.created_at DESC LIMIT 1))=$2 GROUP BY 1),
  queries AS (SELECT date_trunc('hour',finished_at) AS at,count(*) FILTER(WHERE state='SUCCEEDED')::int AS ok,count(*) FILTER(WHERE state='FAILED')::int AS failed FROM control.query_runs
   WHERE workspace_id=$1 AND coalesce(worker_id,last_worker_id)=$2 AND finished_at>=date_trunc('hour',clock_timestamp())-interval '23 hours' GROUP BY 1)
  SELECT h.at,coalesce(p.ok,0) AS plans_completed,coalesce(p.failed,0) AS plans_failed,coalesce(q.ok,0) AS queries_completed,coalesce(q.failed,0) AS queries_failed FROM hours h LEFT JOIN plans p USING(at) LEFT JOIN queries q USING(at) ORDER BY h.at`,[workspace,id])).rows.map(r=>({...r,at:iso(r.at)}));
 return {worker_id:id,server_id:worker.server_id,sampled_at:new Date().toISOString(),process:worker.stale?null:worker.process??null,resources,tasks};
}
