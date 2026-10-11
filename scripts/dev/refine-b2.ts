import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createPool} from '@crawlsystem/store/config';
import {Store} from '@crawlsystem/store';
import {extractQueries} from '../../packages/store/src/query-extraction.ts';
// One-time rollout refinement. Only untouched, unsearched bindings created by this collector
// are eligible; operator changes and bindings with two corroborated sources remain protected.
const pool=createPool(),store=new Store(pool),workspace='m1-main',dir='.runtime/b2';mkdirSync(dir,{recursive:true,mode:0o700});
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try{
  assert.equal((await store.config({workspace_id:workspace,subject:'b2-quality-refinement',role:'operator'})).settings.query_collection.enabled,false);
  const rows=(await pool.query(`SELECT c.candidate_id,c.text,c.country,c.category,b.binding_id,b.version FROM control.query_collection_candidates c
    JOIN control.query_bindings b ON b.binding_id=c.binding_id WHERE c.workspace_id=$1 AND c.auto_created AND b.state='BOOTSTRAP'
      AND b.version=1 AND b.cadence_override IS NULL AND b.priority=-10 AND NOT EXISTS(SELECT 1 FROM control.query_runs WHERE binding_id=b.binding_id)
      AND NOT EXISTS(SELECT 1 FROM control.query_sources WHERE binding_id=b.binding_id AND source_ref NOT LIKE 'collected:%')`,[workspace])).rows;
  const disabled=[];
  for(const row of rows){
    const channels=(await pool.query(`SELECT d.about,d.agent,
      (SELECT coalesce(jsonb_agg(v),'[]') FROM (SELECT video_id,jsonb_build_object('title',data->'title','keywords',data->'keywords','hashtags',data->'hashtags') data
        FROM crawl_data.videos WHERE workspace_id=d.workspace_id AND channel_id=d.channel_id ORDER BY observed_at DESC NULLS LAST,video_id LIMIT 30) v) videos
      FROM control.query_collection_evidence e JOIN crawl_data.channels d ON d.workspace_id=$1 AND d.channel_id=e.channel_id WHERE e.candidate_id=$2`,[workspace,row.candidate_id])).rows;
    const grounded=channels.filter(c=>extractQueries(c.about,c.agent,c.videos)?.some(w=>w.text===row.text&&w.country===row.country&&w.category===row.category)).length;
    if(grounded>=2)continue;
    try{await store.queryCommand({workspace_id:workspace,subject:'b2-quality-refinement',role:'operator'},row.binding_id,{action:'disable',reason:'画像标签缺少至少两个来源频道的公开文本依据，收紧自动收集规则',expected_version:row.version});disabled.push({binding_id:row.binding_id,text:row.text,country:row.country,category:row.category,grounded_support:grounded});}
    catch(e){if((e as {code?:string}).code!=='CONFLICT')throw e;}
  }
  // Remove unsupported profile evidence from pending candidates too, so it cannot be promoted
  // tomorrow. Published keyword and video evidence is retained. Replay is idempotent.
  const profiles=(await pool.query(`SELECT d.channel_id,d.about,d.agent,
    (SELECT coalesce(jsonb_agg(v),'[]') FROM (SELECT video_id,jsonb_build_object('title',data->'title','keywords',data->'keywords','hashtags',data->'hashtags') data
      FROM crawl_data.videos WHERE workspace_id=d.workspace_id AND channel_id=d.channel_id ORDER BY observed_at DESC NULLS LAST,video_id LIMIT 30) v) videos
    FROM crawl_data.channels d WHERE d.workspace_id=$1 AND EXISTS(SELECT 1 FROM control.query_collection_evidence e
      JOIN control.query_collection_candidates c ON c.candidate_id=e.candidate_id WHERE c.workspace_id=$1 AND e.channel_id=d.channel_id AND e.source_type='AUTO_TAG' AND e.video_id IS NULL)`,[workspace])).rows;
  let removedEvidence=0;
  for(const profile of profiles){
    const retained=extractQueries(profile.about,profile.agent,profile.videos)??[];
    const existing=(await pool.query(`SELECT c.candidate_id,c.text,c.country,c.category FROM control.query_collection_evidence e JOIN control.query_collection_candidates c ON c.candidate_id=e.candidate_id
      WHERE c.workspace_id=$1 AND e.channel_id=$2 AND e.source_type='AUTO_TAG' AND e.video_id IS NULL`,[workspace,profile.channel_id])).rows;
    const removed=existing.filter(c=>!retained.some(w=>w.text===c.text&&w.country===c.country&&w.category===c.category)).map(c=>c.candidate_id);
    if(!removed.length)continue;
    const client=await pool.connect();
    try{await client.query('BEGIN');
      const r=await client.query(`DELETE FROM control.query_collection_evidence WHERE channel_id=$1 AND source_type='AUTO_TAG' AND video_id IS NULL AND candidate_id=ANY($2::uuid[])`,[profile.channel_id,removed]);
      await client.query(`UPDATE control.query_collection_candidates c SET support_count=n.support,handled_support_count=least(c.handled_support_count,n.support)
        FROM (SELECT c.candidate_id,count(e.candidate_id)::int support FROM control.query_collection_candidates c LEFT JOIN control.query_collection_evidence e USING(candidate_id)
          WHERE c.workspace_id=$1 AND c.candidate_id=ANY($2::uuid[]) GROUP BY c.candidate_id) n WHERE c.candidate_id=n.candidate_id`,[workspace,removed]);
      await client.query('COMMIT');removedEvidence+=r.rowCount??0;
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  writeFileSync(dir+'/quality-refinement.json',JSON.stringify({at:new Date().toISOString(),disabled,removed_profile_evidence:removedEvidence,operator_changes_preserved:true},null,2),{mode:0o600});
  console.log(`B2 refinement disabled ${disabled.length} untouched, unsearched bindings and removed ${removedEvidence} unsupported profile evidence rows`);
}catch(e){console.error('B2 refinement failed:',e instanceof Error?e.name:'UnknownError');process.exitCode=1;}
finally{await pool.end();}
