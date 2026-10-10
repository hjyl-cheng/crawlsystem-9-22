import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes,randomUUID } from 'node:crypto';
import { createPool } from '@crawlsystem/store/config';
import { Store } from '@crawlsystem/store';
const pool=createPool(),url=new URL(process.env.DATABASE_URL!),database=url.pathname.slice(1),owner=url.username;
if(database==='crawlsystem_m1_main_test'||!/^crawlsystem_m1_r3_\d+_test$/.test(database)||!/^crawlsystem_r3_test_\d+$/.test(owner))throw new Error('Role validation requires a separate R3 database');
const stamp=randomBytes(5).toString('hex'),control=`r3_control_${stamp}`,sink=`r3_sink_${stamp}`;
const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe']});
const primary=kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']);
const sql=(input:string)=>kube(['-n','db','exec','-i',primary,'--','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],input);
sql(`CREATE ROLE ${control} NOLOGIN NOINHERIT;CREATE ROLE ${sink} NOLOGIN NOINHERIT;
GRANT ${control},${sink} TO ${owner};
GRANT USAGE ON SCHEMA control,crawl_data TO ${control},${sink};
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA control TO ${control};
GRANT SELECT ON ALL TABLES IN SCHEMA crawl_data TO ${control};
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA crawl_data TO ${sink};
GRANT EXECUTE ON FUNCTION control.lock_pipeline_plan(text,uuid,integer,text) TO ${sink};`);
const client=await pool.connect();
try {
  const store=new Store(pool,undefined,undefined,{enabled:true}),plan=await store.createPlan({subject:'role-validation',workspace_id:'r3-role-test',role:'operator'},
    {request_id:randomUUID(),fixture_id:'channel-basic-v1',required_domains:['ABOUT']});
  await client.query(`SET ROLE ${control}`);
  await client.query('SELECT 1 FROM control.channel_overview LIMIT 0');await client.query('SELECT 1 FROM control.videos LIMIT 0');
  await client.query('UPDATE control.channels SET management_version=management_version WHERE false');
  await assert.rejects(()=>client.query('UPDATE crawl_data.videos SET data=data WHERE false'),{code:'42501'});
  await client.query(`RESET ROLE;SET ROLE ${sink}`);
  await client.query('UPDATE crawl_data.videos SET data=data WHERE false');
  await assert.rejects(()=>client.query('UPDATE control.channels SET management_version=management_version WHERE false'),{code:'42501'});
  await assert.rejects(()=>client.query('SELECT 1 FROM control.plans LIMIT 0'),{code:'42501'});
  await client.query('BEGIN');
  const proof=(await client.query('SELECT control.lock_pipeline_plan($1,$2,$3,$4) AS plan',['r3-role-test',plan.plan_id,plan.execution_epoch,plan.input_hash])).rows[0].plan;
  assert.equal(proof.plan_id,plan.plan_id);await client.query('COMMIT');
  console.log(JSON.stringify({result:'PASSED',control_cannot_write_facts:true,sink_cannot_write_or_read_control_tables:true,sink_plan_fence_executes:true}));
}finally {
  await client.query('ROLLBACK;RESET ROLE').catch(()=>{});client.release();await pool.end();
  sql(`REVOKE ALL ON ALL TABLES IN SCHEMA control,crawl_data FROM ${control},${sink};
REVOKE ALL ON SCHEMA control,crawl_data FROM ${control},${sink};
REVOKE ALL ON FUNCTION control.lock_pipeline_plan(text,uuid,integer,text) FROM ${sink};
REVOKE ${control},${sink} FROM ${owner};DROP ROLE ${control};DROP ROLE ${sink};`);
}
