// One-off correction, 10-13 (plan §8 batch 4). Stored About facts written before batch 4 lack the country code of their
// observed About country and keep display tab titles (pt-BR or English). Recompute both with the batch 4 rules from the
// stored values, then republish each changed channel in its own transaction. Old values are logged for a revert.
// Dry run by default; --apply writes.
//   node --env-file=.runtime/main.env --import tsx scripts/ops/channel-about-correction.ts [--apply] [--limit N] [--pause-ms N]
import { appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { ChannelFactsSchema, type ChannelFacts } from '../../packages/contracts/src/index.ts';
import { createPool } from '../../packages/store/src/config.ts';
import { queuePublication } from '../../packages/store/src/publication.ts';
import { canonicalCountry } from '../../apps/execution-worker/src/youtube/country.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const apply = process.argv.includes('--apply'), limit = Number(arg('--limit') ?? Infinity), pauseMs = Number(arg('--pause-ms') ?? 100);
// The display titles YouTube.js matched by URL: videos, shorts and streams tabs, in the two session languages used so far.
const TAB = (title: string) => /^v[ií]deos$/i.test(title) ? 'videos' : /^shorts$/i.test(title) ? 'shorts' : /^(live|ao vivo)$/i.test(title) ? 'live' : null;
function corrected(about: ChannelFacts): ChannelFacts | null {
  const next = { ...about };
  if (!about.country_code && about.country && about.country_source === 'youtubei:about') next.country_code = canonicalCountry(about.country).code;
  if (!about.source.startsWith('data_api') && about.available_tabs.some(t => !['videos', 'shorts', 'live'].includes(t)))
    next.available_tabs = [...new Set(about.available_tabs.map(TAB).filter((t): t is string => t !== null))].sort();
  return JSON.stringify(next) === JSON.stringify(about) ? null : ChannelFactsSchema.parse(next);
}
const pool = createPool();
const rows = (await pool.query("SELECT workspace_id, channel_id, about FROM crawl_data.channels WHERE about IS NOT NULL AND about->>'source' NOT LIKE 'fixture%' ORDER BY 1,2")).rows as { workspace_id: string; channel_id: string; about: ChannelFacts }[];
const work = rows.map(r => ({ ...r, next: corrected(r.about) })).filter(r => r.next);
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', channels: rows.length, changed: work.length,
  country_codes: work.filter(r => !r.about.country_code && r.next!.country_code).length, tabs: work.filter(r => JSON.stringify(r.about.available_tabs) !== JSON.stringify(r.next!.available_tabs)).length }));
if (!apply) { await pool.end(); process.exit(0); }
mkdirSync('.runtime/channel-about-correction', { recursive: true });
const log = `.runtime/channel-about-correction/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`, tally: Record<string, number> = {};
for (const row of work.slice(0, limit)) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only the two corrected fields change, and only if the row still holds the values read above.
    const updated = await client.query(`UPDATE crawl_data.channels SET about = about || jsonb_build_object('country_code', $3::text, 'available_tabs', $4::jsonb), updated_at = clock_timestamp()
      WHERE workspace_id=$1 AND channel_id=$2 AND about->'country_code' IS NOT DISTINCT FROM $5::jsonb AND about->'available_tabs' = $6::jsonb`,
      [row.workspace_id, row.channel_id, row.next!.country_code, JSON.stringify(row.next!.available_tabs), JSON.stringify(row.about.country_code), JSON.stringify(row.about.available_tabs)]);
    if (updated.rowCount) await queuePublication(client, row.workspace_id, row.channel_id, null);
    const delivery = (await client.query('SELECT status, error_code FROM delivery.records WHERE workspace_id=$1 AND channel_id=$2 ORDER BY created_at DESC LIMIT 1', [row.workspace_id, row.channel_id])).rows[0];
    await client.query('COMMIT');
    const outcome = updated.rowCount ? `${delivery?.status ?? 'NO_TARGET'}${delivery?.error_code ? ':' + delivery.error_code : ''}` : 'CHANGED_SINCE_READ';
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    appendFileSync(log, JSON.stringify({ workspace_id: row.workspace_id, channel_id: row.channel_id, before: { country_code: row.about.country_code, available_tabs: row.about.available_tabs },
      after: { country_code: row.next!.country_code, available_tabs: row.next!.available_tabs }, outcome, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    tally.error = (tally.error ?? 0) + 1;
    appendFileSync(log, JSON.stringify({ channel_id: row.channel_id, error: (error as Error).message, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } finally { client.release(); }
  await sleep(pauseMs);
}
console.log(JSON.stringify({ log, tally }));
await pool.end();
