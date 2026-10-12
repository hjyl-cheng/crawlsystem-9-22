import type {Pool} from 'pg';
import {BUSINESS_CATEGORIES,CLOCK_NAMES,ChannelFilterOptionsSchema,ChannelListFiltersSchema,type ChannelListItem,type ChannelListFilters,type Page,type SourceMode} from '@crawlsystem/contracts';

// Both the list and its counts use the same facts, clocks and latest Agent task.
// LIMIT is applied after all filters, so matches are not restricted to the visible page.
const channels=`WITH channels AS MATERIALIZED (
 SELECT c.workspace_id,c.channel_id,c.updated_at,c.latest_plan_id,c.management_state,p.source_mode,p.status AS latest_plan_status,
  c.about->>'title' AS title,c.about->>'handle' AS handle,c.about->>'country' AS country,
  coalesce(nullif(c.about->>'country_code',''),nullif(c.about->>'country',''),'__missing') AS country_key,
  CASE WHEN jsonb_typeof(c.about#>'{subscriber_count,value}')='number' THEN (c.about#>>'{subscriber_count,value}')::bigint END AS subscriber_count,
  CASE WHEN (c.agent#>>'{facts,channel_categories,value,level_1}')=ANY($4::text[]) THEN c.agent#>>'{facts,channel_categories,value,level_1}' END AS category,
  k.next_due_at,
  CASE WHEN a.state='APPLIED' THEN 'completed'
   WHEN a.plan_id IS NULL THEN CASE WHEN c.agent IS NOT NULL THEN 'completed' ELSE 'not_scheduled' END
   WHEN a.status IN ('FAILED','CANCELLED','COMPLETED') THEN 'failed'
   WHEN a.waiting THEN 'waiting' ELSE 'running' END AS agent_state
 FROM control.channel_overview c JOIN control.plans p ON p.plan_id=c.latest_plan_id AND p.workspace_id=c.workspace_id
 LEFT JOIN LATERAL (SELECT min(coalesce(retry_at,due_at)) AS next_due_at FROM control.channel_clocks
  WHERE workspace_id=c.workspace_id AND channel_id=c.channel_id AND clock=ANY($3::text[])) k ON true
 LEFT JOIN LATERAL (SELECT ap.plan_id,ap.status,d.state,
   EXISTS(SELECT 1 FROM control.domains x WHERE x.plan_id=ap.plan_id AND x.domain IN ('ABOUT','VIDEO') AND x.state<>'APPLIED') AS waiting
  FROM control.plans ap JOIN control.domains d ON d.plan_id=ap.plan_id AND d.domain='AGENT'
  WHERE ap.workspace_id=c.workspace_id AND ap.channel_id=c.channel_id AND ap.source_mode=$2
  ORDER BY ap.source_revision DESC LIMIT 1) a ON true
 WHERE c.workspace_id=$1 AND p.source_mode=$2
)`;
const filters=`($5::text IS NULL OR channel_id ILIKE $5 ESCAPE '\\' OR coalesce(title,'') ILIKE $5 ESCAPE '\\' OR coalesce(handle,'') ILIKE $5 ESCAPE '\\')
 AND ($6::text IS NULL OR country_key=$6)
 AND ($7::text IS NULL OR coalesce(category,'__missing')=$7)
 AND ($8::text IS NULL OR coalesce(management_state,'unmanaged')=$8)
 AND ($9::text IS NULL OR agent_state=$9)`;
const overdue=`management_state='managed' AND next_due_at<=statement_timestamp()`;
const ok=`management_state='managed' AND (next_due_at IS NULL OR next_due_at>statement_timestamp())`;
function parameters(workspace:string,mode:SourceMode,raw:ChannelListFilters){
 const f=ChannelListFiltersSchema.parse(raw),search=f.search?.replace(/[\\%_]/g,'\\$&');
 return {f,values:[workspace,mode,CLOCK_NAMES,BUSINESS_CATEGORIES,search?'%'+search+'%':null,f.country??null,f.category??null,f.management_state??null,f.agent_state??null]};
}
export async function readChannelList(pool:Pool,workspace:string,limit:number,offset:number,mode:SourceMode,filter:ChannelListFilters,includeDetails=false):Promise<Page<ChannelListItem>>{
 const {f,values}=parameters(workspace,mode,filter);
 const result=await pool.query(`${channels}, matched AS (
  SELECT * FROM channels WHERE ${filters} AND ($10::text IS NULL
   OR ($10='ok' AND ${ok}) OR ($10='overdue' AND ${overdue}) OR ($10='paused' AND management_state='paused'))
  ORDER BY updated_at DESC,channel_id LIMIT $11 OFFSET $12)
 SELECT c.*,
  (SELECT count(*)::int FROM control.videos v WHERE v.workspace_id=c.workspace_id AND v.channel_id=c.channel_id) AS stored_videos,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('clock',clock,'next_due_at',coalesce(retry_at,due_at),'interval_days',interval_days,'retry_at',retry_at,'override_days',override_days)
   ORDER BY array_position($3::text[],clock)),'[]') FROM control.channel_clocks WHERE workspace_id=c.workspace_id AND channel_id=c.channel_id AND clock=ANY($3::text[])) AS clocks
 FROM matched c ORDER BY c.updated_at DESC,c.channel_id`,[...values,f.state??null,limit+1,offset]);
 const iso=(v:Date|string)=>new Date(v).toISOString();
 const items:ChannelListItem[]=result.rows.slice(0,limit).map(r=>({channel_id:r.channel_id,title:r.title,source_mode:r.source_mode,updated_at:iso(r.updated_at),latest_plan_id:r.latest_plan_id,
  country:r.country,subscriber_count:r.subscriber_count===null?null:Number(r.subscriber_count),stored_videos:r.stored_videos,latest_plan_status:r.latest_plan_status,
  management_state:r.management_state??null,...(includeDetails?{category:r.category,agent_state:r.agent_state}:{}),next_due_at:r.management_state==='managed'&&r.next_due_at?iso(r.next_due_at):null,
  clocks:['managed','paused'].includes(r.management_state)?r.clocks.map((k:any)=>({...k,next_due_at:iso(k.next_due_at),retry_at:k.retry_at?iso(k.retry_at):null})):[]}));
 return {items,next_cursor:result.rows.length>limit?String(offset+limit):null};
}
export async function readChannelFilterOptions(pool:Pool,workspace:string,mode:SourceMode,filter:ChannelListFilters){
 const {values}=parameters(workspace,mode,filter);
 const row=(await pool.query(`${channels}, matched AS (SELECT * FROM channels WHERE ${filters}),
 countries AS (SELECT country_key AS value,coalesce(min(country),nullif(country_key,'__missing'),'尚未提供') AS label,count(*)::int AS count FROM channels GROUP BY country_key),
 categories AS (SELECT coalesce(category,'__missing') AS value,count(*)::int AS count FROM channels GROUP BY category)
 SELECT statement_timestamp() AS observed_at,
  jsonb_build_object('all',count(*),'ok',count(*) FILTER(WHERE ${ok}),'overdue',count(*) FILTER(WHERE ${overdue}),'paused',count(*) FILTER(WHERE management_state='paused')) AS counts,
  (SELECT coalesce(jsonb_agg(c ORDER BY c.value),'[]') FROM (SELECT * FROM countries ORDER BY value LIMIT 500) c) AS countries,
  (SELECT coalesce(jsonb_agg(c ORDER BY c.value),'[]') FROM categories c) AS categories
 FROM matched`,values)).rows[0];
 return ChannelFilterOptionsSchema.parse({...row,observed_at:row.observed_at.toISOString()});
}
