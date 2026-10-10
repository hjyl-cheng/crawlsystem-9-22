import type { Pool, PoolClient } from 'pg';
import { type FrozenInput, type VideoFacts } from '@crawlsystem/contracts';
import { contentHash } from '@crawlsystem/contracts/hash';
import { PipelineFactSchema, type PipelineFact } from '@crawlsystem/contracts/pipeline';

export class SinkFailure extends Error {
  constructor(readonly code: string) { super(`Fact rejected: ${code}`); }
}
/** Only collected data and its durable receipt are written by this service. */
export class PgSink {
  constructor(private pool: Pool, private verify: (fact: PipelineFact) => Promise<void> = async () => {}) {}
  async apply(value: unknown): Promise<'APPLIED' | 'DUPLICATE'> {
    const fact = PipelineFactSchema.parse(value), r = fact.raw, factHash = contentHash(fact);
    const base=`v1/${encodeURIComponent(r.workspace_id)}/${r.plan_id}/${r.execution_epoch}/${r.step}/${r.unit_id}`;
    if(r.bucket!=='crawl-raw' || r.key!==`${base}.json.gz` || fact.parsed.bucket!=='crawl-parsed'
      || fact.parsed.key!==`${base}.youtube-raw-1.${r.sha256}.json.gz`)throw new SinkFailure('INTEGRITY');
    await this.verify(fact);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");
      // Lock first, including duplicates, to serialize same-plan concurrent partitions/steps.
      // Already durable duplicates can be acknowledged after a plan has completed or cancelled.
      let plan;
      try { plan = (await client.query('SELECT control.lock_pipeline_plan($1,$2,$3,$4) AS plan', [r.workspace_id,r.plan_id,r.execution_epoch,r.input_hash])).rows[0]!.plan; }
      catch (error) {
        if ((error as Error).message !== 'PLAN_TERMINAL' && (error as Error).message !== 'STALE_EXECUTION') throw error;
        await client.query('ROLLBACK');
        const old = (await client.query('SELECT fact_hash FROM crawl_data.ingest_units WHERE plan_id=$1 AND execution_epoch=$2 AND step=$3 AND unit_id=$4 AND workspace_id=$5',
          [r.plan_id,r.execution_epoch,r.step,r.unit_id,r.workspace_id])).rows[0];
        if (old?.fact_hash === factHash) return 'DUPLICATE';
        throw error;
      }
      const old = (await client.query('SELECT fact_hash FROM crawl_data.ingest_units WHERE plan_id=$1 AND execution_epoch=$2 AND step=$3 AND unit_id=$4',
        [r.plan_id,r.execution_epoch,r.step,r.unit_id])).rows[0];
      if (old) {
        if (old.fact_hash !== factHash) throw new SinkFailure('CONFLICT');
        await client.query('COMMIT'); return 'DUPLICATE';
      }
      const frozen = plan.frozen_input as FrozenInput;
      if (Number(plan.source_revision) !== fact.source_revision || plan.channel_id !== r.channel_id) throw new SinkFailure('INPUT_MISMATCH');
      const required = frozen.required_domains;
      const targets: string[] | null = frozen.source_mode === 'fixture' ? frozen.target_video_ids : plan.video_targets;
      if(['TARGETS','VIDEO'].includes(fact.kind) && !targets) throw new SinkFailure('DOMAIN_INCOMPLETE');
      if (fact.kind === 'ABOUT') {
        if (r.step !== 'ABOUT' || r.unit_id !== 'channel' || !required.includes('ABOUT') || fact.payload.channel_id !== r.channel_id) throw new SinkFailure('TARGET_MISMATCH');
        await this.channel(client,fact,'about');
      } else if (fact.kind === 'AGENT') {
        if (r.step !== 'AGENT' || r.unit_id !== 'profile' || !required.includes('AGENT') || fact.payload.channel_id !== r.channel_id
          || fact.payload.input_hash !== plan.pipeline_agent_hash) throw new SinkFailure('INPUT_MISMATCH');
        const snapshot=plan.pipeline_agent_snapshot as {about:unknown;videos:VideoFacts[]}|null;
        if(!snapshot)throw new SinkFailure('INPUT_MISMATCH');
        const about=(await client.query('SELECT about FROM crawl_data.channels WHERE workspace_id=$1 AND channel_id=$2',[r.workspace_id,r.channel_id])).rows[0]?.about;
        const rows=(await client.query('SELECT video_id,data FROM crawl_data.videos WHERE workspace_id=$1 AND channel_id=$2 AND video_id=ANY($3::text[])',
          [r.workspace_id,r.channel_id,snapshot.videos.map(v=>v.source_content_id)])).rows;
        const videos=snapshot.videos.map(v=>rows.find(row=>row.video_id===v.source_content_id)?.data);
        if(contentHash({about,videos})!==contentHash(snapshot))throw new SinkFailure('INPUT_MISMATCH');
        await this.channel(client,fact,'agent');
      } else if (fact.kind === 'TARGETS') {
        if (r.step !== 'TARGETS' || r.unit_id !== 'uploads' || !required.includes('VIDEO') || fact.payload.channel_id !== r.channel_id
          || !targets || contentHash(fact.payload.video_ids) !== contentHash(targets)) throw new SinkFailure('TARGET_MISMATCH');
        // Navigation decisions belong to Control. This receipt proves independent parsing agreed.
      } else if (fact.kind === 'VIDEO') {
        const match = /^VIDEO-(\d+)$/.exec(r.step), batch = match ? Number(match[1]) : -1;
        if (!required.includes('VIDEO') || !targets || !targets.slice(batch*10,(batch+1)*10).includes(r.unit_id)
          || fact.payload.source_content_id !== r.unit_id || fact.payload.channel_id !== r.channel_id) throw new SinkFailure('TARGET_MISMATCH');
        await client.query(`INSERT INTO crawl_data.videos(workspace_id,channel_id,video_id,source_revision,data,observed_at,stats_observed_at)
          VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(workspace_id,channel_id,video_id) DO UPDATE
          SET data=CASE WHEN crawl_data.videos.stats_observed_at>EXCLUDED.stats_observed_at AND NOT coalesce((EXCLUDED.data->>'unavailable')::boolean,false)
            AND NOT coalesce((crawl_data.videos.data->>'unavailable')::boolean,false)
            THEN EXCLUDED.data||jsonb_build_object('view_count',crawl_data.videos.data->'view_count','like_count',crawl_data.videos.data->'like_count','comment_count',crawl_data.videos.data->'comment_count') ELSE EXCLUDED.data END,
          source_revision=EXCLUDED.source_revision,observed_at=EXCLUDED.observed_at,
          stats_observed_at=greatest(crawl_data.videos.stats_observed_at,EXCLUDED.stats_observed_at),updated_at=clock_timestamp()
          WHERE (coalesce(crawl_data.videos.observed_at,'-infinity'),crawl_data.videos.source_revision) <= (EXCLUDED.observed_at,EXCLUDED.source_revision)`,
          [r.workspace_id,r.channel_id,r.unit_id,fact.source_revision,fact.payload,r.captured_at]);
      } else {
        const planned = frozen.source_mode === 'youtube' ? frozen.recent_sampling?.video_ids ?? [] : [];
        const ids = [...fact.payload.items.map(i=>i.video_id),...fact.payload.missing_video_ids];
        if (r.step !== 'SAMPLING' || !required.includes('VIDEO') || !planned.includes(r.unit_id) || ids.length !== 1 || ids[0] !== r.unit_id)
          throw new SinkFailure('TARGET_MISMATCH');
        const item = fact.payload.items[0];
        if (item) {
          const row = (await client.query('SELECT data,stats_observed_at FROM crawl_data.videos WHERE workspace_id=$1 AND channel_id=$2 AND video_id=$3 FOR UPDATE',
            [r.workspace_id,r.channel_id,r.unit_id])).rows[0];
          if (row && !row.data.unavailable && (!row.stats_observed_at || new Date(row.stats_observed_at) <= new Date(fact.payload.observed_at))) {
            const video = row.data as VideoFacts;
            const metric = (n: number | null,m: VideoFacts['view_count'])=>n === null ? m : { value:n,status:'exact',source:fact.payload.source,observed_at:fact.payload.observed_at };
            const data = { ...video,view_count:item.metrics?.view_count??metric(item.view_count,video.view_count),like_count:item.metrics?.like_count??metric(item.like_count,video.like_count),
              comment_count:video.comments_disabled ? video.comment_count : item.metrics?.comment_count??metric(item.comment_count,video.comment_count) };
            await client.query('UPDATE crawl_data.videos SET data=$4,stats_observed_at=$5,updated_at=clock_timestamp() WHERE workspace_id=$1 AND channel_id=$2 AND video_id=$3',
              [r.workspace_id,r.channel_id,r.unit_id,data,fact.payload.observed_at]);
          }
        }
      }
      await client.query(`INSERT INTO crawl_data.ingest_units(plan_id,execution_epoch,step,unit_id,workspace_id,raw_key,raw_hash,fact_hash,fact)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[r.plan_id,r.execution_epoch,r.step,r.unit_id,r.workspace_id,r.key,r.sha256,factHash,fact]);
      await client.query('COMMIT'); return 'APPLIED';
    } catch (error) {
      await client.query('ROLLBACK').catch(()=>{});
      if((error as {code?:string}).code==='P0001' && /^(NOT_FOUND|STALE_EXECUTION|INPUT_MISMATCH|PLAN_TERMINAL|BUDGET_EXHAUSTED)$/.test((error as Error).message))
        throw new SinkFailure((error as Error).message);
      throw error;
    }
    finally { client.release(); }
  }
  private async channel(client: PoolClient,fact: Extract<PipelineFact,{kind:'ABOUT'|'AGENT'}>,field: 'about'|'agent') {
    const r=fact.raw;
    await client.query(`INSERT INTO crawl_data.channels(workspace_id,channel_id,${field},${field}_revision,${field}_observed_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,channel_id) DO UPDATE SET ${field}=EXCLUDED.${field},
      ${field}_revision=EXCLUDED.${field}_revision,${field}_observed_at=EXCLUDED.${field}_observed_at,updated_at=clock_timestamp()
      WHERE (coalesce(crawl_data.channels.${field}_observed_at,'-infinity'),crawl_data.channels.${field}_revision)
        <= (EXCLUDED.${field}_observed_at,EXCLUDED.${field}_revision)`,[r.workspace_id,r.channel_id,fact.payload,fact.source_revision,r.captured_at]);
  }
}
