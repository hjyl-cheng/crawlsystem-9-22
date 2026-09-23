import { readFileSync } from 'node:fs';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { IdSchema, RoleSchema, type Principal } from '@crawlsystem/contracts';
import { StoreError } from '@crawlsystem/store';

const Claims = z.object({sub:IdSchema,workspace_id:IdSchema,role:RoleSchema,iat:z.number().int(),exp:z.number().int()});
const issuer='crawlsystem-m1', audience='crawlsystem-api';
export function loadSigningKey(env:NodeJS.ProcessEnv=process.env): Uint8Array {
  if (!env.M1_JWT_SECRET_FILE) throw new Error('M1_JWT_SECRET_FILE is required');
  const key=Buffer.from(readFileSync(env.M1_JWT_SECRET_FILE,'utf8').trim());
  if(key.byteLength<32) throw new Error('JWT key must contain at least 32 bytes');
  return key;
}
export async function authenticate(header:string|undefined, key:Uint8Array):Promise<Principal> {
  if(!header || !/^Bearer [A-Za-z0-9_.-]+$/.test(header) || header.length>4096) throw new StoreError('UNAUTHENTICATED','A valid bearer token is required',401);
  try {
    const result=await jwtVerify(header.slice(7),key,{issuer,audience,algorithms:['HS256'],requiredClaims:['sub','iat','exp','workspace_id','role'],clockTolerance:2});
    const c=Claims.parse(result.payload);
    if(c.exp<=c.iat || c.iat>Date.now()/1000+2) throw new Error('invalid token dates');
    return {subject:c.sub,workspace_id:c.workspace_id,role:c.role};
  } catch { throw new StoreError('UNAUTHENTICATED','Token is invalid or expired',401); }
}
export async function issueToken(principal:Principal,key:Uint8Array,seconds=3600):Promise<string> {
  IdSchema.parse(principal.subject);IdSchema.parse(principal.workspace_id);RoleSchema.parse(principal.role);
  if(!Number.isInteger(seconds)||seconds<1||seconds>86400) throw new Error('Token lifetime must be 1..86400 seconds');
  return new SignJWT({workspace_id:principal.workspace_id,role:principal.role}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setSubject(principal.subject).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+seconds).sign(key);
}
