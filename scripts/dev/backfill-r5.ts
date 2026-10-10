import {createPool} from '@crawlsystem/store/config';
import {OpsEventSchema} from '@crawlsystem/contracts/analytics';
const pool=createPool(),workspace=process.env.M1_WORKSPACE_ID??'m1-main';
const client=await pool.connect();
try {
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query("SELECT pg_advisory_xact_lock(hashtext('r5-bootstrap:'||$1))",[workspace]);
 const done=(await client.query('SELECT counts FROM telemetry.bootstrap WHERE workspace_id=$1',[workspace])).rows[0];
 if(done){console.log(JSON.stringify({already_completed:true,...done.counts}));}
 else {
  await client.query(`SELECT telemetry.emit(p.workspace_id,'plan:'||p.plan_id||':'||p.version,jsonb_build_object('at',coalesce(p.finished_at,p.updated_at),'source_mode',p.source_mode,
   'kind','PLAN','status',p.status,'plan_id',p.plan_id,'channel_id',p.channel_id,'duration_ms',CASE WHEN p.finished_at IS NULL THEN 0 ELSE greatest(0,extract(epoch FROM p.finished_at-p.created_at)*1000) END)) FROM control.plans p WHERE workspace_id=$1`,[workspace]);
  await client.query(`SELECT telemetry.emit(workspace_id,'plan-created:'||plan_id,jsonb_build_object('at',created_at,'source_mode',source_mode,'kind','PLAN_CREATED','status','QUEUED','plan_id',plan_id,'channel_id',channel_id)) FROM control.plans WHERE workspace_id=$1`,[workspace]);
  await client.query(`SELECT telemetry.emit(p.workspace_id,'event:'||e.plan_id||':'||e.event_id,jsonb_build_object('at',e.created_at,'source_mode',p.source_mode,'kind','EXECUTION','domain',coalesce(e.data->>'domain',e.data->>'phase',''),
   'status',e.data->>'kind','code',coalesce(e.data->>'error_code',''),'plan_id',p.plan_id,'channel_id',p.channel_id)) FROM control.events e JOIN control.plans p USING(plan_id) WHERE p.workspace_id=$1`,[workspace]);
  await client.query(`SELECT telemetry.record_failure(p.workspace_id,'event:'||e.plan_id||':'||e.event_id,CASE WHEN e.data->>'domain'='AGENT' THEN 'AGENT' ELSE 'WORKER' END,coalesce(e.data->>'error_code','EXECUTION_FAILED'),p.plan_id,NULL,(e.data->>'execution_epoch')::int,coalesce(e.data->>'domain',e.data->>'phase',''),'',1,NULL)
   FROM control.events e JOIN control.plans p USING(plan_id) WHERE p.workspace_id=$1 AND e.data->>'kind' IN ('ERROR','FAILED')`,[workspace]);
  // Completed historical plans settle their transient errors; ignored/rejected plans keep their diagnostic evidence.
  await client.query("UPDATE control.failures f SET state='RESOLVED',resolved_at=p.finished_at,version=f.version+1 FROM control.plans p WHERE f.plan_id=p.plan_id AND p.workspace_id=$1 AND p.status='COMPLETED' AND f.state='OPEN'",[workspace]);
  await client.query(`UPDATE crawl_data.ingest_units SET fact=fact WHERE workspace_id=$1 AND fact ? 'kind'`,[workspace]);
  await client.query(`SELECT telemetry.emit(workspace_id,'query:'||run_id||':'||state||':'||attempt||':'||failures,jsonb_build_object('at',coalesce(finished_at,started_at,created_at),'kind','SEARCH','status',state,'plan_id',run_id,'units',coalesce(new_channels,0))) FROM control.query_runs WHERE workspace_id=$1`,[workspace]);
  await client.query(`SELECT telemetry.emit(d.workspace_id,'api:'||d.request_id||':GRANTED',jsonb_build_object('at',d.granted_at,'source_mode',coalesce(p.source_mode,'youtube'),'kind','DATA_API','domain',coalesce(d.endpoint,'unknown'),'status','GRANTED','plan_id',coalesce(d.plan_id::text,d.run_id::text,''),'channel_id',coalesce(p.channel_id,''))) FROM control.data_api_permits d LEFT JOIN control.plans p USING(plan_id) WHERE d.workspace_id=$1`,[workspace]);
  await client.query(`SELECT telemetry.emit(d.workspace_id,'api:'||d.request_id||':'||d.failure,jsonb_build_object('at',d.failed_at,'source_mode',coalesce(p.source_mode,'youtube'),'kind','DATA_API','domain',coalesce(d.endpoint,'unknown'),'status','FAILED','code',d.failure,'plan_id',coalesce(d.plan_id::text,d.run_id::text,''),'channel_id',coalesce(p.channel_id,''))) FROM control.data_api_permits d LEFT JOIN control.plans p USING(plan_id) WHERE d.workspace_id=$1 AND d.failure IS NOT NULL`,[workspace]);
  await client.query(`SELECT telemetry.emit(p.workspace_id,'agent:'||p.plan_id||':'||p.status,jsonb_build_object('at',coalesce(p.finished_at,p.updated_at),'source_mode',p.source_mode,'kind','AGENT_TASK','domain','AGENT','status',p.status,
   'plan_id',p.plan_id,'channel_id',p.channel_id,'duration_ms',greatest(0,extract(epoch FROM coalesce(p.finished_at,p.updated_at)-p.created_at)*1000))) FROM control.plans p WHERE workspace_id=$1 AND 'AGENT'=ANY(required_domains) AND status IN ('COMPLETED','FAILED','CANCELLED')`,[workspace]);
  const videoCount=(await client.query('SELECT count(*)::int AS n FROM crawl_data.videos WHERE workspace_id=$1',[workspace])).rows[0].n;
  for(let offset=0;offset<videoCount;offset+=500)await client.query(`WITH batch AS MATERIALIZED(SELECT * FROM crawl_data.videos WHERE workspace_id=$1 ORDER BY channel_id,video_id LIMIT 500 OFFSET $2)
   SELECT telemetry.emit(v.workspace_id,'baseline:'||v.workspace_id||':'||v.channel_id||':'||v.video_id,jsonb_build_object('kind','SNAPSHOT','domain','VIDEO','status',CASE WHEN v.data->>'unavailable'='true' THEN 'UNAVAILABLE' WHEN m.missing>0 THEN 'PARTIAL' ELSE 'APPLIED' END,
   'source_mode',coalesce(p.source_mode,'youtube'),'plan_id',coalesce(p.plan_id::text,''),'channel_id',v.channel_id,'entity_id',v.video_id,'units',1,'metric_total',m.total,'metric_missing',m.missing,
   'views',coalesce(v.data->'view_count'->'value','null'),'likes',coalesce(v.data->'like_count'->'value','null'),'comments',coalesce(v.data->'comment_count'->'value','null'),'duration_seconds',coalesce(v.data->'duration_seconds'->'value','null'))) FROM batch v LEFT JOIN control.plans p ON p.source_revision=v.source_revision
   CROSS JOIN LATERAL (SELECT count(k) FILTER(WHERE v.data->>'unavailable' IS DISTINCT FROM 'true') AS total,count(k) FILTER(WHERE v.data->>'unavailable' IS DISTINCT FROM 'true' AND (v.data->k->>'status' NOT IN ('exact','estimated','empty','disabled') OR v.data->k->>'value' IS NULL)) AS missing FROM unnest(ARRAY['view_count','like_count','comment_count','duration_seconds']) k) m`,[workspace,offset]);
  const events=(await client.query('SELECT event FROM telemetry.outbox WHERE workspace_id=$1',[workspace])).rows;events.forEach(r=>OpsEventSchema.parse(r.event));
  const counts={events:events.length,video_snapshots:videoCount};
  await client.query('INSERT INTO telemetry.bootstrap(workspace_id,counts) VALUES($1,$2)',[workspace,counts]);console.log(JSON.stringify(counts));
 }
 await client.query('COMMIT');
}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await pool.end();}
