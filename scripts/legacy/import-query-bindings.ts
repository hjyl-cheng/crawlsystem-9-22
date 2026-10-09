// Import derived legacy query bindings (derive-query-bindings.py) into a workspace, idempotently.
//   node --env-file=.runtime/main.env --import tsx scripts/legacy/import-query-bindings.ts <bindings.json> <workspace>
import { readFileSync } from 'node:fs';
import { createPool } from '@crawlsystem/store/config';
import { upsertBindings, type BindingInput } from '@crawlsystem/store/discovery';

const [file, workspace] = process.argv.slice(2);
if (!file || !workspace) throw new Error('usage: import-query-bindings.ts <bindings.json> <workspace>');
const rows = JSON.parse(readFileSync(file, 'utf8')) as BindingInput[];
const pool = createPool();
let created = 0;
for (let i = 0; i < rows.length; i += 2000) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    created += (await upsertBindings(client, workspace, rows.slice(i, i + 2000))).created;
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
const total = (await pool.query('SELECT count(*)::int AS n FROM m1.query_bindings WHERE workspace_id=$1', [workspace])).rows[0]!.n;
console.log(JSON.stringify({ rows: rows.length, created, bindings_in_workspace: total }));
await pool.end();
