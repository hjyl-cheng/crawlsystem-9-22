import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gzipSync,gunzipSync } from 'node:zlib';
import { createPool } from '@crawlsystem/store/config';
import { CommentPageSchema } from '@crawlsystem/contracts';
import { contentHash } from '@crawlsystem/contracts/hash';
import { MinioStore } from '../../apps/execution-worker/src/raw-archive.ts';
// Run with a migration credential, after schema 20. Control itself never writes facts.
const pool=createPool(),dir=process.env.MINIO_CREDENTIALS_DIRECTORY;
if(!dir)throw new Error('A parser MinIO credential directory is required');
const secret=async(key:string)=>(await readFile(`${dir}/${key}`,'utf8')).trim();
const objects=new MinioStore(process.env.MINIO_URL??'http://minio.storage.svc.cluster.local:9000','crawl-parsed',await secret('access_key'),await secret('secret_key'));
let cursor=['','',''],migrated=0,concurrent=0;
try {
  for(;;) {
    const rows=(await pool.query(`SELECT workspace_id,channel_id,video_id,data->'comments_first_page' AS page FROM crawl_data.videos
      WHERE data->'comments_first_page' IS NOT NULL AND data->'comments_first_page'<>'null'::jsonb
      AND (workspace_id,channel_id,video_id)>($1,$2,$3) ORDER BY workspace_id,channel_id,video_id LIMIT 50`,cursor)).rows;
    if(!rows.length)break;
    for(const row of rows) {
      const page=CommentPageSchema.parse(row.page),bytes=gzipSync(JSON.stringify(page)),sha256=createHash('sha256').update(bytes).digest('hex');
      const key=`legacy/v1/${encodeURIComponent(row.workspace_id)}/${encodeURIComponent(row.channel_id)}/${encodeURIComponent(row.video_id)}.${contentHash(page).slice(7)}.json.gz`;
      const signal=AbortSignal.timeout(60000);
      try {await objects.put(key,bytes,signal,true);}
      catch(error) {const existing=await objects.get(key,signal);if(!existing||!Buffer.from(existing).equals(bytes))throw error;}
      const stored=await objects.get(key,signal);
      if(!stored||stored.length!==bytes.length||createHash('sha256').update(stored).digest('hex')!==sha256
        ||contentHash(CommentPageSchema.parse(JSON.parse(gunzipSync(stored).toString())))!==contentHash(page))throw new Error('Comment object verification failed; original remains in PG');
      const {comments:body,...summary}=page;
      const ref={bucket:'crawl-parsed',key,sha256,bytes:bytes.length};
      const changed=await pool.query(`UPDATE crawl_data.videos SET data=data||jsonb_build_object('comments_first_page',NULL,'comments_ref',$4::jsonb,'comments_summary',$5::jsonb)
        WHERE workspace_id=$1 AND channel_id=$2 AND video_id=$3 AND data->'comments_first_page'=$6::jsonb`,[row.workspace_id,row.channel_id,row.video_id,ref,summary,page]);
      if(changed.rowCount)migrated++;else concurrent++;
      cursor=[row.workspace_id,row.channel_id,row.video_id];
    }
    console.log(JSON.stringify({phase:'comments_migration',migrated,concurrent}));
  }
  const remaining=(await pool.query("SELECT count(*)::int AS n FROM crawl_data.videos WHERE data->'comments_first_page' IS NOT NULL AND data->'comments_first_page'<>'null'::jsonb")).rows[0].n;
  console.log(JSON.stringify({phase:'comments_migration_complete',migrated,concurrent,remaining}));
  if(remaining)throw new Error('Unmigrated comment pages remain; rerun without replacing original data');
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='crawl_data.videos'::regclass AND conname='videos_comments_external') THEN
      ALTER TABLE crawl_data.videos ADD CONSTRAINT videos_comments_external
        CHECK(data->'comments_first_page' IS NULL OR data->'comments_first_page'='null'::jsonb);
    END IF;
  END $$`);
  console.log(JSON.stringify({phase:'comments_storage_constraint',state:'ENFORCED'}));
} finally {await pool.end();}
