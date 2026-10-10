import {request} from 'node:https';
import {readFileSync} from 'node:fs';
import {AnalyticsSchema,OpsEventSchema,ChannelHistorySchema,type Analytics,type OpsEvent} from '@crawlsystem/contracts/analytics';
export interface ClickHouseOptions {url:string;user:string;password:string;ca:string;servername?:string;}
/** TLS verified, bounded HTTP client. Credentials and server response text never enter errors. */
export class ClickHouse {
  constructor(private options:ClickHouseOptions) {
    const url=new URL(options.url);if(url.protocol!=='https:'||url.username||url.password)throw new Error('ClickHouse requires a credential-free HTTPS origin');
  }
  async execute(query:string,params:Record<string,string>={},body?:string):Promise<string> {
    const url=new URL(this.options.url);url.searchParams.set('query',query);url.searchParams.set('date_time_input_format','best_effort');
    url.searchParams.set('max_execution_time','20');url.searchParams.set('max_memory_usage','268435456');
    for(const [key,value] of Object.entries(params))url.searchParams.set('param_'+key,value);
    return new Promise((resolve,reject)=>{
      const fail=()=>reject(new Error('ClickHouse unavailable'));
      const req=request(url,{method:'POST',ca:this.options.ca,servername:this.options.servername??url.hostname,
        headers:{'X-ClickHouse-User':this.options.user,'X-ClickHouse-Key':this.options.password,'content-type':'text/plain'}},res=>{
        const parts:Buffer[]=[];let size=0;res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>8_388_608){req.destroy();fail();}else parts.push(chunk);});
        res.on('error',fail);res.on('end',()=>{if(res.statusCode!==200)fail();else resolve(Buffer.concat(parts).toString('utf8'));});
      });req.setTimeout(25_000,()=>req.destroy());req.on('error',fail);req.end(body??'');
    });
  }
  async rows<T=Record<string,unknown>>(query:string,params:Record<string,string>={}):Promise<T[]> {
    const result=await this.execute(query+' FORMAT JSONEachRow',params);return result.trim()?result.trim().split('\n').map(line=>JSON.parse(line) as T):[];
  }
  async insert(raw:OpsEvent[]) {
    const events=raw.map(e=>OpsEventSchema.parse(e));
    if(events.length)await this.execute('INSERT INTO crawl.events FORMAT JSONEachRow',{},events.map(({schema_version,...e})=>JSON.stringify(e)).join('\n')+'\n');
  }
  async rebuild(events:OpsEvent[]) {
    for(const [table,seconds,fn] of [['hourly',3600,'toStartOfHour'],['daily',86400,'toStartOfDay']] as const) {
      const buckets=[...new Set(events.map(e=>Math.floor(Date.parse(e.at)/1000/seconds)*seconds))];if(!buckets.length)continue;
      if(buckets.some(b=>b<Date.now()/1000-179*86400))throw new Error('Summary requires retained event detail');
      await this.execute(`INSERT INTO crawl.${table} SELECT workspace_id,source_mode,${fn}(at) AS bucket,kind,domain,status,code,
        count(),sum(units),sum(bytes),sum(duration_ms),sum(metric_total),sum(metric_missing),now64(3)
        FROM crawl.events FINAL WHERE ${fn}(at) IN (${buckets.map(b=>`toDateTime(${b})`).join(',')}) GROUP BY workspace_id,source_mode,bucket,kind,domain,status,code`);
    }
  }
  async health() {
    const row=(await this.rows<{bytes:number}>('SELECT toFloat64(sum(bytes_on_disk)) AS bytes FROM system.parts WHERE active AND database=\'crawl\''))[0];
    const event=(await this.rows<{events:number;last_event_at:string|null}>('SELECT toFloat64(count()) AS events,if(count()=0,NULL,toString(max(at))) AS last_event_at FROM crawl.events FINAL'))[0];
    return {available:true,bytes:row?.bytes??0,events:event?.events??0,last_event_at:event?.last_event_at??null};
  }
  async agentHistory(workspace:string) {
    return (await this.rows(`SELECT toFloat64(sumIf(count,status='COMPLETED')) AS completed_24h,toFloat64(sumIf(count,status='FAILED')) AS failed_24h,
      if(sumIf(count,status='COMPLETED')=0,NULL,round(sumIf(duration_ms,status='COMPLETED')/sumIf(count,status='COMPLETED')/1000)) AS avg_seconds_24h
      FROM crawl.hourly FINAL WHERE workspace_id={workspace:String} AND source_mode='youtube' AND kind='AGENT_TASK' AND bucket>=toStartOfHour(now())-INTERVAL 23 HOUR`,{workspace}))[0];
  }
  async planHistory(workspace:string,source_mode:string) {
    return (await this.rows(`SELECT toFloat64(countIf(kind='PLAN_CREATED')) AS created_24h,toFloat64(countIf(kind='PLAN' AND status='COMPLETED')) AS completed_24h,
      if(countIf(kind='PLAN' AND status='COMPLETED')=0,NULL,round(sumIf(duration_ms,kind='PLAN' AND status='COMPLETED')/countIf(kind='PLAN' AND status='COMPLETED')/1000)) AS avg_completion_seconds_24h
      FROM crawl.events FINAL WHERE workspace_id={workspace:String} AND source_mode={source_mode:String} AND at>now()-INTERVAL 24 HOUR`,{workspace,source_mode}))[0];
  }
  async channelHistory(workspace:string,channel:string,days:number) {
    const points=await this.rows(`SELECT formatDateTime(e.at,'%FT%TZ','UTC') AS at,kind,domain,status,entity_id,views,subscribers,likes,comments,duration_seconds FROM crawl.events AS e FINAL
      WHERE workspace_id={workspace:String} AND channel_id={channel:String} AND kind IN ('FACT','SNAPSHOT') AND domain IN ('ABOUT','VIDEO','SAMPLING')
       AND e.at>now()-toIntervalDay({days:UInt32}) ORDER BY e.at DESC,event_id LIMIT 1000`,{workspace,channel,days:String(days)});
    return ChannelHistorySchema.parse({source:'clickhouse',observed_at:new Date().toISOString(),channel_id:channel,days,points:points.reverse(),limit:1000});
  }
  async dataApiHistory(workspace:string) {
    const params={workspace},filter="workspace_id={workspace:String} AND source_mode='youtube' AND kind='DATA_API' AND bucket>=toStartOfHour(now())-INTERVAL 23 HOUR";
    const hourly=await this.rows(`SELECT formatDateTime(bucket,'%FT%TZ','UTC') AS hour,toFloat64(sumIf(count,status='GRANTED')) AS calls,toFloat64(sumIf(count,status='FAILED')) AS failures FROM crawl.hourly FINAL WHERE ${filter} GROUP BY bucket ORDER BY bucket`,params);
    const endpoints=await this.rows(`SELECT domain AS endpoint,toFloat64(sumIf(count,status='GRANTED')) AS calls,toFloat64(sumIf(count,status='FAILED')) AS failures FROM crawl.hourly FINAL WHERE ${filter} GROUP BY domain ORDER BY calls DESC LIMIT 10`,params);
    const failures_by_reason=await this.rows(`SELECT code AS reason,toFloat64(sum(count)) AS count FROM crawl.hourly FINAL WHERE ${filter} AND status='FAILED' GROUP BY code ORDER BY count DESC`,params);
    const recent_failures=await this.rows(`SELECT formatDateTime(at,'%FT%TZ','UTC') AS at,domain AS endpoint,code AS reason,plan_id,channel_id FROM crawl.events FINAL
      WHERE workspace_id={workspace:String} AND source_mode='youtube' AND kind='DATA_API' AND status='FAILED' AND plan_id<>'' AND channel_id<>'' ORDER BY at DESC LIMIT 20`,params);
    return {hourly,endpoints,failures_by_reason,recent_failures};
  }
  async statistics(workspace:string,days:number):Promise<Analytics> {
    const params={workspace,days:String(days)},filter="workspace_id={workspace:String} AND source_mode='youtube' AND bucket>=toStartOfDay(now())-toIntervalDay({days:UInt32}-1)";
    const metrics=`toFloat64(sumIf(count,kind='FACT' AND domain IN ('ABOUT','VIDEO','AGENT') AND status<>'UNAVAILABLE')) AS collected,
      toFloat64(sumIf(count,kind='FACT' AND domain='VIDEO' AND status<>'UNAVAILABLE')) AS videos,
      toFloat64(sumIf(count,kind='FACT' AND domain='ABOUT')) AS about,toFloat64(sumIf(count,kind='FACT' AND domain='AGENT')) AS agent,
      toFloat64(sumIf(count,kind='PLAN' AND status='COMPLETED')) AS completed,toFloat64(sumIf(count,kind='PLAN' AND status='FAILED')) AS failed,
      toFloat64(sumIf(count,kind='SEARCH' AND status='SUCCEEDED')) AS searches,toFloat64(sumIf(bytes,kind='FACT')) AS raw_bytes,
      toFloat64(sumIf(metric_total,kind='FACT')) AS metric_total,toFloat64(sumIf(metric_missing,kind='FACT')) AS metric_missing`;
    const totals=(await this.rows(`SELECT ${metrics} FROM crawl.daily FINAL WHERE ${filter}`,params))[0];
    const trend=await this.rows(`SELECT toString(bucket) AS at,${metrics} FROM crawl.daily FINAL WHERE ${filter} GROUP BY bucket ORDER BY bucket`,params);
    const quality=await this.rows(`SELECT domain,status,toFloat64(sum(count)) AS count,toFloat64(sum(metric_missing)) AS missing,toFloat64(sum(metric_total)) AS total FROM crawl.daily FINAL WHERE ${filter} AND kind IN ('FACT','SNAPSHOT') AND domain IN ('ABOUT','VIDEO','AGENT') GROUP BY domain,status ORDER BY domain,status`,params);
    const failures=await this.rows(`SELECT code,toFloat64(sum(count)) AS count FROM crawl.daily FINAL WHERE ${filter} AND kind='FAILURE' AND status='OPEN' GROUP BY code ORDER BY count DESC LIMIT 20`,params);
    const other=(await this.rows(`SELECT toFloat64(sumIf(count,kind='SNAPSHOT')) AS baseline,toFloat64(sum(count)) AS event_count,toString(max(bucket)) AS last_event_at FROM crawl.daily FINAL WHERE ${filter}`,params))[0];
    return AnalyticsSchema.parse({source:'clickhouse',observed_at:new Date().toISOString(),days,totals,trend,quality,failures,...other,last_event_at:other?.event_count?other.last_event_at:null});
  }
}
export function clickHouseFromEnv():ClickHouse|undefined {
  const dir=process.env.CLICKHOUSE_CREDENTIALS_DIRECTORY;if(!dir)return undefined;
  const read=(key:string)=>readFileSync(`${dir}/${key}`,'utf8').trim();
  return new ClickHouse({url:process.env.CLICKHOUSE_URL??'https://clickhouse.analytics.svc.cluster.local:8443',user:read('username'),password:read('password'),ca:read('ca.crt'),servername:process.env.CLICKHOUSE_TLS_SERVERNAME});
}
