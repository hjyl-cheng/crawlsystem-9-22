import type {RawCleanupItem,RawCleanupResult} from '../../../packages/contracts/src/raw-retention.ts';
interface CleanupStore {head(key:string,signal:AbortSignal):Promise<number|null>;remove(key:string,signal:AbortSignal):Promise<void>;}
export async function cleanRawBatch(items:RawCleanupItem[],raw:CleanupStore,parsed:Pick<CleanupStore,'head'>,signal=AbortSignal.timeout(40_000)) {
 const results:RawCleanupResult[]=[];let cursor=0;
 await Promise.all(Array.from({length:4},async()=>{
  while(cursor<items.length&&!signal.aborted) {
   const item=items[cursor++]!,result:RawCleanupResult={key:item.key,lease_token:item.lease_token,outcome:'ERROR',bytes:0,error:'DEPENDENCY_UNAVAILABLE'};
   try {
    const prefix=`v1/${encodeURIComponent(item.workspace_id)}/${item.plan_id}/${item.execution_epoch}/`;
    const valid=item.kind==='SEARCH'
      ? item.run_id!==null&&item.plan_id===null&&new RegExp(`^search/v1/${escapeRegex(encodeURIComponent(item.workspace_id))}/${item.run_id}/[1-9][0-9]*/page-[1-9][0-9]*\\.json\\.gz$`).test(item.key)
      : item.plan_id!==null&&item.run_id===null&&item.key.startsWith(prefix)&&/^(ABOUT|TARGETS|VIDEO-\d{1,2}|SAMPLING|AGENT)\/[a-zA-Z0-9_.:-]+\.json\.gz$/.test(item.key.slice(prefix.length));
    if(!valid) {result.error='INVALID_KEY';continue;}
    for(const ref of item.required_refs) {
     if(ref.bucket!=='crawl-parsed'||!ref.key.startsWith(prefix)||ref.key.includes('/../')) {result.error='INVALID_KEY';throw new Error('Invalid parsed owner');}
     const size=await parsed.head(ref.key,signal);
     if(size===null) {result.error='PARSED_MISSING';throw new Error('Parsed object absent');}
     if(size!==ref.bytes) {result.error='INTEGRITY';throw new Error('Parsed object size differs');}
    }
    const size=await raw.head(item.key,signal);
    if(size===null) {result.outcome='MISSING';delete result.error;continue;}
    if(item.expected_bytes!==null&&size!==item.expected_bytes) {result.error='INTEGRITY';continue;}
    await raw.remove(item.key,signal);
    if(await raw.head(item.key,signal)!==null)throw new Error('Raw deletion unconfirmed');
    result.outcome='DELETED';result.bytes=size;delete result.error;
   }catch {/* Object remains protected on unavailable dependencies; expired leases recover crashes. */}
   finally {results.push(result);}
  }
 }));
 return results;
}
const escapeRegex=(x:string)=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
