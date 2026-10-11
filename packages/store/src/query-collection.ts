import type {Pool,PoolClient} from 'pg';
import {QueryCollectionSummarySchema,QuerySourcesSchema} from '../../contracts/src/query-collection.ts';
import type {QueryCollectionLimits} from '../../contracts/src/configuration.ts';
import {extractQueries} from './query-extraction.ts';
import {DiscoveryError,upsertBindings} from './discovery.ts';

const CANDIDATE_LIMIT=20000;
const ref=(channel:string,video:string|null)=>`collected:${channel}:${video??'about'}`;
/** Call inside a short transaction. A workspace lock serialises both growth budgets and support counts. */
export async function collectQueries(client:PoolClient,workspace:string,limits:QueryCollectionLimits,now=new Date()){
  const result={scanned:0,created:0,woken:0};
  if(!limits.enabled)return result;
  if(!(await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) ok",['query-collection:'+workspace])).rows[0].ok)return result;
  const day=now.toISOString().slice(0,10);
  await client.query('DELETE FROM control.query_collection_days WHERE workspace_id=$1 AND day<$2::date-90',[workspace,day]);
  await client.query('INSERT INTO control.query_collection_days(workspace_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING',[workspace,day]);
  const budget=(await client.query('SELECT created,woken FROM control.query_collection_days WHERE workspace_id=$1 AND day=$2 FOR UPDATE',[workspace,day])).rows[0];
  let room=CANDIDATE_LIMIT-(await client.query('SELECT count(*)::int n FROM control.query_collection_candidates WHERE workspace_id=$1',[workspace])).rows[0].n;
  const channels=(await client.query(`SELECT c.channel_id,c.latest_plan_id,d.about,d.agent,
    (SELECT coalesce(jsonb_agg(v),'[]') FROM (SELECT video_id,jsonb_build_object('title',data->'title','keywords',data->'keywords','hashtags',data->'hashtags') data
      FROM crawl_data.videos WHERE workspace_id=c.workspace_id AND channel_id=c.channel_id ORDER BY observed_at DESC NULLS LAST,video_id LIMIT 30) v) videos
    FROM control.channels c JOIN control.plans p ON p.plan_id=c.latest_plan_id AND p.workspace_id=c.workspace_id
    JOIN crawl_data.channels d ON d.workspace_id=c.workspace_id AND d.channel_id=c.channel_id
    LEFT JOIN control.query_collection_scans s ON s.workspace_id=c.workspace_id AND s.channel_id=c.channel_id
    WHERE c.workspace_id=$1 AND c.management_state='managed' AND p.source_mode='youtube' AND p.status='COMPLETED'
      AND d.about IS NOT NULL AND d.agent IS NOT NULL AND s.last_plan_id IS DISTINCT FROM c.latest_plan_id
    ORDER BY s.scanned_at NULLS FIRST,p.finished_at,c.channel_id LIMIT 10`,[workspace])).rows;
  for(const channel of channels){
    const words=extractQueries(channel.about,channel.agent,channel.videos);
    let capacity=false;
    if(words?.length){
      const added=await client.query(`INSERT INTO control.query_collection_candidates(workspace_id,text,country,language,category,created_at,updated_at)
        SELECT $1,r.text,$3,$4,$5,$6,$6 FROM unnest($2::text[]) WITH ORDINALITY r(text,n)
        WHERE NOT EXISTS(SELECT 1 FROM control.query_collection_candidates c WHERE c.workspace_id=$1 AND c.text=r.text AND c.country=$3 AND c.category=$5)
        ORDER BY r.n LIMIT $7 ON CONFLICT DO NOTHING RETURNING candidate_id`,[workspace,words.map(w=>w.text),words[0]!.country,words[0]!.language,words[0]!.category,now,Math.max(0,room)]);
      room-=added.rowCount??0;
      const candidates=(await client.query(`SELECT candidate_id,text FROM control.query_collection_candidates WHERE workspace_id=$1 AND country=$2 AND category=$3 AND text=ANY($4::text[])`,[workspace,words[0]!.country,words[0]!.category,words.map(w=>w.text)])).rows;
      capacity=candidates.length<words.length;
      const ids=new Map<string,string>(candidates.map(c=>[c.text,c.candidate_id]));
      const evidence=words.filter(w=>ids.has(w.text));
      await client.query(`WITH added AS (
        INSERT INTO control.query_collection_evidence(candidate_id,channel_id,source_type,video_id,created_at)
        SELECT r.id,$2,r.type,r.video,$6 FROM unnest($3::uuid[],$4::text[],$5::text[]) r(id,type,video)
        JOIN control.query_collection_candidates c ON c.candidate_id=r.id WHERE c.workspace_id=$1 AND c.support_count<5
        ON CONFLICT DO NOTHING RETURNING candidate_id)
        UPDATE control.query_collection_candidates c SET support_count=support_count+1,updated_at=$6 FROM added a WHERE c.candidate_id=a.candidate_id`,
      [workspace,channel.channel_id,evidence.map(w=>ids.get(w.text)),evidence.map(w=>w.source_type),evidence.map(w=>w.video_id),now]);
    }
    await client.query(`INSERT INTO control.query_collection_scans(workspace_id,channel_id,last_plan_id,outcome,scanned_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(workspace_id,channel_id) DO UPDATE SET last_plan_id=EXCLUDED.last_plan_id,outcome=EXCLUDED.outcome,scanned_at=EXCLUDED.scanned_at`,
    [workspace,channel.channel_id,channel.latest_plan_id,words===null?'unmapped':capacity?'capacity':'collected',now]);
    result.scanned++;
  }
  let daily=Math.max(0,limits.daily_binding_limit-budget.created-budget.woken);
  let total=Math.max(0,limits.max_auto_bindings-(await client.query('SELECT count(*)::int n FROM control.query_collection_candidates WHERE workspace_id=$1 AND auto_created',[workspace])).rows[0].n);
  // Existing bindings can still receive provenance even when new growth is paused.
  const ready=(await client.query(`SELECT c.*,b.binding_id existing_id FROM control.query_collection_candidates c
    LEFT JOIN control.query_terms t ON t.workspace_id=c.workspace_id AND t.text=c.text
    LEFT JOIN control.query_bindings b ON b.workspace_id=c.workspace_id AND b.term_id=t.term_id AND b.country=c.country AND b.category=c.category
    WHERE c.workspace_id=$1 AND c.support_count>c.handled_support_count AND c.support_count>=$2
      AND (b.binding_id IS NOT NULL OR $3::boolean) AND ($4::boolean OR b.state IS DISTINCT FROM 'DORMANT')
      ORDER BY c.updated_at,c.candidate_id LIMIT 10`,[workspace,limits.min_support_channels,daily>0&&total>0,daily>0])).rows;
  for(const candidate of ready){
    if(!candidate.existing_id&&(daily===0||total===0))continue;
    const sources=(await client.query('SELECT channel_id,source_type,video_id FROM control.query_collection_evidence WHERE candidate_id=$1 ORDER BY created_at,channel_id',[candidate.candidate_id])).rows;
    const bound=await upsertBindings(client,workspace,sources.map(s=>({text:candidate.text,country:candidate.country,language:candidate.language,category:candidate.category,
      priority:-10,source_type:s.source_type,source_ref:ref(s.channel_id,s.video_id)})),now);
    const bindingId=bound.bindings[0]!;
    const binding=(await client.query('SELECT state,version,last_success_at FROM control.query_bindings WHERE binding_id=$1 AND workspace_id=$2 FOR UPDATE',[bindingId,workspace])).rows[0];
    // A repeated scan cannot wake a dormant binding: only a previously unhandled distinct channel can.
    if(binding.state==='DORMANT'&&daily>0){
      await client.query(`UPDATE control.query_bindings SET state=CASE WHEN last_success_at IS NULL THEN 'BOOTSTRAP' ELSE 'ACTIVE' END,
        next_run_at=$2,retry_at=NULL,empty_runs=0,version=version+1,updated_at=$2 WHERE binding_id=$1`,[bindingId,now]);
      await client.query(`INSERT INTO control.query_audit(binding_id,version,actor,action,detail) VALUES($1,$2,'query-collector','auto_wake',$3)`,
      [bindingId,binding.version+1,{from_state:'DORMANT',support_channels:candidate.support_count}]);
      result.woken++;daily--;
    }else if(binding.state==='DORMANT')continue; // Preserve unhandled evidence for tomorrow's wake budget.
    if(bound.created){result.created+=bound.created;daily-=bound.created;total-=bound.created;}
    await client.query(`UPDATE control.query_collection_candidates SET binding_id=$2,auto_created=auto_created OR $3,
      handled_support_count=support_count WHERE candidate_id=$1`,[candidate.candidate_id,bindingId,bound.created>0]);
  }
  await client.query('UPDATE control.query_collection_days SET created=created+$3,woken=woken+$4 WHERE workspace_id=$1 AND day=$2',[workspace,day,result.created,result.woken]);
  return result;
}

export async function collectionSummary(db:Pool|PoolClient,workspace:string,limits:QueryCollectionLimits,now=new Date()){
  const c=(await db.query(`SELECT count(*)::int candidates,count(*) FILTER(WHERE auto_created)::int auto_bindings,
    count(*) FILTER(WHERE support_count<$2)::int waiting_support,
    count(*) FILTER(WHERE support_count>=$2 AND support_count>handled_support_count AND binding_id IS NULL)::int waiting_promotion
    FROM control.query_collection_candidates WHERE workspace_id=$1`,[workspace,limits.min_support_channels])).rows[0];
  const d=(await db.query('SELECT created,woken FROM control.query_collection_days WHERE workspace_id=$1 AND day=$2',[workspace,now.toISOString().slice(0,10)])).rows[0]??{created:0,woken:0};
  const s=(await db.query(`SELECT count(*)::int scanned_channels,count(*) FILTER(WHERE outcome<>'collected')::int skipped_channels,max(scanned_at) last_scan_at
    FROM control.query_collection_scans WHERE workspace_id=$1`,[workspace])).rows[0];
  return QueryCollectionSummarySchema.parse({observed_at:now.toISOString(),limits,...c,created_today:d.created,woken_today:d.woken,...s,
    last_scan_at:s.last_scan_at?new Date(s.last_scan_at).toISOString():null,candidate_limit:CANDIDATE_LIMIT,
    limited:!limits.enabled?'disabled':d.created+d.woken>=limits.daily_binding_limit?'daily':c.auto_bindings>=limits.max_auto_bindings?'total':c.candidates>=CANDIDATE_LIMIT?'candidates':null});
}
export async function querySources(db:Pool,workspace:string,bindingId:string,limit=100,offset=0){
  if(!(await db.query('SELECT 1 FROM control.query_bindings WHERE workspace_id=$1 AND binding_id=$2',[workspace,bindingId])).rowCount)throw new DiscoveryError('NOT_FOUND','Query not found');
  const rows=(await db.query(`SELECT source_type type,source_ref ref,created_at FROM control.query_sources WHERE binding_id=$1 ORDER BY created_at,source_type,source_ref LIMIT $2 OFFSET $3`,[bindingId,limit+1,offset])).rows;
  return QuerySourcesSchema.parse({items:rows.slice(0,limit).map(r=>{
    const match=/^collected:(UC[A-Za-z0-9_-]{22}):(about|[A-Za-z0-9_-]{11})$/.exec(r.ref);
    return {...r,created_at:new Date(r.created_at).toISOString(),channel_id:match?.[1]??null,video_id:match&&match[2]!=='about'?match[2]:null};
  }),next_cursor:rows.length>limit?String(offset+limit):null});
}
