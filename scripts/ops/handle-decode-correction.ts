// One-off correction, 10-14 (plan U1). About facts written before batch 4e (fc25b3f) kept a handle taken from a
// channel URL percent-encoded ("@S%C3%A9rieAmor-deMel"); batch 4e decodes it like legacy youtubeJs.js:640-648.
// Decode the stored handles and republish each channel in its own transaction; old values are logged for a revert.
// Dry run by default; --apply writes.
//   node --env-file=.runtime/main.env --import tsx scripts/ops/handle-decode-correction.ts [--apply]
import { appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPool } from '../../packages/store/src/config.ts';
import { queuePublication } from '../../packages/store/src/publication.ts';

const apply = process.argv.includes('--apply'), pool = createPool();
const decode = (h: string) => { try { return decodeURIComponent(h); } catch { return null; } };
const rows = (await pool.query(`SELECT workspace_id, channel_id, about->>'handle' AS handle FROM crawl_data.channels WHERE about->>'handle' LIKE '%\\%%' ORDER BY 1,2`)).rows;
const work = rows.map(r => ({ ...r, next: decode(r.handle) })).filter(r => r.next && r.next !== r.handle);
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', encoded: rows.length, decodable: work.length, sample: work.slice(0, 3).map(r => `${r.handle} → ${r.next}`) }));
if (!apply) { await pool.end(); process.exit(0); }
mkdirSync('.runtime/handle-decode-correction', { recursive: true });
const log = `.runtime/handle-decode-correction/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`, tally: Record<string, number> = {};
for (const r of work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(`UPDATE crawl_data.channels SET about = jsonb_set(about, '{handle}', to_jsonb($3::text)), updated_at = clock_timestamp()
      WHERE workspace_id=$1 AND channel_id=$2 AND about->>'handle'=$4`, [r.workspace_id, r.channel_id, r.next, r.handle]);
    if (updated.rowCount) await queuePublication(client, r.workspace_id, r.channel_id, null);
    await client.query('COMMIT');
    const outcome = updated.rowCount ? 'DECODED' : 'CHANGED_SINCE_READ';
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    appendFileSync(log, JSON.stringify({ workspace_id: r.workspace_id, channel_id: r.channel_id, before: r.handle, after: r.next, outcome, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    tally.error = (tally.error ?? 0) + 1;
    appendFileSync(log, JSON.stringify({ channel_id: r.channel_id, error: (error as Error).message, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } finally { client.release(); }
  await sleep(150);
}
console.log(JSON.stringify({ log, tally }));
await pool.end();
