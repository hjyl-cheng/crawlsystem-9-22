import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient,QueryResultRow} from 'pg';
import {FailureCommandSchema,FailureReportSchema,FailureSchema,type Failure,type FailureCommand} from '../../contracts/src/analytics.ts';
import type {Principal,Page,Plan} from '@crawlsystem/contracts';
import {contentHash} from '@crawlsystem/contracts/hash';
import {StoreError} from './index.ts';
const iso=(x:Date|string|null)=>x===null?null:new Date(x).toISOString();
const QUERY=`SELECT f.*,p.status AS plan_status,p.execution_epoch AS current_epoch,p.deadline_at,
  EXISTS(SELECT 1 FROM control.plans a WHERE a.workspace_id=f.workspace_id AND a.channel_id=f.channel_id AND a.status IN ('QUEUED','RUNNING','WAITING') AND a.plan_id<>f.plan_id) AS another_active,
  q.state AS run_state FROM control.failures f LEFT JOIN control.plans p ON p.plan_id=f.plan_id LEFT JOIN control.query_runs q ON q.run_id=f.run_id`;
function blocked(r:QueryResultRow,searchEnabled:boolean):string|null {
  if(r.state!=='OPEN')return '仅待处理的失败可以重试';
  if(['PLAN_TERMINAL','STALE_EXECUTION','CONFLICT','INPUT_MISMATCH','TARGET_MISMATCH'].includes(r.code))return '消息已失效或与冻结输入冲突，请核对后忽略';
  if(r.another_active)return '该频道已有执行中的计划';
  if(r.run_id)return searchEnabled && ['PENDING','FAILED'].includes(r.run_state)?null:'自动搜索仍暂停，搜索失败暂不重试';
  if(r.plan_status==='FAILED')return null;
  if(r.stage==='DISPATCH' && ['QUEUED','WAITING'].includes(r.plan_status) && new Date(r.deadline_at)>new Date())return null;
  if((r.raw||r.manifest) && ['QUEUED','RUNNING','WAITING'].includes(r.plan_status) && r.current_epoch===r.execution_epoch && new Date(r.deadline_at)>new Date())return null;
  return '缺少有效对象引用，或原计划已结束';
}
export function failureRow(r:QueryResultRow,searchEnabled=false):Failure {
  const reason=blocked(r,searchEnabled);
  return FailureSchema.parse({...r,first_at:iso(r.first_at),last_at:iso(r.last_at),retry_at:iso(r.retry_at),resolved_at:iso(r.resolved_at),retryable:reason===null,retry_blocked_reason:reason});
}
export async function listFailures(pool:Pool,workspace:string,limit:number,offset:number,state?:string,searchEnabled=false):Promise<Page<Failure>> {
  const rows=(await pool.query(`${QUERY} WHERE f.workspace_id=$1 AND f.archived_at IS NULL AND ($2::text IS NULL OR f.state=$2) ORDER BY f.last_at DESC,f.failure_id LIMIT $3 OFFSET $4`,[workspace,state??null,limit+1,offset])).rows;
  return {items:rows.slice(0,limit).map(r=>failureRow(r,searchEnabled)),next_cursor:rows.length>limit?String(offset+limit):null};
}
export async function getFailure(pool:Pool|PoolClient,workspace:string,id:string,searchEnabled=false):Promise<Failure> {
  const r=(await pool.query(`${QUERY} WHERE f.workspace_id=$1 AND f.failure_id=$2`,[workspace,id])).rows[0];
  if(!r)throw new StoreError('NOT_FOUND','Failure not found',404);
  return failureRow(r,searchEnabled);
}
export async function reportFailure(client:PoolClient,principal:Principal,raw:unknown):Promise<Failure> {
  const input=FailureReportSchema.parse(raw);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('failure-report:'||$1||':'||$2))",[principal.workspace_id,input.report_id]);
  const hash=contentHash(input),prior=(await client.query('SELECT payload_hash FROM control.failure_reports WHERE workspace_id=$1 AND report_id=$2',[principal.workspace_id,input.report_id])).rows[0];
  if(prior?.payload_hash && prior.payload_hash!==hash)throw new StoreError('CONFLICT','Failure report identity differs');
  if(input.plan_id) {
    const p=(await client.query('SELECT * FROM control.plans WHERE workspace_id=$1 AND plan_id=$2',[principal.workspace_id,input.plan_id])).rows[0];
    if(!p)throw new StoreError('NOT_FOUND','Owner not found',404);
    if(input.raw && (input.raw.workspace_id!==principal.workspace_id||input.raw.plan_id!==p.plan_id||input.raw.channel_id!==p.channel_id||input.raw.input_hash!==p.input_hash||input.raw.execution_epoch!==input.execution_epoch||input.raw.step!==input.step||input.raw.unit_id!==input.unit_id))throw new StoreError('INPUT_MISMATCH','Failure reference does not match owner');
    if(input.raw && (input.raw.bucket!=='crawl-raw'||input.raw.key!==`v1/${encodeURIComponent(principal.workspace_id)}/${p.plan_id}/${input.execution_epoch}/${input.step}/${input.unit_id}.json.gz`))throw new StoreError('INPUT_MISMATCH','Failure object is outside this execution');
    if(input.manifest && (input.manifest.owner.workspace_id!==principal.workspace_id||input.manifest.owner.plan_id!==p.plan_id||input.manifest.channel_id!==p.channel_id||input.manifest.owner.workflow_id!==p.workflow_id||input.manifest.owner.input_hash!==p.input_hash||input.manifest.owner.execution_epoch!==input.execution_epoch||input.manifest.step!==input.step))throw new StoreError('INPUT_MISMATCH','Failure manifest does not match owner');
    if(input.manifest && (input.manifest.key!==`v1/${encodeURIComponent(principal.workspace_id)}/${p.plan_id}/${input.execution_epoch}/${input.step}/_manifest.json.gz`||input.manifest.units.some(r=>r.bucket!=='crawl-raw'||r.key!==`v1/${encodeURIComponent(principal.workspace_id)}/${p.plan_id}/${input.execution_epoch}/${input.step}/${r.unit_id}.json.gz`)))throw new StoreError('INPUT_MISMATCH','Manifest objects are outside this execution');
  }else if(input.raw||input.manifest)throw new StoreError('INVALID_REQUEST','Reference requires an owner',400);
  if(input.run_id && !(await client.query('SELECT 1 FROM control.query_runs WHERE workspace_id=$1 AND run_id=$2',[principal.workspace_id,input.run_id])).rowCount)throw new StoreError('NOT_FOUND','Search owner not found',404);
  const id=(await client.query('SELECT telemetry.record_failure($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS id',
    [principal.workspace_id,input.report_id,input.stage,input.code,input.plan_id,input.run_id,input.execution_epoch,input.step,input.unit_id,input.attempts,input.raw])).rows[0].id;
  await client.query('UPDATE control.failure_reports SET payload_hash=$3 WHERE workspace_id=$1 AND report_id=$2',[principal.workspace_id,input.report_id,hash]);
  if(input.manifest)await client.query("UPDATE control.failures SET manifest=$3,evidence_state=CASE WHEN evidence IS NULL THEN 'PENDING' ELSE 'SAVED' END WHERE workspace_id=$1 AND failure_id=$2",[principal.workspace_id,id,input.manifest]);
  return getFailure(client,principal.workspace_id,id);
}
export async function commandFailure(client:PoolClient,principal:Principal,id:string,raw:FailureCommand,searchEnabled:boolean,restart:(client:PoolClient,row:QueryResultRow,command:FailureCommand)=>Promise<Plan>):Promise<Failure> {
  const input=FailureCommandSchema.parse(raw),hash=contentHash({id,...input});
  await client.query("SELECT pg_advisory_xact_lock(hashtext('failure-command:'||$1||':'||$2))",[principal.workspace_id,input.command_id]);
  const prior=(await client.query('SELECT command_hash,result FROM control.failure_commands WHERE workspace_id=$1 AND command_id=$2',[principal.workspace_id,input.command_id])).rows[0];
  if(prior) {if(prior.command_hash!==hash)throw new StoreError('CONFLICT','Command identity differs');return FailureSchema.parse(prior.result);}
  // Plan -> failure is the same order as completion, so an operator cannot deadlock a sink.
  const owner=(await client.query('SELECT plan_id FROM control.failures WHERE workspace_id=$1 AND failure_id=$2',[principal.workspace_id,id])).rows[0];
  if(owner?.plan_id)await client.query('SELECT 1 FROM control.plans WHERE plan_id=$1 FOR UPDATE',[owner.plan_id]);
  const r=(await client.query(`${QUERY} WHERE f.workspace_id=$1 AND f.failure_id=$2 FOR UPDATE OF f`,[principal.workspace_id,id])).rows[0];
  if(!r)throw new StoreError('NOT_FOUND','Failure not found',404);
  if(r.version!==input.expected_version)throw new StoreError('CONFLICT','Failure changed; refresh before acting');
  if(!['OPEN','RETRYING'].includes(r.state))throw new StoreError('CONFLICT','Failure already settled');
  if(input.action==='ignore') {
    if(r.state==='RETRYING')throw new StoreError('CONFLICT','Wait for the requested retry to settle');
    await client.query("UPDATE control.failures SET state='IGNORED',reason=$3,decided_by=$4,resolved_at=clock_timestamp(),version=version+1 WHERE workspace_id=$1 AND failure_id=$2",[principal.workspace_id,id,input.reason,principal.subject]);
  }else {
    const reason=blocked(r,searchEnabled);if(reason)throw new StoreError('CONFLICT',reason);
    let newPlan:string|null=null;
    if(r.run_id) {
      await client.query("UPDATE control.query_runs SET state='PENDING',failures=0,retry_at=clock_timestamp(),worker_id=NULL,lease_expires_at=NULL,finished_at=NULL WHERE run_id=$1",[r.run_id]);
    }else if(r.plan_status==='FAILED') {
      newPlan=(await restart(client,r,input)).plan_id;
    }else if(r.stage==='DISPATCH') {
      await client.query("UPDATE control.intents SET state='PENDING',available_at=clock_timestamp(),lease_until=NULL,lease_token=NULL WHERE plan_id=$1 AND kind='START' AND state<>'DONE'",[r.plan_id]);
    }else {
      await client.query('INSERT INTO control.failure_replays(replay_id,workspace_id,failure_id,raw) VALUES($1,$2,$3,$4)',[randomUUID(),principal.workspace_id,id,r.raw??r.manifest]);
    }
    await client.query("UPDATE control.failures SET state='RETRYING',reason=$3,decided_by=$4,retry_at=clock_timestamp(),retry_plan_id=$5,attempts=attempts+1,version=version+1 WHERE workspace_id=$1 AND failure_id=$2",[principal.workspace_id,id,input.reason,principal.subject,newPlan]);
  }
  const result=await getFailure(client,principal.workspace_id,id,searchEnabled);
  await client.query('INSERT INTO control.failure_commands(workspace_id,command_id,command_hash,failure_id,result) VALUES($1,$2,$3,$4,$5)',[principal.workspace_id,input.command_id,hash,id,result]);
  return result;
}
