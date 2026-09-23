import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export async function migrate(pool: Pool): Promise<void> {
  const directory = new URL('../../../database/migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(name=>/^\d{3}_.+\.sql$/.test(name)).sort();
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1823092301)');
    await client.query('CREATE SCHEMA IF NOT EXISTS m1');
    await client.query('CREATE TABLE IF NOT EXISTS m1.migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    const applied = await client.query('SELECT version,checksum FROM m1.migrations ORDER BY version');
    if (applied.rows.some(row=>!files.some(file=>Number(file.slice(0,3))===row.version))) throw new Error('Database contains a migration not known by this build');
    for (const [index,file] of files.entries()) {
      const version = Number(file.slice(0,3));
      if (version!==index+1) throw new Error('Migration versions must be contiguous and unique');
      const sql=await readFile(new URL(file,directory),'utf8');
      const checksum=createHash('sha256').update(sql).digest('hex');
      const existing=applied.rows.find(row=>row.version===version);
      if (existing) {
        if(existing.checksum!==checksum) throw new Error(`Applied migration ${version} checksum differs`);
      } else {
        await client.query(sql);
        await client.query('INSERT INTO m1.migrations(version,checksum) VALUES ($1,$2)',[version,checksum]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    discard=/connection|timeout/i.test((error as Error).message);
    if(!discard) await client.query('ROLLBACK').catch(()=>{discard=true;});
    throw error;
  } finally { client.release(discard); }
}
