// One-off correction, 10-14 (plan §8 batch 7, rule register A-37). Before batch 7 the profile model received the
// observed About country text without its English canonical name, so channels observed in pt-BR sessions ("Índia")
// got a conflicting or untranslated country and the country-dependent estimates (creator language fallback, audience
// region) built on it. The AGENT clock is 180 days, so those profiles would wait half a year. Pull each affected
// channel's AGENT clock forward to its next ABOUT/VIDEO due time: the Agent then reruns inside that regular update
// and adds no plan of its own. Old due times are logged for a revert. Dry run by default; --apply writes.
//   node --env-file=.runtime/main.env --import tsx scripts/ops/agent-country-rerun.ts [--apply]
import { appendFileSync, mkdirSync } from 'node:fs';
import { profileCountryNames } from '../../packages/contracts/src/country.ts';
import { createPool } from '../../packages/store/src/config.ts';

const REASON = 'agent_country_input_correction';
const apply = process.argv.includes('--apply'), names = profileCountryNames(), pool = createPool();
const rows = (await pool.query(`SELECT d.workspace_id, d.channel_id, d.about->>'country_code' AS code, d.agent->'facts'->'country'->>'value' AS agent_country,
    a.due_at AS agent_due, (SELECT min(k.due_at) FROM control.channel_clocks k WHERE k.workspace_id=d.workspace_id AND k.channel_id=d.channel_id AND k.clock IN ('ABOUT','VIDEO')) AS next_due
  FROM crawl_data.channels d JOIN control.channel_overview c USING(workspace_id, channel_id)
  JOIN control.channel_clocks a ON a.workspace_id=d.workspace_id AND a.channel_id=d.channel_id AND a.clock='AGENT'
  WHERE c.management_state='managed' AND d.agent IS NOT NULL AND d.about->>'country_code' IS NOT NULL ORDER BY 1, 2`)).rows;
const work = rows.filter(r => r.agent_country !== names[r.code] && r.next_due && r.next_due < r.agent_due);
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', managed_with_code: rows.length, affected: work.length,
  by_value: Object.entries(work.reduce((m: Record<string, number>, r) => (m[`${r.agent_country}→${names[r.code]}`] = (m[`${r.agent_country}→${names[r.code]}`] ?? 0) + 1, m), {})).sort((a, b) => b[1] - a[1]).slice(0, 12) }));
if (!apply) { await pool.end(); process.exit(0); }
mkdirSync('.runtime/agent-country-rerun', { recursive: true });
const log = `.runtime/agent-country-rerun/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
let changed = 0;
for (const r of work) {
  // Only if the clock still holds the due time read above (a plan in between recomputes it).
  const updated = await pool.query(`UPDATE control.channel_clocks SET due_at=$4, reason=$5, reasons=array_append(array_remove(reasons,$5),$5), updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND channel_id=$2 AND clock='AGENT' AND due_at=$3`, [r.workspace_id, r.channel_id, r.agent_due, r.next_due, REASON]);
  changed += updated.rowCount ?? 0;
  appendFileSync(log, JSON.stringify({ workspace_id: r.workspace_id, channel_id: r.channel_id, agent_country: r.agent_country, expected: names[r.code],
    before_due: r.agent_due, after_due: r.next_due, outcome: updated.rowCount ? 'MOVED' : 'CHANGED_SINCE_READ', at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify({ log, changed }));
await pool.end();
