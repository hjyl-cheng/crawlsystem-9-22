// Console account administration against console.accounts.
//   add <username> --role reader|operator --workspace <id> [--subject <id>]   password on stdin
//   set-password <username>                                                 password on stdin
//   disable <username> | enable <username> | list
//   import <accounts.json>   copies existing salted scrypt records unchanged
// Passwords are read from stdin so they never appear in argv or shell history.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { IdSchema } from '@crawlsystem/contracts';
import { AccountSchema, passwordRecord } from './console-auth.ts';
import { createConsolePool } from './console-db.ts';
import { setAccountPassword,setAccountDisabled } from './console-account-ops.ts';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  role: { type: 'string' }, workspace: { type: 'string' }, subject: { type: 'string' },
} });
const [command, target] = positionals;
const username = () => AccountSchema.shape.username.parse(target);
const stdinPassword = () => readFileSync(0, 'utf8').split('\n')[0]!.replace(/\r$/, '');

const pool = createConsolePool();
try {
  switch (command) {
    case 'add': {
      const role = AccountSchema.shape.role.parse(values.role), workspace = IdSchema.parse(values.workspace);
      const name = username(), subject = IdSchema.parse(values.subject ?? name);
      const record = await passwordRecord(stdinPassword());
      await pool.query(`INSERT INTO console.accounts (username, subject, workspace_id, role, password_salt, password_hash)
        VALUES ($1, $2, $3, $4, $5, $6)`, [name, subject, workspace, role, record.salt, record.password_hash]);
      console.log(`created ${name} (${role}, workspace ${workspace})`);
      break;
    }
    case 'set-password': {
      const record = await passwordRecord(stdinPassword());
      await setAccountPassword(pool,username(),record);
      console.log(`password changed for ${username()}; existing sessions revoked`);
      break;
    }
    case 'disable': case 'enable': {
      await setAccountDisabled(pool,username(),command==='disable');
      console.log(`${command}d ${username()}`);
      break;
    }
    case 'list': {
      const { rows } = await pool.query(`SELECT username, role, workspace_id, disabled_at IS NOT NULL AS disabled,
        (SELECT count(*)::int FROM console.sessions s WHERE s.username = a.username AND s.expires_at > clock_timestamp()) AS active_sessions
        FROM console.accounts a ORDER BY username`);
      console.table(rows);
      break;
    }
    case 'import': {
      const accounts = z.array(AccountSchema).parse(JSON.parse(readFileSync(z.string().parse(target), 'utf8')));
      for (const a of accounts) {
        const result = await pool.query(`INSERT INTO console.accounts (username, subject, workspace_id, role, password_salt, password_hash)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (username) DO NOTHING`, [a.username, a.subject, a.workspace_id, a.role, a.salt, a.password_hash]);
        console.log(`${a.username}: ${result.rowCount ? 'imported' : 'already exists, unchanged'}`);
      }
      break;
    }
    default:
      throw new Error('usage: console-accounts add|set-password|disable|enable|list|import');
  }
} finally { await pool.end(); }
