import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';

// These names come from the historical integration/acceptance entry points.
// A prefix alone is insufficient: the complete UUID (or recorded legacy ID) must match.
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const historical=new RegExp(`^(?:test(?:-(?:cand|runs|clock|import|incremental|ops|updates|yt|proxy|query|query-timing))?|overview|auth-test|main-browser|main-joint)-${uuid}$`);
const legacy=new Set(['m1-execution-20260924','probe-sources-20260924']);
export const isHistoricalTestWorkspace=(s:string)=>historical.test(s)||legacy.has(s);
const fixture='fixture:channel:basic';
const names=[
 'channel_candidates','channel_clocks','channel_feature_state','channel_imports','channels','commands','console_sessions',
 'data_api_budget','data_api_permits','domains','event_archive_identities','events','failure_commands','failure_replays','failure_reports','failures',
 'feature_reference_distributions','intents','obligations','pipeline_steps','plan_api_reservations','plan_items','plan_qualifications',
 'plan_sampling_baselines','plan_video_samples','plan_video_targets','plans','proxies','proxy_availability_hourly','proxy_daily',
 'proxy_observation_streams','proxy_observations','proxy_sources','query_audit','query_bindings','query_collection_candidates',
 'query_collection_days','query_collection_evidence','query_collection_scans','query_run_channels','query_run_pages','query_runs',
 'query_sources','query_terms','receipts','runtime_settings','runtime_settings_consumers','runtime_settings_history',
 'update_scheduler_state','video_refresh_state','worker_commands','worker_plans','worker_routing','worker_samples','workers',
].map(n=>'control.'+n);
const allowed=new Set([...names,'crawl_data.channels','crawl_data.videos','crawl_data.ingest_units','telemetry.outbox','telemetry.bootstrap','telemetry.maintenance']);
const fixtureFacts=new Set(['control.channels','control.channel_clocks','control.channel_feature_state','control.video_refresh_state','crawl_data.channels','crawl_data.videos']);
type Table={name:string;columns:string[];predicate:string};
type Edge={child:string;parent:string;child_columns:string[];parent_columns:string[]};
export type Selection={workspaces:string[];fixture_facts:boolean};
export type Inventory={table:string;rows:number;digest:string|null};
const q=(name:string)=>name.split('.').map(s=>{assert.match(s,/^[a-z_]+$/);return '"'+s+'"';}).join('.');
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function layout(db:PoolClient,selection:Selection){
 assert.equal(new Set(selection.workspaces).size,selection.workspaces.length);
 assert.ok(selection.workspaces.every(isHistoricalTestWorkspace),'Only recorded historical test namespaces can be retired');
 const catalog=(await db.query<{name:string;columns:string[]}>(`SELECT c.table_schema||'.'||c.table_name name,array_agg(c.column_name::text ORDER BY c.ordinal_position) columns
 FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name)
 WHERE t.table_type='BASE TABLE' AND c.table_schema IN ('control','crawl_data','telemetry','delivery') GROUP BY 1 ORDER BY 1`)).rows;
 const tables:Table[]=catalog.map(t=>{
  let predicate='false AND cardinality($1::text[])>=0';
  if(t.columns.includes('workspace_id'))predicate='t.workspace_id=ANY($1::text[])';
  else if(t.columns.includes('plan_id'))predicate='t.plan_id IN (SELECT plan_id FROM control.plans WHERE workspace_id=ANY($1::text[]))';
  else if(t.columns.includes('binding_id'))predicate='t.binding_id IN (SELECT binding_id FROM control.query_bindings WHERE workspace_id=ANY($1::text[]))';
  else if(t.columns.includes('run_id'))predicate='t.run_id IN (SELECT run_id FROM control.query_runs WHERE workspace_id=ANY($1::text[]))';
  else if(t.columns.includes('candidate_id'))predicate='t.candidate_id IN (SELECT candidate_id FROM control.query_collection_candidates WHERE workspace_id=ANY($1::text[]))';
  if(selection.fixture_facts&&fixtureFacts.has(t.name))predicate=`(${predicate}) OR (t.workspace_id='m1-main' AND t.channel_id='${fixture}')`;
  return {...t,predicate};
 });
 const edges=(await db.query<Edge>(`SELECT conrelid::regclass::text child,confrelid::regclass::text parent,
 ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) child_columns,
 ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) parent_columns
 FROM pg_constraint c WHERE contype='f' AND connamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('control','crawl_data','telemetry','delivery')) ORDER BY 1,2`)).rows;
 return {tables,edges};
}

