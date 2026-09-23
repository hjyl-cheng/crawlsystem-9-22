import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(new URL('../../../database/migrations/001_m1.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1823092301)');
    await client.query('CREATE SCHEMA IF NOT EXISTS m1');
    await client.query('CREATE TABLE IF NOT EXISTS m1.migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    const existing = await client.query('SELECT checksum FROM m1.migrations WHERE version=1');
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum) throw new Error('Applied migration checksum differs');
    } else {
      await client.query(sql);
      await client.query('INSERT INTO m1.migrations(version,checksum) VALUES (1,$1)', [checksum]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
