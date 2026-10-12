import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { prepareDatabase } from './database-ready.ts';
const pool=createPool(),store=new Store(pool);
assert.notEqual(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
before(async()=>prepareDatabase(pool)); after(async()=>pool.end());
test('business metrics expose zero when idle, isolate tenants and exclude stale proxy assignments',async()=>{
 const workspace='finish-metrics-'+randomUUID(),other='finish-metrics-'+randomUUID();
 for(const w of [workspace,other])await pool.query("INSERT INTO delivery.targets(workspace_id,name,stream_id,enabled) VALUES($1,'metrics-test',gen_random_uuid(),true)",[w]);
 const values=async()=>Object.fromEntries((await store.businessMetrics(workspace)).map(m=>[m.metric+':'+m.state,m.value]));
 const empty=await values(); for(const name of ['real_active_plans:ACTIVE','overdue_plans:ACTIVE','pipeline_oldest_pending_seconds:PENDING','delivery_oldest_pending_seconds:PENDING','delivery_failed:FAILED','ready_workers:RUNNING','healthy_proxies:HEALTHY'])assert.equal(empty[name],0,name);
 const proxy=randomUUID();
 await pool.query(`INSERT INTO control.proxies(workspace_id,proxy_id,protocol,host,port,provider,group_name,kind,max_concurrency,server_id) VALUES($1,$2,'http','test.invalid',8080,'test','test','static',1,'s2')`,[workspace,proxy]);
 await pool.query(`INSERT INTO control.proxy_observations(workspace_id,proxy_id,server_id,generation,state,requests_total,failures_total,node_boot_id,report_sequence,observed_at,reported_at)
 VALUES($1,$2,'s2',0,'healthy',1,0,'finish-test',1,now(),now())`,[workspace,proxy]);
 assert.equal((await values())['healthy_proxies:HEALTHY'],1);
 await pool.query("UPDATE control.proxy_observations SET reported_at=now()-interval '10 minutes' WHERE workspace_id=$1",[workspace]);assert.equal((await values())['healthy_proxies:HEALTHY'],0);
 await pool.query('UPDATE control.proxy_observations SET reported_at=now(),generation=1 WHERE workspace_id=$1',[workspace]);assert.equal((await values())['healthy_proxies:HEALTHY'],0);
 await pool.query(`INSERT INTO delivery.records(delivery_id,workspace_id,channel_id,revision,status,created_at) VALUES($1,$2,'UC1234567890123456789012',1,'PENDING',now()-interval '20 minutes'),($3,$4,'UC1234567890123456789012',1,'FAILED',now())`,[randomUUID(),workspace,randomUUID(),other]);
 assert.ok((await values())['delivery_oldest_pending_seconds:PENDING']!>=1200);assert.equal((await values())['delivery_failed:FAILED'],0);
 await pool.query("UPDATE delivery.records SET status='DELIVERED' WHERE workspace_id=$1",[workspace]);assert.equal((await values())['delivery_oldest_pending_seconds:PENDING'],0);
});
