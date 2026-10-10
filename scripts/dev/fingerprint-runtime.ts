import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureProfileRuntime } from './profile-agent-runtime.ts';
/** The gateway uses the same pinned Python base as the Agent, with separate hash-locked wheels. */
export async function ensureFingerprintRuntime() {
  const python = (await ensureProfileRuntime()).python, site = resolve('.runtime/fingerprint-gateway/site');
  const hash = createHash('sha256').update(readFileSync('apps/fingerprint-gateway/requirements.lock')).digest('hex');
  if (!existsSync(`${site}/.prepared`) || readFileSync(`${site}/.prepared`, 'utf8') !== hash) {
    rmSync(site, { recursive: true, force: true }); mkdirSync(site, { recursive: true, mode: 0o755 });
    execFileSync(`${python}/bin/python3.12`, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-compile', '--no-deps', '--only-binary=:all:', '--require-hashes', '--target', site, '-r', 'apps/fingerprint-gateway/requirements.lock'],
      { stdio: 'inherit', timeout: 180_000, env: { ...process.env, LD_LIBRARY_PATH: `${python}/lib` } });
    writeFileSync(`${site}/.prepared`, hash);
  }
  return { python, site };
}
