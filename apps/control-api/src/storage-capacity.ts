import {STORAGE_BUCKETS,StorageCapacitySchema,type StorageCapacity} from '../../../packages/contracts/src/storage-capacity.ts';

export const storageQueries={
  up:'min by (job)(up{job=~"minio-cluster|minio-buckets"})',
  sampled:'min(label_replace(timestamp(minio_bucket_usage_total_bytes{job="minio-buckets",bucket=~"crawl-raw|crawl-parsed|crawl-evidence"}),"sample_kind","usage","job",".*") or label_replace(timestamp(minio_bucket_quota_total_bytes{job="minio-buckets",bucket=~"crawl-raw|crawl-parsed|crawl-evidence"}),"sample_kind","quota","job",".*") or label_replace(timestamp(minio_bucket_usage_object_total{job="minio-buckets",bucket=~"crawl-raw|crawl-parsed|crawl-evidence"}),"sample_kind","objects","job",".*") or label_replace(timestamp(minio_cluster_capacity_usable_free_bytes{job="minio-cluster"}),"sample_kind","free","job",".*") or label_replace(timestamp(minio_cluster_capacity_usable_total_bytes{job="minio-cluster"}),"sample_kind","total","job",".*") or label_replace(timestamp(minio_usage_last_activity_nano_seconds{job="minio-cluster"}),"sample_kind","scan","job",".*"))',
  usage:'max by (bucket)(minio_bucket_usage_total_bytes{job="minio-buckets",bucket=~"crawl-raw|crawl-parsed|crawl-evidence"})',
  quota:'max by (bucket)(minio_bucket_quota_total_bytes{job="minio-buckets",bucket=~"crawl-raw|crawl-parsed|crawl-evidence"})',
  objects:'max by (bucket)(minio_bucket_usage_object_total{job="minio-buckets",bucket=~"crawl-raw|crawl-parsed|crawl-evidence"})',
  scan:'max(minio_usage_last_activity_nano_seconds{job="minio-cluster"})/1e9',
  free:'max(minio_cluster_capacity_usable_free_bytes{job="minio-cluster"})',
  total:'max(minio_cluster_capacity_usable_total_bytes{job="minio-cluster"})',
} as const;
export function unknownStorageCapacity(now=Date.now()):StorageCapacity{
  return {source:'prometheus',observed_at:new Date(now).toISOString(),available:false,sampled_at:null,scan_age_seconds:null,warning_percent:70,critical_percent:85,disk:{total_bytes:null,free_bytes:null},
    buckets:STORAGE_BUCKETS.map(b=>({...b,used_bytes:null,quota_bytes:null,remaining_bytes:null,objects:null,used_percent:null,state:'unknown'}))};
}
type Sample={labels:Record<string,string>;value:number};
export async function readStorageCapacity(query:(q:string)=>Promise<Sample[]>,now=Date.now()):Promise<StorageCapacity>{
  const results=await Promise.all(Object.values(storageQueries).map(query));
  const [up,sampled,usage,quota,objects,scan,free,total]=results;
  const at=sampled?.[0]?.value,by=(rows:Sample[]|undefined,bucket:string)=>rows?.find(r=>r.labels.bucket===bucket)?.value;
  const bytes=(value:number|undefined)=>Number.isSafeInteger(value)&&value!>=0?value!:null;
  if(!['minio-cluster','minio-buckets'].every(job=>up?.find(r=>r.labels.job===job)?.value===1)||at===undefined||!Number.isFinite(at)||now/1000-at>120||at>now/1000+5)return unknownStorageCapacity(now);
  const result=unknownStorageCapacity(now);result.sampled_at=new Date(at*1000).toISOString();
  const age=scan?.[0]?.value;result.scan_age_seconds=age!==undefined&&Number.isFinite(age)&&age>=0?age:null;
  const diskFree=bytes(free?.[0]?.value),diskTotal=bytes(total?.[0]?.value);
  if(diskFree!==null&&diskTotal!==null&&diskTotal>0&&diskFree<=diskTotal)result.disk={free_bytes:diskFree,total_bytes:diskTotal};
  result.buckets=result.buckets.map(b=>{
    const used=bytes(by(usage,b.bucket)),limit=bytes(by(quota,b.bucket)),count=bytes(by(objects,b.bucket));
    // A successful scrape can still lack a bucket or have an obsolete scanner
    // estimate. Missing or stale usage must never be displayed as free space.
    if(used===null||limit===null||limit===0||count===null||result.scan_age_seconds===null||result.scan_age_seconds>21600)return b;
    const percent=used/limit*100;
    return {...b,used_bytes:used,quota_bytes:limit,remaining_bytes:Math.max(0,limit-used),objects:count,used_percent:percent,state:percent>=85?'critical':percent>=70?'warning':'ok'};
  });
  result.available=result.buckets.every(b=>b.state!=='unknown')&&result.disk.free_bytes!==null;
  return StorageCapacitySchema.parse(result);
}
