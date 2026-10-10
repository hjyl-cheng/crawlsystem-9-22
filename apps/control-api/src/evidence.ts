import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {EvidencePreviewSchema,type Failure} from '@crawlsystem/contracts/analytics';
import type {ObjectStore} from '../../execution-worker/src/raw-archive.ts';
import {StoreError} from '@crawlsystem/store';
/** Whitelist a diagnostic projection; never return response bodies, cookies or model input. */
export function evidenceReader(store:ObjectStore) {
  return async(failure:Failure)=>{
    if(!failure.evidence)return EvidencePreviewSchema.parse({available:false,sha256:null,bytes:0,responses:[],note:failure.evidence_state==='MISSING'?'原对象已不存在，保留失败元数据':'尚无证据对象'});
    const ref=failure.evidence,bytes=await store.get(ref.key,AbortSignal.timeout(30_000));
    if(!bytes)return EvidencePreviewSchema.parse({available:false,sha256:ref.sha256,bytes:ref.bytes,responses:[],note:'证据对象已到期或不可用'});
    if(bytes.length!==ref.bytes||createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw new StoreError('CONFLICT','Evidence integrity check failed');
    const unit=JSON.parse(gunzipSync(bytes,{maxOutputLength:64*1024*1024}).toString()) as {responses?:unknown[]};
    const responses=(unit.responses??[]).slice(0,100).flatMap(value=>{
      const r=value as Record<string,unknown>;try {
        const url=new URL(String(r.endpoint));if(!['http:','https:'].includes(url.protocol)&&r.endpoint!=='local:profile-agent')return [];
        return [{endpoint:r.endpoint==='local:profile-agent'?'本地画像服务':url.origin+url.pathname,method:String(r.method).slice(0,10),status:Number(r.status),bytes:typeof r.body==='string'?Buffer.byteLength(r.body):0,captured_at:String(r.captured_at).slice(0,40)}];
      }catch{return [];}
    });
    return EvidencePreviewSchema.parse({available:true,sha256:ref.sha256,bytes:ref.bytes,responses,note:'原始证据保留 90 天；页面展示响应状态和大小'});
  };
}
