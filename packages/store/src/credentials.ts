import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Proxy credentials at rest: AES-256-GCM, bound to workspace + proxy by AAD so a
// ciphertext copied to another row does not decrypt. Only Control holds the key.
export class CredentialBox {
  constructor(private key: Buffer) { if (key.length !== 32) throw new Error('Credential key must be 32 bytes'); }
  static fromFile(path: string): CredentialBox { return new CredentialBox(Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')); }
  seal(plain: string, context: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
  }
  open(envelope: string, context: string): string {
    const [version, iv, tag, body] = envelope.split('.');
    if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('Unsupported credential envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  }
}
