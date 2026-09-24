import { createPublicKey, createHash } from 'node:crypto';
import { SignJWT, importPKCS8, exportJWK } from 'jose';

// Temporal namespace authorization: the frontend runs the default JWT claim
// mapper/authorizer and trusts only the public JWKS mounted from a ConfigMap.
// Control alone holds the ES256 private key and issues short tokens whose
// `permissions` claim names exactly one namespace and role, e.g.
// "crawlsystem-m1-main:write". System/admin permissions are never issued here.
export const TemporalPermissionSchema = /^[a-z0-9][a-z0-9-]{0,62}:(read|write|worker)$/;
export class TemporalTokenIssuer {
  private constructor(private key:CryptoKey,readonly kid:string,readonly lifetime:number) {}
  static async fromPem(pem:string,lifetimeSeconds=900):Promise<TemporalTokenIssuer> {
    if(!Number.isInteger(lifetimeSeconds)||lifetimeSeconds<60||lifetimeSeconds>3600) throw new Error('Temporal token lifetime must be 60..3600 seconds');
    return new TemporalTokenIssuer(await importPKCS8(pem,'ES256'),temporalKeyId(pem),lifetimeSeconds);
  }
  async issue(subject:string,permissions:string[]):Promise<string> {
    if(!permissions.length||permissions.some(p=>!TemporalPermissionSchema.test(p))) throw new Error('Temporal permissions must be <namespace>:read|write|worker');
    return new SignJWT({permissions}).setProtectedHeader({alg:'ES256',kid:this.kid,typ:'JWT'}).setSubject(subject).setIssuer('crawlsystem-control')
      .setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+this.lifetime).sign(this.key);
  }
}
/** Key ID = hash of the public key, so JWKS rotation can keep old and new keys side by side. */
export function temporalKeyId(privatePem:string):string {
  const spki=createPublicKey(privatePem).export({type:'spki',format:'der'});
  return 'crawlsystem-'+createHash('sha256').update(spki).digest('hex').slice(0,16);
}
export async function temporalJwks(privatePems:string[]):Promise<{keys:Record<string,unknown>[]}> {
  return {keys:await Promise.all(privatePems.map(async pem=>({...await exportJWK(createPublicKey(pem)),kid:temporalKeyId(pem),alg:'ES256',use:'sig'})))};
}
