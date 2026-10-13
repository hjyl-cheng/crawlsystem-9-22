// One-off correction, 10-13 (plan §8 batch 2a). Video facts stored before the legacy access rule carry access
// 'unknown' for an inconclusive playability over a complete public surface; the legacy rule (oldsystem
// youtubeJs.js:1546-1566) makes them public. The web mapper only stored a fact with title, publication, views and
// duration, so every such fact had that complete surface. Each channel is corrected and republished in its own
// transaction; corrected video ids are logged so the change can be reverted. Dry run by default; --apply writes.
//   node --env-file=.runtime/main.env --import tsx scripts/ops/video-access-correction.ts [--apply] [--limit N] [--pause-ms N]
import { appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPool } from '../../packages/store/src/config.ts';
import { queuePublication } from '../../packages/store/src/publication.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const apply = process.argv.includes('--apply'), limit = Number(arg('--limit') ?? Infinity), pauseMs = Number(arg('--pause-ms') ?? 250);
const STALE = `data->>'access_status'='unknown' AND data->>'access_status_source'='youtubei:player' AND NOT data ? 'unavailable'`;
const CORRECTION = { access_status: 'public', access_status_source: 'youtubei:public_metadata', availability: 'public' };
const pool = createPool();
const channels = (await pool.query(`SELECT workspace_id, channel_id, count(*)::int AS videos FROM crawl_data.videos WHERE ${STALE} GROUP BY 1,2 ORDER BY 1,2`)).rows as { workspace_id: string; channel_id: string; videos: number }[];
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', channels: channels.length, videos: channels.reduce((n, c) => n + c.videos, 0) }));
if (!apply) { await pool.end(); process.exit(0); }
mkdirSync('.runtime/video-access-correction', { recursive: true });
const log = `.runtime/video-access-correction/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
const tally: Record<string, number> = {};
for (const channel of channels.slice(0, limit)) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(`UPDATE crawl_data.videos SET data = data || $3::jsonb, updated_at = clock_timestamp() WHERE workspace_id=$1 AND channel_id=$2 AND ${STALE} RETURNING video_id`,
      [channel.workspace_id, channel.channel_id, JSON.stringify(CORRECTION)]);
    await queuePublication(client, channel.workspace_id, channel.channel_id, null);
    const delivery = (await client.query('SELECT delivery_id, status, error_code FROM delivery.records WHERE workspace_id=$1 AND channel_id=$2 ORDER BY created_at DESC LIMIT 1', [channel.workspace_id, channel.channel_id])).rows[0];
    await client.query('COMMIT');
    const outcome = `${delivery?.status ?? 'NO_TARGET'}${delivery?.error_code ? ':' + delivery.error_code : ''}`;
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    appendFileSync(log, JSON.stringify({ ...channel, corrected: updated.rows.map(r => r.video_id), delivery_id: delivery?.delivery_id ?? null, outcome, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    tally.error = (tally.error ?? 0) + 1;
    appendFileSync(log, JSON.stringify({ ...channel, error: (error as Error).message, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } finally { client.release(); }
  await sleep(pauseMs);
}
console.log(JSON.stringify({ log, tally }));
await pool.end();
