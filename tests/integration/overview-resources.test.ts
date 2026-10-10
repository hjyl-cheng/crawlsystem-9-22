import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPool} from '@crawlsystem/store/config';
import {ProxyStore} from '@crawlsystem/store/proxies';
import {OverviewProxyResourcesSchema,type Principal} from '@crawlsystem/contracts';
import {prepareDatabase} from './database-ready.ts';
const pool=createPool(),store=new ProxyStore(pool);
assert.notEqual(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
before(async()=>prepareDatabase(pool));after(async()=>pool.end());
test('overview inventory aggregates all endpoints beyond the page cap without leaking endpoint identities',async()=>{
 const workspace='c3-'+randomUUID(),p:Principal={subject:'c3-reader',workspace_id:workspace,role:'reader'},other='c3-'+randomUUID();
 await pool.query(`INSERT INTO control.proxies(workspace_id,proxy_id,protocol,host,port,provider,group_name,kind,max_concurrency,server_id)
  SELECT $1,gen_random_uuid(),'http','proxy-'||n||'.invalid',8080,'test','test','static',1,'a1' FROM generate_series(1,1001) n`,[workspace]);
 await pool.query(`INSERT INTO control.proxies(workspace_id,proxy_id,protocol,host,port,provider,group_name,kind,max_concurrency,enabled)
  VALUES($1,gen_random_uuid(),'http','disabled.invalid',8080,'test','test','static',1,false),($1,gen_random_uuid(),'http','unassigned.invalid',8080,'test','test','static',1,true),($2,gen_random_uuid(),'http','other-tenant.invalid',8080,'test','test','static',1,true)`,[workspace,other]);
 const first=(await pool.query('SELECT proxy_id FROM control.proxies WHERE workspace_id=$1 AND server_id IS NOT NULL LIMIT 1',[workspace])).rows[0].proxy_id;
 await pool.query(`INSERT INTO control.proxy_observations(workspace_id,proxy_id,server_id,generation,state,cooldown_until,last_success_at,last_failure_at,last_error,latency_ms,observed_at,reported_at,requests_total,failures_total,node_boot_id,report_sequence)
  VALUES($1,$2,'a1',0,'healthy',null,now(),null,null,100,now(),now(),1,0,'c3-test',1)`,[workspace,first]);
 const summary=OverviewProxyResourcesSchema.parse(await store.resources(p));assert.equal(summary.total,1003);assert.equal(summary.by_state.healthy,1);assert.equal(summary.by_state.unknown,1000);assert.equal(summary.by_state.disabled,1);assert.equal(summary.by_state.unassigned,1);assert.deepEqual(summary.assignments,[{server_id:'a1',assigned:1001}]);assert.doesNotMatch(JSON.stringify(summary),/invalid|proxy_id|username/);
 await pool.query("UPDATE control.proxy_observations SET reported_at=now()-interval '10 minutes' WHERE workspace_id=$1",[workspace]);assert.equal((await store.resources(p)).by_state.healthy,0);
 await pool.query('UPDATE control.proxy_observations SET reported_at=now(),generation=1 WHERE workspace_id=$1',[workspace]);assert.equal((await store.resources(p)).by_state.healthy,0);
 assert.deepEqual((await store.resources({...p,workspace_id:'c3-empty-'+randomUUID()})).assignments,[]);
});
