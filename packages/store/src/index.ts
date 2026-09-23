import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { CONTRACT_VERSION, WORKER_STALE_SECONDS, SubmissionSchema, CreatePlanSchema, CancelPlanSchema, HeartbeatSchema, ExecutionEventSchema,
  type Principal, type Role, type ErrorCode, type Plan, type PlanInput, type PlanDetail, type Domain, type DomainResult, type FrozenInput, type CreatePlan, type Submission, type Receipt,
  type Page, type ChannelSummary, type ChannelDetail, type Worker, type Heartbeat, type ExecutionEvent, type StoredEvent, type WorkflowInput } from '@crawlsystem/contracts';
import { contentHash, submissionHash } from '@crawlsystem/contracts/hash';
import { createFrozenFixture } from '@crawlsystem/contracts/fixtures';

export class StoreError extends Error {
  constructor(public code: ErrorCode, message: string, public status = 409, public retryable = false) { super(message); }
}
export function requireRole(principal: Principal, ...roles: Role[]): void {
  if (!roles.includes(principal.role)) throw new StoreError('FORBIDDEN', 'This role cannot perform the operation', 403);
}
const iso = (value: Date | string): string => new Date(value).toISOString();
export function toPlan(row: QueryResultRow): Plan {
  return { plan_id: row.plan_id, run_id: row.run_id, workspace_id: row.workspace_id, channel_id: row.channel_id, source_revision: Number(row.source_revision),
    source_mode: 'fixture', fixture_id: row.fixture_id, required_domains: row.required_domains, status: row.status, version: row.version, execution_epoch: row.execution_epoch,
    input_hash: row.input_hash, workflow_id: row.workflow_id, created_at: iso(row.created_at), updated_at: iso(row.updated_at), finished_at: row.finished_at ? iso(row.finished_at) : null,
    deadline_at: iso(row.deadline_at), publication_status: 'NOT_ENABLED' };
}
function page<T>(rows: T[], limit: number, offset: number): Page<T> { return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? String(offset + limit) : null }; }
const terminal = (status: string) => ['COMPLETED','CANCELLED','FAILED'].includes(status);
export interface Intent { intent_id: string; plan_id: string; kind: 'START' | 'CANCEL'; lease_token: string; attempts: number; input: WorkflowInput; plan_status: string; deadline_at: string; }

