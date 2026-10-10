import assert from 'node:assert/strict';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { createPool } from '@crawlsystem/store/config';

// Aggregate identities and counts only: never export stored facts or comment text.
const mode=process.argv[2];assert.ok(mode==='baseline'||mode==='verify');
const pool=createPool();
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try {
  const split=Boolean((await pool.query("SELECT to_regclass('control.plans') AS relation")).rows[0].relation);
  const control=split?'control':'m1',data=split?'crawl_data':'m1';
  const videos=(await pool.query(`SELECT count(*)::int AS videos,
    md5(string_agg(jsonb_build_array(workspace_id,channel_id,video_id)::text,'|' ORDER BY workspace_id,channel_id,video_id)) AS identity_hash,
    count(*) FILTER(WHERE data->'comments_first_page' IS NOT NULL AND data->'comments_first_page'<>'null'::jsonb)::int AS pg_comment_pages,
    count(*) FILTER(WHERE data->'comments_ref' IS NOT NULL AND data->'comments_ref'<>'null'::jsonb)::int AS referenced_pages,
    coalesce(sum(coalesce((data->'comments_summary'->>'returned_count')::int,jsonb_array_length(data->'comments_first_page'->'comments'),0)),0)::int AS comments
    FROM ${data}.videos`)).rows[0];
  const names=mode==='baseline'
    ?(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='m1' AND tablename NOT IN ('migrations','videos') ORDER BY tablename")).rows.map(r=>r.tablename as string)
    :Object.keys(JSON.parse(readFileSync('.runtime/r3/preservation-baseline.json','utf8')).tables);
  const tables:Record<string,number>={};
  for(const table of names){assert.match(table,/^[a-z_]+$/);tables[table]=Number((await pool.query(`SELECT count(*) AS n FROM ${control}.${table}`)).rows[0].n);}
  const snapshot={videos,tables,observed_at:new Date().toISOString()};
  mkdirSync('.runtime/r3',{recursive:true,mode:0o700});
  if(mode==='baseline') {
    assert.equal(split,false,'Capture the baseline before the schema cutover');
    writeFileSync('.runtime/r3/preservation-baseline.json',JSON.stringify(snapshot,null,2));
    console.log(JSON.stringify({phase:'preservation_baseline',...videos,control_tables:names.length}));
  } else {
    assert.equal(split,true);
    const baseline=JSON.parse(readFileSync('.runtime/r3/preservation-baseline.json','utf8'));
    assert.equal(videos.videos,baseline.videos.videos);assert.equal(videos.identity_hash,baseline.videos.identity_hash);
    assert.equal(videos.comments,baseline.videos.comments);assert.equal(videos.pg_comment_pages,0);
    assert.equal(videos.referenced_pages,baseline.videos.pg_comment_pages+baseline.videos.referenced_pages);
    assert.deepEqual(tables,baseline.tables);
    assert.equal((await pool.query("SELECT convalidated FROM pg_constraint WHERE conrelid='crawl_data.videos'::regclass AND conname='videos_comments_external'")).rows[0]?.convalidated,true);
    const result={result:'PASSED',...snapshot,backup:'.runtime/r3/pre-r3.pg.dump'};
    writeFileSync('.runtime/r3/preservation-evidence.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify({result:'PASSED',...videos,control_tables:names.length,comments_storage_constraint:'ENFORCED'}));
  }
}finally{await pool.end();}