/** Requires a caller-owned transaction. No credentials or row bodies leave this module. */
export async function inventory(db:PoolClient,selection:Selection):Promise<Inventory[]>{
 const {tables}=await layout(db,selection);const result:Inventory[]=[];
 for(const t of tables){
  const r=(await db.query<{rows:number;digest:string|null}>(`SELECT count(*)::int rows,md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text))) digest FROM ${q(t.name)} t WHERE ${t.predicate}`,[selection.workspaces])).rows[0]!;
  assert.ok(!r.rows||allowed.has(t.name),'Unexpected table contains test records: '+t.name);
  if(allowed.has(t.name))result.push({table:t.name,...r});
 }
 return result;
}
export const inventoryHash=(rows:Inventory[])=>sha(rows);

/** Protect live execution, credentials, deliveries and every foreign-key edge across the boundary. */
export async function assertRetired(db:PoolClient,selection:Selection){
 const spaces=selection.workspaces;
 const checks=[
  ["SELECT count(*)::int n FROM control.workers WHERE workspace_id=ANY($1::text[]) AND last_heartbeat_at>clock_timestamp()-interval '24 hours'",'Recent worker heartbeat'],
  ["SELECT count(*)::int n FROM control.plans WHERE workspace_id=ANY($1::text[]) AND (deadline_at>clock_timestamp() OR updated_at>clock_timestamp()-interval '24 hours')",'Recent or unexpired plan'],
  ["SELECT count(*)::int n FROM control.intents i JOIN control.plans p USING(plan_id) WHERE p.workspace_id=ANY($1::text[]) AND i.lease_until>clock_timestamp()",'Live dispatch lease'],
  ["SELECT count(*)::int n FROM control.query_runs WHERE workspace_id=ANY($1::text[]) AND (lease_expires_at>clock_timestamp() OR created_at>clock_timestamp()-interval '24 hours')",'Recent or leased search'],
  ["SELECT count(*)::int n FROM control.console_sessions WHERE workspace_id=ANY($1::text[]) AND expires_at>clock_timestamp()",'Active test session'],
  ['SELECT count(*)::int n FROM delivery.records WHERE workspace_id=ANY($1::text[])','Published test data'],
  ["SELECT count(*)::int n FROM control.failures WHERE workspace_id=ANY($1::text[]) AND (state IN ('OPEN','RETRYING') OR evidence_state='PENDING')",'Failure awaiting recovery'],
  ["SELECT count(*)::int n FROM control.failure_replays WHERE workspace_id=ANY($1::text[]) AND state IN ('PENDING','LEASED')",'Pending failure replay'],
  ["SELECT count(*)::int n FROM telemetry.outbox WHERE workspace_id=ANY($1::text[]) AND archived_at IS NULL",'Unarchived observation'],
 ] as const;
 for(const [sql,label] of checks)assert.equal((await db.query(sql,[spaces])).rows[0].n,0,label);
 if(selection.fixture_facts){
  assert.ok((await db.query("SELECT 1 FROM control.plans WHERE workspace_id='m1-main' AND channel_id=$1 AND source_mode='fixture'",[fixture])).rowCount,'Missing fixed-fixture provenance');
  assert.equal((await db.query(`SELECT count(*)::int n FROM control.plans WHERE workspace_id='m1-main' AND channel_id=$1 AND
   (source_mode<>'fixture' OR status IN ('QUEUED','RUNNING','WAITING'))`,[fixture])).rows[0].n,0,'Fixture identity has a live/real plan');
  assert.equal((await db.query("SELECT count(*)::int n FROM delivery.records WHERE workspace_id='m1-main' AND channel_id=$1",[fixture])).rows[0].n,0,'Fixture was published');
  assert.equal((await db.query("SELECT count(*)::int n FROM control.failures WHERE workspace_id='m1-main' AND channel_id=$1 AND state IN ('OPEN','RETRYING')",[fixture])).rows[0].n,0,'Fixture needs recovery');
  assert.equal((await db.query("SELECT count(*)::int n FROM telemetry.outbox WHERE workspace_id='m1-main' AND event->>'channel_id'=$1 AND archived_at IS NULL",[fixture])).rows[0].n,0,'Fixture observation unarchived');
 }
 const {tables,edges}=await layout(db,selection),byName=new Map(tables.map(t=>[t.name,t]));
 for(const edge of edges){
  const parent=byName.get(edge.parent),child=byName.get(edge.child);if(!parent||!child)continue;
  const join=edge.child_columns.map((col,i)=>`c.${q(col)}=t.${q(edge.parent_columns[i]!)}`).join(' AND ');
  const selectedChild=allowed.has(child.name)?child.predicate.replaceAll('t.','c.'):'false';
  const n=(await db.query(`SELECT count(*)::int n FROM ${q(parent.name)} t JOIN ${q(child.name)} c ON ${join} WHERE (${parent.predicate}) AND NOT (${selectedChild})`,[spaces])).rows[0].n;
  assert.equal(n,0,'Reference crosses cleanup boundary: '+edge.child+' → '+edge.parent);
 }
}