export class Store {
  constructor(public readonly pool: Pool) {}
  private async tx<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      let discard = false;
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query("SET LOCAL transaction_timeout = '10s'");
        const result = await action(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        discard = /connection|timeout/i.test((error as Error).message) || /^08/.test((error as {code?:string}).code ?? '');
        if (!discard) await client.query('ROLLBACK').catch(() => { discard = true; });
        const code = (error as {code?:string}).code;
        if (attempt < 2 && ['40001','40P01'].includes(code ?? '')) continue;
        if (code === '23505') throw new StoreError('CONFLICT', 'Identity already belongs to different content');
        throw error;
      } finally { client.release(discard); }
    }
  }
  private async planRow(client: PoolClient | Pool, principal: Principal, id: string, lock = false): Promise<QueryResultRow> {
    const result = await client.query(`SELECT * FROM m1.plans WHERE plan_id=$1 AND workspace_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, principal.workspace_id]);
    if (!result.rowCount) throw new StoreError('NOT_FOUND', 'Plan not found', 404);
    return result.rows[0]!;
  }
  async createPlan(principal: Principal, raw: CreatePlan): Promise<Plan> {
    requireRole(principal, 'operator');
    const input = CreatePlanSchema.parse(raw);
    const requestHash = contentHash(input);
    const planId = randomUUID();
    const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
    const frozen = createFrozenFixture(input.required_domains, deadline);
    return this.tx(async client => {
      const inserted = await client.query(`INSERT INTO m1.plans(plan_id,run_id,workspace_id,request_id,request_hash,channel_id,source_mode,fixture_id,required_domains,status,frozen_input,input_hash,workflow_id,deadline_at)
        VALUES($1,$2,$3,$4,$5,$6,'fixture',$7,$8,'QUEUED',$9,$10,$11,$12) ON CONFLICT(workspace_id,request_id) DO NOTHING RETURNING *`,
        [planId, randomUUID(), principal.workspace_id, input.request_id, requestHash, frozen.channel_id, input.fixture_id, input.required_domains, frozen, contentHash(frozen), `m1/${principal.workspace_id}/${planId}`, deadline]);
      if (!inserted.rowCount) {
        const old = (await client.query('SELECT * FROM m1.plans WHERE workspace_id=$1 AND request_id=$2', [principal.workspace_id, input.request_id])).rows[0]!;
        if (old.request_hash !== requestHash) throw new StoreError('CONFLICT', 'Creation identity has different input');
        return toPlan(old);
      }
      const row = inserted.rows[0]!;
      await client.query("INSERT INTO m1.domains(plan_id,domain) SELECT $1,unnest($2::text[])", [planId, input.required_domains]);
      await client.query(`INSERT INTO m1.channels(workspace_id,channel_id,latest_plan_id,latest_plan_revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(workspace_id,channel_id) DO UPDATE SET latest_plan_id=EXCLUDED.latest_plan_id,latest_plan_revision=EXCLUDED.latest_plan_revision,updated_at=clock_timestamp()
        WHERE m1.channels.latest_plan_revision < EXCLUDED.latest_plan_revision`, [principal.workspace_id,frozen.channel_id,planId,row.source_revision]);
      await client.query("INSERT INTO m1.intents(intent_id,plan_id,kind) VALUES($1,$2,'START')", [randomUUID(),planId]);
      return toPlan(row);
    });
  }
  async getInput(principal: Principal, id: string): Promise<PlanInput> {
    // One consistent database snapshot: plan, proofs and receipts never straddle a commit.
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL transaction_timeout = '10s'");
      const row = await this.planRow(client,principal,id);
      const domains = await client.query('SELECT domain,state,completed_at FROM m1.domains WHERE plan_id=$1 ORDER BY domain', [id]);
      const receipts = await client.query('SELECT receipt FROM m1.receipts WHERE plan_id=$1 ORDER BY applied_at LIMIT 300', [id]);
      await client.query('COMMIT');
      return {plan:toPlan(row), input:row.frozen_input as FrozenInput, domains:domains.rows.map(r => ({domain:r.domain,state:r.state,completed_at:r.completed_at ? iso(r.completed_at) : null} as DomainResult)), receipts:receipts.rows.map(r => r.receipt as Receipt)};
    } catch(error) {
      discard = /connection|timeout/i.test((error as Error).message) || /^08/.test((error as {code?:string}).code ?? '');
      if (!discard) await client.query('ROLLBACK').catch(() => {discard=true;});
      throw error;
    }
    finally { client.release(discard); }
  }
  async getPlan(principal: Principal, id: string): Promise<PlanDetail> {
    const context = await this.getInput(principal,id);
    const events = await this.pool.query('SELECT data,created_at FROM m1.events WHERE plan_id=$1 ORDER BY created_at DESC LIMIT 100',[id]);
    return {...context, events:events.rows.map(r => ({...r.data,plan_id:id,created_at:iso(r.created_at)} as StoredEvent))};
  }
  async listPlans(principal: Principal, limit=20, offset=0, status?: string): Promise<Page<Plan>> {
    requireRole(principal,'reader','operator');
    const result = await this.pool.query('SELECT * FROM m1.plans WHERE workspace_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC,plan_id LIMIT $3 OFFSET $4',[principal.workspace_id,status ?? null,limit+1,offset]);
    return page(result.rows.map(toPlan),limit,offset);
  }
  async getReceipt(principal: Principal, submissionId: string): Promise<Receipt> {
    const result = await this.pool.query('SELECT receipt FROM m1.receipts WHERE workspace_id=$1 AND submission_id=$2',[principal.workspace_id,submissionId]);
    if (!result.rowCount) throw new StoreError('NOT_FOUND','Receipt not found',404);
    return result.rows[0]!.receipt as Receipt;
  }
  async apply(principal: Principal, raw: Submission): Promise<Receipt> {
    requireRole(principal,'worker');
    const input = SubmissionSchema.parse(raw);
    if (submissionHash(input) !== input.payload_hash) throw new StoreError('CONFLICT','Submission hash does not match its content');
    return this.tx(async client => {
      const row = await this.planRow(client,principal,input.plan_id,true);
      const previous = await client.query('SELECT receipt,payload_hash FROM m1.receipts WHERE workspace_id=$1 AND submission_id=$2',[principal.workspace_id,input.submission_id]);
      if (previous.rowCount) {
        if (previous.rows[0]!.payload_hash !== input.payload_hash) throw new StoreError('CONFLICT','Submission identity has different content');
        return previous.rows[0]!.receipt as Receipt;
      }
      if (row.execution_epoch !== input.execution_epoch) throw new StoreError('STALE_EXECUTION','Execution generation no longer owns writes');
      if (terminal(row.status)) throw new StoreError('PLAN_TERMINAL','Plan no longer accepts new results');
      if (new Date(row.deadline_at).getTime() <= Date.now()) throw new StoreError('BUDGET_EXHAUSTED','Plan deadline reached');
      if (row.input_hash !== input.input_hash) throw new StoreError('INPUT_MISMATCH','Frozen input differs');
      if (!(row.required_domains as string[]).includes(input.domain)) throw new StoreError('DOMAIN_NOT_REQUIRED','Domain is not required by this plan');
      const frozen = row.frozen_input as FrozenInput;
      if (input.domain === 'AGENT') throw new StoreError('DEPENDENCY_NOT_IMPLEMENTED','Real Agent is not connected in M1');
      const proof = (await client.query('SELECT state FROM m1.domains WHERE plan_id=$1 AND domain=$2',[input.plan_id,input.domain])).rows[0]!;
      if (proof.state === 'APPLIED') throw new StoreError('CONFLICT','Domain already sealed; replay the original submission');
      const receiptCount = await client.query('SELECT count(*)::int AS count FROM m1.receipts WHERE plan_id=$1',[input.plan_id]);
      if (receiptCount.rows[0]!.count >= 300) throw new StoreError('BUDGET_EXHAUSTED','Submission budget exhausted');
      if (input.domain === 'ABOUT') {
        if (input.payload.channel_id !== row.channel_id || contentHash(input.payload) !== contentHash(frozen.sample.about)) throw new StoreError('TARGET_MISMATCH','Result does not match the frozen fixture target');
        await client.query(`UPDATE m1.channels SET about=$3,about_revision=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND channel_id=$2 AND about_revision <= $4`,[principal.workspace_id,row.channel_id,input.payload,row.source_revision]);
        await client.query('INSERT INTO m1.plan_items(plan_id,domain,item_id,submission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[input.plan_id,input.domain,row.channel_id,input.submission_id]);
      } else {
        if (new Set(input.payload.map(v => v.source_content_id)).size !== input.payload.length) throw new StoreError('TARGET_MISMATCH','Duplicate video identities');
        for (const video of input.payload) {
          const expected = frozen.sample.videos.find(v => v.source_content_id === video.source_content_id);
          if (!expected || video.channel_id !== row.channel_id || !frozen.target_video_ids.includes(video.source_content_id) || contentHash(video) !== contentHash(expected)) throw new StoreError('TARGET_MISMATCH','Video is outside the frozen fixture');
          await client.query(`INSERT INTO m1.videos(workspace_id,channel_id,video_id,source_revision,data) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(workspace_id,channel_id,video_id) DO UPDATE SET data=EXCLUDED.data,source_revision=EXCLUDED.source_revision,updated_at=clock_timestamp()
            WHERE m1.videos.source_revision <= EXCLUDED.source_revision`,[principal.workspace_id,row.channel_id,video.source_content_id,row.source_revision,video]);
          await client.query('INSERT INTO m1.plan_items(plan_id,domain,item_id,submission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[input.plan_id,input.domain,video.source_content_id,input.submission_id]);
        }
      }
      if (input.domain_complete) {
        const items = await client.query('SELECT item_id FROM m1.plan_items WHERE plan_id=$1 AND domain=$2',[input.plan_id,input.domain]);
        const applied = new Set(items.rows.map(r => r.item_id));
        const expected = input.domain === 'ABOUT' ? [row.channel_id as string] : frozen.target_video_ids;
        if (expected.some(id => !applied.has(id))) throw new StoreError('DOMAIN_INCOMPLETE','Required frozen targets are missing');
        await client.query("UPDATE m1.domains SET state='APPLIED',completed_at=clock_timestamp() WHERE plan_id=$1 AND domain=$2",[input.plan_id,input.domain]);
      }
      const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0]!.now as Date;
      const receipt: Receipt = {schema_version:CONTRACT_VERSION,submission_id:input.submission_id,plan_id:input.plan_id,logical_batch_key:input.logical_batch_key,domain:input.domain,payload_hash:input.payload_hash,state:'APPLIED',applied_at:iso(now)};
      await client.query('INSERT INTO m1.receipts(workspace_id,submission_id,plan_id,domain,logical_batch_key,payload_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',[principal.workspace_id,input.submission_id,input.plan_id,input.domain,input.logical_batch_key,input.payload_hash,receipt]);
      const remaining = await client.query("SELECT domain FROM m1.domains WHERE plan_id=$1 AND state <> 'APPLIED'",[input.plan_id]);
      const completed = remaining.rowCount === 0;
      const waiting = remaining.rows.every(r => r.domain === 'AGENT');
      await client.query('UPDATE m1.plans SET status=$2,version=version+1,updated_at=clock_timestamp(),finished_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE plan_id=$1',[input.plan_id,completed ? 'COMPLETED' : waiting ? 'WAITING' : 'RUNNING',completed]);
      if (completed) await client.query("INSERT INTO m1.obligations(plan_id,kind) VALUES($1,'FIXTURE_PLAN_SETTLED') ON CONFLICT DO NOTHING",[input.plan_id]);
      return receipt;
    });
  }
  async cancel(principal: Principal, planId: string, raw: {command_id:string;expected_version:number}): Promise<Plan> {
    requireRole(principal,'operator');
    const command = CancelPlanSchema.parse(raw);
    const hash = contentHash({plan_id:planId,...command});
    return this.tx(async client => {
      const row = await this.planRow(client,principal,planId,true);
      const previous = await client.query('SELECT command_hash,result FROM m1.commands WHERE workspace_id=$1 AND command_id=$2',[principal.workspace_id,command.command_id]);
      if (previous.rowCount) {
        if (previous.rows[0]!.command_hash !== hash) throw new StoreError('CONFLICT','Command identity has different input');
        return previous.rows[0]!.result as Plan;
      }
      if (row.version !== command.expected_version) throw new StoreError('CONFLICT','Plan version changed; refresh before cancelling');
      if (terminal(row.status)) throw new StoreError('PLAN_TERMINAL','Plan has already ended');
      const result = await client.query("UPDATE m1.plans SET status='CANCELLED',version=version+1,execution_epoch=execution_epoch+1,updated_at=clock_timestamp(),finished_at=clock_timestamp() WHERE plan_id=$1 RETURNING *",[planId]);
      const plan = toPlan(result.rows[0]!);
      await client.query('INSERT INTO m1.commands(workspace_id,command_id,plan_id,command_hash,result) VALUES($1,$2,$3,$4,$5)',[principal.workspace_id,command.command_id,planId,hash,plan]);
      await client.query("UPDATE m1.intents SET state='SKIPPED' WHERE plan_id=$1 AND kind='START' AND state='PENDING'",[planId]);
      await client.query("INSERT INTO m1.intents(intent_id,plan_id,kind) VALUES($1,$2,'CANCEL') ON CONFLICT DO NOTHING",[randomUUID(),planId]);
      return plan;
    });
  }
  async heartbeat(principal: Principal, raw: Heartbeat): Promise<Worker> {
    requireRole(principal,'worker');
    const input = HeartbeatSchema.parse(raw);
    if (input.worker_id !== principal.subject) throw new StoreError('FORBIDDEN','Worker identity differs from credential',403);
    const ids=[...new Set(input.running_plan_ids)];
    const owned=await this.pool.query('SELECT plan_id FROM m1.plans WHERE workspace_id=$1 AND plan_id=ANY($2::uuid[])',[principal.workspace_id,ids]);
    if (owned.rowCount!==ids.length) throw new StoreError('NOT_FOUND','Running plan not found',404);
    const result = await this.pool.query(`INSERT INTO m1.workers(workspace_id,worker_id,heartbeat) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id,worker_id) DO UPDATE SET heartbeat=EXCLUDED.heartbeat,last_heartbeat_at=clock_timestamp() RETURNING last_heartbeat_at`,[principal.workspace_id,input.worker_id,input]);
    return {...input,last_heartbeat_at:iso(result.rows[0]!.last_heartbeat_at),stale:false,proxy_status:'NOT_CONFIGURED'};
  }
  async event(principal: Principal, planId: string, raw: ExecutionEvent): Promise<{accepted:true}> {
    requireRole(principal,'worker');
    const input = ExecutionEventSchema.parse(raw);
    if (input.worker_id !== principal.subject) throw new StoreError('FORBIDDEN','Worker identity differs from credential',403);
    return this.tx(async client => {
      const row = await this.planRow(client,principal,planId,true);
      const hash = contentHash(input);
      const old = await client.query('SELECT event_hash FROM m1.events WHERE plan_id=$1 AND event_id=$2',[planId,input.event_id]);
      if (old.rowCount) {
        if (old.rows[0]!.event_hash !== hash) throw new StoreError('CONFLICT','Event identity has different content');
        return {accepted:true};
      }
      if (row.execution_epoch !== input.execution_epoch) throw new StoreError('STALE_EXECUTION','Execution generation is stale');
      const count = await client.query('SELECT count(*)::int AS n FROM m1.events WHERE plan_id=$1',[planId]);
      if (count.rows[0]!.n >= 1000) throw new StoreError('BUDGET_EXHAUSTED','Plan diagnostic event budget exhausted');
      await client.query('INSERT INTO m1.events(plan_id,event_id,event_hash,data) VALUES($1,$2,$3,$4)',[planId,input.event_id,hash,input]);
      if (!terminal(row.status) && input.kind === 'FAILED') {
        await client.query("UPDATE m1.plans SET status='FAILED',version=version+1,execution_epoch=execution_epoch+1,updated_at=clock_timestamp(),finished_at=clock_timestamp() WHERE plan_id=$1",[planId]);
        await client.query("INSERT INTO m1.intents(intent_id,plan_id,kind) VALUES($1,$2,'CANCEL') ON CONFLICT DO NOTHING",[randomUUID(),planId]);
      }
      if (!terminal(row.status) && ['STARTED','WAITING'].includes(input.kind)) {
        const status = input.kind === 'WAITING' ? 'WAITING' : 'RUNNING';
        await client.query('UPDATE m1.plans SET status=$2,version=version+1,updated_at=clock_timestamp() WHERE plan_id=$1 AND status<>$2',[planId,status]);
      }
      return {accepted:true};
    });
  }
  async listWorkers(principal: Principal, limit=20, offset=0): Promise<Page<Worker>> {
    requireRole(principal,'reader','operator');
    const rows = await this.pool.query("SELECT *,last_heartbeat_at < clock_timestamp()-($2 * interval '1 second') AS stale FROM m1.workers WHERE workspace_id=$1 ORDER BY worker_id LIMIT $3 OFFSET $4",[principal.workspace_id,WORKER_STALE_SECONDS,limit+1,offset]);
    return page(rows.rows.map(r => ({...r.heartbeat,last_heartbeat_at:iso(r.last_heartbeat_at),stale:r.stale,proxy_status:'NOT_CONFIGURED'} as Worker)),limit,offset);
  }
  async listErrors(principal: Principal, limit=20, offset=0): Promise<Page<StoredEvent>> {
    requireRole(principal,'reader','operator');
    const rows = await this.pool.query("SELECT e.* FROM m1.events e JOIN m1.plans p USING(plan_id) WHERE p.workspace_id=$1 AND e.data->>'kind' IN ('ERROR','FAILED') ORDER BY e.created_at DESC,e.event_id LIMIT $2 OFFSET $3",[principal.workspace_id,limit+1,offset]);
    return page(rows.rows.map(r => ({...r.data,plan_id:r.plan_id,created_at:iso(r.created_at)} as StoredEvent)),limit,offset);
  }
  async listChannels(principal: Principal, limit=20, offset=0): Promise<Page<ChannelSummary>> {
    requireRole(principal,'reader','operator');
    const rows = await this.pool.query('SELECT * FROM m1.channels WHERE workspace_id=$1 ORDER BY updated_at DESC,channel_id LIMIT $2 OFFSET $3',[principal.workspace_id,limit+1,offset]);
    return page(rows.rows.map(r => ({channel_id:r.channel_id,title:r.about?.title ?? null,source_mode:'fixture',updated_at:iso(r.updated_at),latest_plan_id:r.latest_plan_id})),limit,offset);
  }
  async getChannel(principal: Principal, channelId: string): Promise<ChannelDetail> {
    requireRole(principal,'reader','operator');
    const row = (await this.pool.query('SELECT * FROM m1.channels WHERE workspace_id=$1 AND channel_id=$2',[principal.workspace_id,channelId])).rows[0];
    if (!row) throw new StoreError('NOT_FOUND','Channel not found',404);
    const videos = await this.pool.query('SELECT data FROM m1.videos WHERE workspace_id=$1 AND channel_id=$2 ORDER BY video_id LIMIT 100',[principal.workspace_id,channelId]);
    const latest = toPlan(await this.planRow(this.pool,principal,row.latest_plan_id));
    return {channel_id:channelId,title:row.about?.title ?? null,source_mode:'fixture',updated_at:iso(row.updated_at),latest_plan_id:row.latest_plan_id,about:row.about,videos:videos.rows.map(r=>r.data),agent:null,latest_plan:latest};
  }
  async claimIntent(leaseSeconds=30, workspaceId?:string): Promise<Intent | null> {
    return this.tx(async client => {
      const token = randomUUID();
      const rows = await client.query(`WITH candidate AS (
        SELECT i.intent_id FROM m1.intents i WHERE ((i.state='PENDING' AND i.available_at<=clock_timestamp()) OR (i.state='LEASED' AND i.lease_until<clock_timestamp()))
        AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM m1.plans p WHERE p.plan_id=i.plan_id AND p.workspace_id=$3))
        AND (i.kind='START' OR NOT EXISTS (SELECT 1 FROM m1.intents s WHERE s.plan_id=i.plan_id AND s.kind='START' AND s.state IN ('PENDING','LEASED')))
        ORDER BY i.created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE m1.intents i SET state='LEASED',lease_token=$1,lease_until=clock_timestamp()+($2*interval '1 second'),attempts=attempts+1
        FROM candidate c WHERE i.intent_id=c.intent_id RETURNING i.*`,[token,leaseSeconds,workspaceId ?? null]);
      if (!rows.rowCount) return null;
      const intent = rows.rows[0]!;
      const row = (await client.query('SELECT * FROM m1.plans WHERE plan_id=$1',[intent.plan_id])).rows[0]!;
      return {intent_id:intent.intent_id,plan_id:intent.plan_id,kind:intent.kind,lease_token:token,attempts:intent.attempts,plan_status:row.status,deadline_at:iso(row.deadline_at),
        input:{schema_version:CONTRACT_VERSION,plan_id:row.plan_id,workspace_id:row.workspace_id,execution_epoch:row.execution_epoch,input_hash:row.input_hash,workflow_id:row.workflow_id}};
    });
  }
  async finishIntent(intent: Intent, state: 'DONE'|'SKIPPED', workflowRunId: string|null=null): Promise<void> {
    await this.pool.query('UPDATE m1.intents SET state=$3,workflow_run_id=$4,lease_until=NULL WHERE intent_id=$1 AND lease_token=$2 AND state=\'LEASED\'',[intent.intent_id,intent.lease_token,state,workflowRunId]);
  }
  async retryIntent(intent: Intent, message: string): Promise<void> {
    await this.pool.query("UPDATE m1.intents SET state='PENDING',available_at=clock_timestamp()+($3*interval '1 second'),last_error=$4,lease_until=NULL WHERE intent_id=$1 AND lease_token=$2 AND state='LEASED'",[intent.intent_id,intent.lease_token,Math.min(60,2 ** Math.min(intent.attempts,6)),message.slice(0,500)]);
  }
  async expirePlans(limit=20, workspaceId?:string): Promise<number> {
    return this.tx(async client => {
      const rows = await client.query("SELECT * FROM m1.plans WHERE status IN ('QUEUED','RUNNING','WAITING') AND deadline_at<=clock_timestamp() AND ($2::text IS NULL OR workspace_id=$2) ORDER BY deadline_at FOR UPDATE SKIP LOCKED LIMIT $1",[limit,workspaceId ?? null]);
      for (const row of rows.rows) {
        const event: ExecutionEvent = {event_id:randomUUID(),execution_epoch:row.execution_epoch,worker_id:'control-dispatcher',phase:'PLAN_DEADLINE',kind:'FAILED',domain:null,message:'Frozen plan deadline exhausted',error_code:'BUDGET_EXHAUSTED'};
        await client.query('INSERT INTO m1.events(plan_id,event_id,event_hash,data) VALUES($1,$2,$3,$4)',[row.plan_id,event.event_id,contentHash(event),event]);
        await client.query("UPDATE m1.plans SET status='FAILED',version=version+1,execution_epoch=execution_epoch+1,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE plan_id=$1",[row.plan_id]);
        await client.query("UPDATE m1.intents SET state='SKIPPED' WHERE plan_id=$1 AND kind='START' AND state='PENDING'",[row.plan_id]);
        await client.query("INSERT INTO m1.intents(intent_id,plan_id,kind) VALUES($1,$2,'CANCEL') ON CONFLICT DO NOTHING",[randomUUID(),row.plan_id]);
      }
      return rows.rowCount ?? 0;
    });
  }
  async businessMetrics(workspaceId:string):Promise<Array<{metric:string;state:string;value:number}>> {
    const result=await this.pool.query(`
      SELECT 'plans' AS metric,status AS state,count(*)::float8 AS value FROM m1.plans WHERE workspace_id=$1 GROUP BY status
      UNION ALL SELECT 'domains',d.domain||'_'||d.state,count(*)::float8 FROM m1.domains d JOIN m1.plans p USING(plan_id) WHERE p.workspace_id=$1 GROUP BY d.domain,d.state
      UNION ALL SELECT 'intents',i.kind||'_'||i.state,count(*)::float8 FROM m1.intents i JOIN m1.plans p USING(plan_id) WHERE p.workspace_id=$1 GROUP BY i.kind,i.state
      UNION ALL SELECT 'receipts','APPLIED',count(*)::float8 FROM m1.receipts WHERE workspace_id=$1
      UNION ALL SELECT 'workers',CASE WHEN last_heartbeat_at<clock_timestamp()-interval '90 seconds' THEN 'STALE' ELSE 'FRESH' END,count(*)::float8 FROM m1.workers WHERE workspace_id=$1 GROUP BY 2
      UNION ALL SELECT 'oldest_intent_seconds','PENDING',coalesce(extract(epoch FROM clock_timestamp()-min(i.created_at)),0)::float8 FROM m1.intents i JOIN m1.plans p USING(plan_id) WHERE p.workspace_id=$1 AND i.state IN ('PENDING','LEASED')`,[workspaceId]);
    return result.rows as Array<{metric:string;state:string;value:number}>;
  }
}
