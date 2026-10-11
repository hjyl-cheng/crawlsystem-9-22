import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,createWriteStream,createReadStream,existsSync,renameSync,statSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {once} from 'node:events';
import {createPool} from '@crawlsystem/store/config';
import {assertRetired,cleanup,inventory,inventoryHash,isHistoricalTestWorkspace,type Selection} from './e3-cleanup-lib.ts';

const mode=process.argv[2]??'audit';assert.ok(['audit','backup','apply','verify'].includes(mode));
const dir='.runtime/e3';mkdirSync(dir,{recursive:true,mode:0o700});
const env={...process.env,K3S_CONFIG_FILE:'/dev/null',KUBECTL_REMOTE_COMMAND_WEBSOCKETS:'false'};
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
const pool=createPool();let phase='connect';
const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,env,stdio:['pipe','pipe','pipe'],timeout:30000,maxBuffer:32*1024*1024});
const save=(name:string,data:unknown)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(data,null,2)+'\n',{mode:0o600});
const load=(name:string)=>JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8'));
async function hashFile(path:string){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
const primary=()=>kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']).trim();
function accounts(){
 const text=kube(['-n','db','exec','-i',primary(),'--','psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-U','postgres','-d','crawler'],
  "BEGIN READ ONLY;SELECT coalesce(json_agg(x),'[]'::json) FROM (SELECT workspace_id,count(*)::int n FROM console.accounts WHERE disabled_at IS NULL GROUP BY 1 ORDER BY 1) x;ROLLBACK;");
 return JSON.parse(text) as {workspace_id:string;n:number}[];
}
function runtimeWorkspaces(){
 const deployments=JSON.parse(kube(['get','deployments,statefulsets','-A','-o','json'])).items;
 return [...new Set<string>(deployments.flatMap((d:any)=>(d.spec.template.spec.containers??[]).flatMap((c:any)=>(c.env??[]).filter((e:any)=>e.name==='M1_WORKSPACE_ID').map((e:any)=>{assert.ok(e.value,'Workspace must be explicitly configured');return e.value;}))))].sort();
}
function executions(selection:Selection){
 const ns=JSON.parse(kube(['-n','temporal','exec','deployment/temporal-admintools','--','temporal','operator','namespace','list','--output','json']));
 const n=ns.find((x:any)=>x.namespaceInfo.name==='crawlsystem-m1-main');assert.equal(n.config.workflowExecutionRetentionTtl,'604800s');
 const runs=JSON.parse(kube(['-n','temporal','exec','deployment/temporal-admintools','--','temporal','workflow','list','--namespace','crawlsystem-m1-main','--limit','100000','--output','json']));
 assert.ok(runs.length<100000,'Temporal listing truncated');
 const selected=new Set(selection.workspaces);const matching=runs.filter((r:any)=>selected.has(r.execution.workflowId.split('/')[1]));
 for(const r of matching){assert.notEqual(r.status,'WORKFLOW_EXECUTION_STATUS_RUNNING','Test workflow still running');assert.ok(r.closeTime&&Date.parse(r.closeTime)<Date.now()-7*86400000,'Test workflow still in recovery window');}
 return {namespace:'crawlsystem-m1-main',retention_seconds:604800,listed:runs.length,matching:matching.map((r:any)=>({workflow_id:r.execution.workflowId,status:r.status,closed_at:r.closeTime}))};
}
async function protectedState(db:import('pg').PoolClient){
 return {
  settings:(await db.query("SELECT version,settings FROM control.runtime_settings WHERE workspace_id='m1-main'")).rows[0],
  schema:(await db.query('SELECT version,checksum FROM m1.migrations ORDER BY version')).rows,
  // Frozen fixtures, receipts, failures and ingest identities remain available for diagnosis/replay.
  fixture_plans:(await db.query("SELECT plan_id,status,input_hash FROM control.plans WHERE workspace_id='m1-main' AND source_mode='fixture' ORDER BY plan_id")).rows,
  videos:(await db.query("SELECT workspace_id,channel_id,video_id FROM crawl_data.videos WHERE workspace_id='m1-main' AND channel_id<>'fixture:channel:basic' ORDER BY 1,2,3")).rows,
  delivered:(await db.query("SELECT delivery_id FROM delivery.records WHERE workspace_id='m1-main' AND status='DELIVERED' ORDER BY 1")).rows,
  identities:(await db.query(`SELECT 'receipt' kind,submission_id::text id FROM control.receipts WHERE workspace_id='m1-main'
   UNION ALL SELECT 'ingest',plan_id::text||':'||execution_epoch||':'||step||':'||unit_id FROM crawl_data.ingest_units WHERE workspace_id='m1-main'
   UNION ALL SELECT 'plan',plan_id::text FROM control.plans WHERE workspace_id='m1-main' ORDER BY 1,2`)).rows,
 };
}
try{
 const db=await pool.connect();try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await db.query("SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='30s';SET LOCAL idle_in_transaction_session_timeout='240s'");
  assert.equal((await db.query('SELECT max(version)::int n FROM m1.migrations')).rows[0].n,37);
  phase='external-guards';const liveAccounts=accounts(),runningSpaces=runtimeWorkspaces();
  if(mode==='audit'){
   const catalog=(await db.query(`SELECT c.table_schema,c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.column_name='workspace_id' AND t.table_type='BASE TABLE' AND c.table_schema IN ('control','crawl_data','telemetry','delivery') ORDER BY 1,2`)).rows;
   const spaces=new Set<string>();for(const t of catalog)for(const r of (await db.query(`SELECT DISTINCT workspace_id FROM "${t.table_schema}"."${t.table_name}"`)).rows)spaces.add(r.workspace_id);
   const protectedSpaces=new Set(['m1-main',...liveAccounts.map(a=>a.workspace_id),...runningSpaces]);
   const selection:Selection={workspaces:[...spaces].filter(s=>!protectedSpaces.has(s)&&isHistoricalTestWorkspace(s)).sort(),fixture_facts:true};
   await assertRetired(db,selection);phase='inventory';const rows=await inventory(db,selection),temporal=executions(selection);
   const manifest={at:new Date().toISOString(),schema:37,selection,rows,hash:inventoryHash(rows),live_accounts:liveAccounts,runtime_workspaces:runningSpaces,temporal,
    preserved_workspaces:[...spaces].filter(s=>!selection.workspaces.includes(s)).sort(),source_console_accounts_preserved:true};
   save('manifest',manifest);save('protected-before',await protectedState(db));await db.query('COMMIT');
   console.log(JSON.stringify({mode,workspaces:selection.workspaces.length,selected_rows:rows.reduce((n,r)=>n+r.rows,0),preserved_workspaces:manifest.preserved_workspaces,manifest_sha256:manifest.hash,temporal_matches:temporal.matching.length}));
  }else{
   const manifest=load('manifest'),selection=manifest.selection as Selection;
   assert.ok(selection.workspaces.length>0);
   assert.ok(selection.workspaces.every(s=>!liveAccounts.some(a=>a.workspace_id===s)&&!runningSpaces.includes(s)),'A retired workspace regained an account or workload');
   if(mode==='backup'){
    assert.ok(!existsSync(dir+'/source-before.dump'),'Backup is immutable');
    await assertRetired(db,selection);assert.equal(inventoryHash(await inventory(db,selection)),manifest.hash,'Manifest changed before backup');
    const snapshot=(await db.query('SELECT pg_export_snapshot() snapshot')).rows[0].snapshot;phase='dump';
    const p=spawn('kubectl',['-n','db','exec',primary(),'--','pg_dump','-U','postgres','-d','crawlsystem_m1_main_test','-Fc','--snapshot='+snapshot],{env,stdio:['ignore','pipe','pipe']});p.stderr.resume();
    const completed=once(p,'close');await pipeline(p.stdout,createWriteStream(dir+'/source-before.dump.partial',{mode:0o600}));const [code]=await completed;assert.equal(code,0,'Source backup failed');
    renameSync(dir+'/source-before.dump.partial',dir+'/source-before.dump');await db.query('COMMIT');
    const backup={at:new Date().toISOString(),bytes:statSync(dir+'/source-before.dump').size,sha256:await hashFile(dir+'/source-before.dump'),manifest_sha256:manifest.hash,consistent_snapshot:true};save('backup',backup);console.log(JSON.stringify({mode,...backup}));
   }else if(mode==='apply'){
    assert.ok(!existsSync(dir+'/cleanup.json'),'Cleanup already applied; use verify');const backup=load('backup');
    assert.equal(backup.manifest_sha256,manifest.hash);assert.equal(await hashFile(dir+'/source-before.dump'),backup.sha256);
    const temporal=executions(selection);phase='cleanup';await db.query("SELECT pg_advisory_xact_lock(hashtext('e3-historical-cleanup'))");
    const result=await cleanup(db,selection,manifest.hash);await db.query('COMMIT');
    save('cleanup',{at:new Date().toISOString(),workspaces:selection.workspaces.length,manifest_sha256:manifest.hash,backup_sha256:backup.sha256,temporal,...result});
    console.log(JSON.stringify({mode,workspaces:selection.workspaces.length,total_removed:result.total_removed,removed:result.removed}));
   }else{
    const before=load('protected-before'),after=await protectedState(db),rows=await inventory(db,selection);assert.ok(rows.every(r=>r.rows===0));
    assert.deepEqual(after.settings,before.settings);assert.deepEqual(after.schema,before.schema);assert.deepEqual(after.fixture_plans,before.fixture_plans);
    for(const name of ['videos','delivered','identities'] as const){const current=new Set(after[name].map((r:unknown)=>JSON.stringify(r)));assert.ok(before[name].every((r:unknown)=>current.has(JSON.stringify(r))),name+' identity removed');}
    const preview=await inventory(db,{workspaces:[],fixture_facts:false});assert.ok(preview.every(r=>r.rows===0));
    await db.query('COMMIT');const verified={at:new Date().toISOString(),result:'PASSED',selected_remaining:0,settings_preserved:true,migrations_preserved:true,fixture_plans_preserved:after.fixture_plans.length,
     real_videos_before:before.videos.length,real_videos_after:after.videos.length,delivered_before:before.delivered.length,delivered_after:after.delivered.length,recovery_identities_preserved:before.identities.length,accounts_preserved:liveAccounts};
    save('verified',verified);console.log(JSON.stringify(verified));
   }
  }
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}catch(error){console.error(JSON.stringify({result:'FAILED',phase,error:error instanceof Error?error.name:'UnknownError',code:(error as {code?:string}).code,guard:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined}));process.exitCode=1;}
finally{await pool.end();}