export async function cleanup(db:PoolClient,selection:Selection,expectedHash:string,onProgress:(table:string)=>void=()=>{}){
 // Recheck exact row contents after locks; a new row or status change invalidates the manifest.
 const initial=await layout(db,selection);
 for(const t of initial.tables.filter(t=>allowed.has(t.name))){onProgress('lock:'+t.name);await db.query(`SELECT 1 FROM ${q(t.name)} t WHERE ${t.predicate} FOR UPDATE`,[selection.workspaces]);}
 onProgress('guards');
 await assertRetired(db,selection);
 const before=await inventory(db,selection);assert.equal(inventoryHash(before),expectedHash,'Cleanup manifest is stale');
 const retired_plans=(await db.query("UPDATE control.plans SET status='CANCELLED',version=version+1,finished_at=coalesce(finished_at,clock_timestamp()),updated_at=clock_timestamp() WHERE workspace_id=ANY($1::text[]) AND status IN ('QUEUED','RUNNING','WAITING')",[selection.workspaces])).rowCount??0;
 const settled_intents=(await db.query("UPDATE control.intents i SET state='SKIPPED',lease_until=NULL,lease_token=NULL FROM control.plans p WHERE i.plan_id=p.plan_id AND p.workspace_id=ANY($1::text[]) AND i.state IN ('PENDING','LEASED')",[selection.workspaces])).rowCount??0;
 const cancelled_searches=(await db.query("UPDATE control.query_runs SET state='CANCELLED',finished_at=coalesce(finished_at,clock_timestamp()),lease_expires_at=NULL,retry_at=NULL WHERE workspace_id=ANY($1::text[]) AND state IN ('PENDING','RUNNING')",[selection.workspaces])).rowCount??0;
 const {tables,edges}=await layout(db,selection),pending=new Map(tables.filter(t=>allowed.has(t.name)).map(t=>[t.name,t])),removed:Record<string,number>={};
 while(pending.size){
  const next=[...pending.values()].find(t=>!edges.some(e=>e.parent===t.name&&pending.has(e.child)));
  assert.ok(next,'Unexpected cyclic foreign keys');
  onProgress('delete:'+next.name);
  removed[next.name]=(await db.query(`DELETE FROM ${q(next.name)} t WHERE ${next.predicate}`,[selection.workspaces])).rowCount??0;pending.delete(next.name);
 }
 const after=await inventory(db,selection);assert.ok(after.every(t=>t.rows===0),'Cleanup left selected records');
 return {before,removed,retired_plans,settled_intents,cancelled_searches,total_removed:Object.values(removed).reduce((a,n)=>a+n,0)};
}
