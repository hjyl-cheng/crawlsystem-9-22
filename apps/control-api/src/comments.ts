import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { CommentPageSchema, type CommentPage } from '@crawlsystem/contracts';
import { ObjectReferenceSchema, type ObjectReference } from '@crawlsystem/contracts/pipeline';
import { StoreError } from '@crawlsystem/store';
import type { ObjectStore } from '../../execution-worker/src/raw-archive.ts';
export function commentReader(store:ObjectStore) {
  return async (input:ObjectReference):Promise<CommentPage|null>=>{
    const ref=ObjectReferenceSchema.parse(input);
    if(ref.bucket!=='crawl-parsed') throw new StoreError('INVALID_REQUEST','Invalid comment bucket',400);
    const bytes=await store.get(ref.key,AbortSignal.timeout(20000));
    if(!bytes) return null;
    if(bytes.length!==ref.bytes || createHash('sha256').update(bytes).digest('hex')!==ref.sha256) throw new StoreError('UNAVAILABLE','Comment object integrity check failed',503,true);
    try {return CommentPageSchema.parse(JSON.parse(gunzipSync(bytes,{maxOutputLength:64*1024*1024}).toString()));}
    catch {throw new StoreError('UNAVAILABLE','Stored comment page is invalid',503,true);}
  };
}
