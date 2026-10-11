import type {Pool,PoolClient} from 'pg';
import {ProxyAvailabilitySchema,type ProxyAvailabilityCounts,type ProxyAvailabilityQuery} from '../../contracts/src/proxy-availability.ts';
const states=['healthy','degraded','trial','cooldown','failed'] as const;
const empty=()=>({healthy:0,degraded:0,trial:0,cooldown:0,failed:0,requests:0,failures:0});
function counts(raw:ReturnType<typeof empty>):ProxyAvailabilityCounts{
  const samples=states.reduce((n,s)=>n+raw[s],0),available_samples=raw.healthy+raw.degraded;
  const rate=(n:number,d:number)=>d?Math.round(n/d*10000)/100:null;
  return {...raw,samples,available_samples,available_percent:rate(available_samples,samples),request_success_percent:raw.failures<=raw.requests?rate(raw.requests-raw.failures,raw.requests):null};
}
export interface AvailabilitySample {provider:string;group:string;state:typeof states[number];requests:number;failures:number}
/** Aggregate accepted samples once per sync. Database receipt time determines
 * the bucket; node clocks never move history. No endpoints enter the history. */
export async function sampleProxies(client:PoolClient,workspace:string,server:string,samples:AvailabilitySample[]){
  if(!samples.length)return;
  const groups=new Map<string,ReturnType<typeof empty>&{provider:string;group_name:string}>();
  for(const s of samples){
    const key=JSON.stringify([s.provider,s.group]);
    const bucket=groups.get(key)??{...empty(),provider:s.provider,group_name:s.group};
    bucket[s.state]++;bucket.requests+=s.requests;bucket.failures+=s.failures;groups.set(key,bucket);
  }
  await client.query(`INSERT INTO control.proxy_availability_hourly(workspace_id,bucket_at,server_id,provider,group_name,healthy,degraded,trial,cooldown,failed,requests,failures,first_report_at,last_report_at)
    SELECT $1,date_trunc('hour',statement_timestamp(),'UTC'),$2,provider,group_name,healthy,degraded,trial,cooldown,failed,requests,failures,statement_timestamp(),statement_timestamp()
    FROM jsonb_to_recordset($3::jsonb) AS x(provider text,group_name text,healthy bigint,degraded bigint,trial bigint,cooldown bigint,failed bigint,requests bigint,failures bigint)
    ORDER BY provider,group_name
    ON CONFLICT(workspace_id,bucket_at,server_id,provider,group_name) DO UPDATE SET
      healthy=control.proxy_availability_hourly.healthy+EXCLUDED.healthy,degraded=control.proxy_availability_hourly.degraded+EXCLUDED.degraded,
      trial=control.proxy_availability_hourly.trial+EXCLUDED.trial,cooldown=control.proxy_availability_hourly.cooldown+EXCLUDED.cooldown,failed=control.proxy_availability_hourly.failed+EXCLUDED.failed,
      requests=control.proxy_availability_hourly.requests+EXCLUDED.requests,failures=control.proxy_availability_hourly.failures+EXCLUDED.failures,last_report_at=EXCLUDED.last_report_at`,[workspace,server,JSON.stringify([...groups.values()])]);
}
export async function proxyAvailability(pool:Pool,workspace:string,q:ProxyAvailabilityQuery,now=new Date()){
  const hourly=q.resolution==='hour';
  const result=await pool.query(`WITH boundary AS(SELECT ${hourly?"date_trunc('hour',$2::timestamptz,'UTC')":"date_trunc('day',$2::timestamptz,'Asia/Shanghai')"} AS current),
    buckets AS(SELECT generate_series(current-${hourly?"interval '23 hours'":"interval '6 days'"},current,${hourly?"interval '1 hour'":"interval '1 day'"}) AS bucket_at FROM boundary),
    totals AS(SELECT ${hourly?"bucket_at":"date_trunc('day',bucket_at,'Asia/Shanghai')"} AS bucket_at,
      sum(healthy)::bigint healthy,sum(degraded)::bigint degraded,sum(trial)::bigint trial,sum(cooldown)::bigint cooldown,sum(failed)::bigint failed,sum(requests)::bigint requests,sum(failures)::bigint failures,
      max(last_report_at) AS last_report_at
      FROM control.proxy_availability_hourly WHERE workspace_id=$1 AND bucket_at>=(SELECT min(bucket_at) FROM buckets) AND bucket_at<=date_trunc('hour',$2::timestamptz,'UTC')
      AND ($3::text IS NULL OR server_id=$3) AND ($4::text IS NULL OR provider=$4) GROUP BY 1)
    SELECT b.bucket_at,t.healthy,t.degraded,t.trial,t.cooldown,t.failed,t.requests,t.failures,t.last_report_at,r.started_at
    FROM buckets b CROSS JOIN control.proxy_availability_recording r LEFT JOIN totals t USING(bucket_at) ORDER BY b.bucket_at`,[workspace,now,q.server_id??null,q.provider??null]);
  const total=empty();
  const latest=result.rows.reduce<Date|null>((max,row)=>row.last_report_at&&(!max||row.last_report_at>max)?row.last_report_at:max,null);
  const points=result.rows.map(row=>{
    const raw=empty();for(const k of Object.keys(raw) as Array<keyof typeof raw>){raw[k]=Number(row[k]??0);total[k]+=raw[k];}
    return {bucket_at:row.bucket_at.toISOString(),counts:counts(raw)};
  });
  return ProxyAvailabilitySchema.parse({observed_at:now.toISOString(),recording_since:result.rows[0].started_at.toISOString(),resolution:q.resolution,timezone:'Asia/Shanghai',latest_report_at:latest?.toISOString()??null,stale:!latest||now.getTime()-latest.getTime()>180000,summary:counts(total),points});
}
