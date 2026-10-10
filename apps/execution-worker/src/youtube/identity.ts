import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const IDENTITY_POLICY = { id: 'qy-br-channel-anonymous-v1', language: 'pt-BR', country: 'BR', timezone: 'America/Sao_Paulo', browser: 'chrome136' } as const;
export interface BrowserIdentity {
  profile_id: string; user_agent: string; visitor_data: string; created_at: string; saved_at: string;
  cookie_state: { cookies: Record<string, unknown>[] };
}
function visitorData(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const id = Array.from({ length: 11 }, () => alphabet[randomInt(alphabet.length)]).join('');
  let seconds = Math.floor(Date.now() / 1000); const bytes: number[] = [];
  do { bytes.push((seconds & 127) | (seconds > 127 ? 128 : 0)); seconds = Math.floor(seconds / 128); } while (seconds);
  return Buffer.concat([Buffer.from([10, 11]), Buffer.from(id), Buffer.from([40, ...bytes])]).toString('base64url');
}
/** One encrypted file per network identity, on the Worker's persistent volume. No PG credentials. */
export class IdentityStore {
  private key: Buffer;
  constructor(private directory: string, secret: string, private workerId: string) {
    if (secret.trim().length < 32) throw new Error('Browser identity encryption key is too short');
    this.key = createHash('sha256').update(secret.trim()).digest();
  }
  private path(networkKey: string) { return join(this.directory, createHash('sha256').update(`${this.workerId}:${IDENTITY_POLICY.id}:${networkKey}`).digest('hex') + '.sealed'); }
  async load(networkKey: string): Promise<BrowserIdentity> {
    try {
      const sealed = JSON.parse(await readFile(this.path(networkKey), 'utf8')) as { iv: string; tag: string; data: string };
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${this.workerId}:${networkKey}`));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString()) as BrowserIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Browser identity cannot be decrypted');
    }
    const now = new Date().toISOString();
    const identity: BrowserIdentity = { profile_id: `browser:${randomUUID()}`, created_at: now, saved_at: now,
      user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      visitor_data: visitorData(), cookie_state: { cookies: [] } };
    await this.save(networkKey, identity);
    return identity;
  }
  async save(networkKey: string, identity: BrowserIdentity): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${this.workerId}:${networkKey}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(identity)), cipher.final()]);
    const path = this.path(networkKey), temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
}
