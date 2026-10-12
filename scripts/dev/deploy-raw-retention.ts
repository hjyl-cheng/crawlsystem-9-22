import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createReadStream,existsSync,writeFileSync} from 'node:fs';
import {createPool} from '@crawlsystem/store/config';
import {migrate} from '@crawlsystem/store/migrate';
import {dir,kube,object,save,load,workspace,client} from './raw-retention-common.ts';
const mode=process.argv[2],pool=createPool(),git=(...a:string[])=>execFileSync('git',a,{encoding:'utf8'}).trim();
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try {
 if(mode==='prepare') {
  if(!existsSync(dir+'/before.json')) {
   const {api}=await client();
   const settings=(await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0];
   const signatures=(await pool.query(`SELECT table_schema,table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
     WHERE table_schema IN ('control','crawl_data') ORDER BY 1,2,ordinal_position`)).rows;
   const counts=(await pool.query(`SELECT (SELECT count(*)::int FROM crawl_data.channels WHERE workspace_id=$1) channels,
     (SELECT count(*)::int FROM crawl_data.videos WHERE workspace_id=$1) videos,(SELECT count(*)::int FROM crawl_data.ingest_units WHERE workspace_id=$1) units`,[workspace])).rows[0];
   const sample=(await pool.query(`SELECT u.plan_id,u.execution_epoch,u.step,u.unit_id,u.raw_key,u.raw_hash,u.fact_hash,u.fact->'raw' raw,u.fact->'parsed' parsed,
     u.fact->'payload'->'comments_ref' comments FROM crawl_data.ingest_units u JOIN control.plans p USING(plan_id)
     WHERE u.workspace_id=$1 AND p.status='COMPLETED' AND p.finished_at<clock_timestamp()-interval '24 hours' AND u.fact ? 'kind'
     ORDER BY (u.fact->'payload'->'comments_ref' IS NOT NULL AND u.fact->'payload'->'comments_ref'<>'null'::jsonb) DESC,u.applied_at LIMIT 20`,[workspace])).rows;
   const protectedRefs=(await pool.query(`SELECT coalesce(raw,raw_object) ref FROM control.failures WHERE workspace_id=$1 AND coalesce(raw,raw_object) IS NOT NULL LIMIT 5`,[workspace])).rows;
   const primary=kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']);
   writeFileSync(dir+'/schema-before.sql',kube(['-n','db','exec',primary,'--','pg_dump','-U','postgres','-d','crawlsystem_m1_main_test','--schema-only'],undefined,60000),{mode:0o600});
   save('before',{at:new Date().toISOString(),settings,signatures,counts,sample,protected_refs:protectedRefs.map(r=>r.ref),capacity:await api('/v1/storage/capacity'),migrations:(await pool.query('SELECT version,checksum FROM m1.migrations ORDER BY version')).rows});
   for(const [ns,name] of [['control','control-api-preview'],['analytics','crawl-analytics']])save('previous-'+name,object(['-n',ns!,'get','deployment',name!]));
  }
  await migrate(pool);
  assert.equal((await pool.query('SELECT max(version)::int n FROM m1.migrations')).rows[0].n,40);
  const before=load('before');assert.deepEqual((await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0],before.settings);
  assert.deepEqual((await pool.query(`SELECT table_schema,table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
     WHERE table_schema IN ('control','crawl_data') ORDER BY 1,2,ordinal_position`)).rows,before.signatures);
  save('migration',{at:new Date().toISOString(),schema:40,business_and_control_tables_preserved:true});console.log(JSON.stringify({schema:40,source_counts:before.counts,only_added_telemetry_table:true}));
 }else if(mode==='import') {
  assert.equal(git('status','--porcelain'),'');const build=load('latest-control-image');assert.equal(build.revision,git('rev-parse','HEAD'));
  for(const node of ['a1','a2','a3','s1','s2','s3']) {
   const command=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh','crawl-'+node,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
   await new Promise<void>((resolve,reject)=>{const p=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']}),input=createReadStream(build.control.tarball);input.on('error',reject);p.stdin.on('error',()=>{input.destroy();reject(new Error('Image import closed'));});p.stderr.resume();input.pipe(p.stdin);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('Retention image import failed')));});
  }
  save('imported',{revision:build.revision,at:new Date().toISOString()});console.log('Retention image imported on all nodes');
 }else if(mode==='control'||mode==='analytics'||mode==='enable'||mode==='disable') {
  const build=load('latest-control-image');assert.equal(build.revision,load('imported').revision);
  const ns=mode==='control'?'control':'analytics',name=mode==='control'?'control-api-preview':'crawl-analytics';
  const container:any=mode==='control'?{name:'control-api',image:build.control.image}:mode==='analytics'?{name:'analytics',image:build.control.image,
    env:[{name:'RAW_RETENTION_ENABLED',value:'false'},{name:'RAW_RETENTION_CREDENTIALS_DIRECTORY',value:'/retention'}],volumeMounts:[{name:'retention',mountPath:'/retention',readOnly:true}]}:
    {name:'analytics',env:[{name:'RAW_RETENTION_ENABLED',value:mode==='enable'?'true':'false'}]};
  const spec:any={containers:[container]};if(mode==='analytics')spec.volumes=[{name:'retention',secret:{secretName:'minio-raw-retention',defaultMode:288}}];
  const patch=JSON.stringify({spec:{template:{spec}}});
  kube(['-n',ns,'patch','deployment/'+name,'--type=strategic','--dry-run=server','-p',patch]);
  kube(['-n',ns,'patch','deployment/'+name,'--type=strategic','-p',patch]);
  kube(['-n',ns,'rollout','status','deployment/'+name,'--timeout=180s'],undefined,190000);
  save('deployment-'+mode,{at:new Date().toISOString(),image:build.control.image,namespace:ns,name});console.log(JSON.stringify({phase:mode,result:'READY'}));
 }else throw new Error('Usage: deploy-raw-retention prepare|import|control|analytics|enable|disable');
}catch(error) {save('deployment-failure',{phase:mode,error:error instanceof Error?error.name:'UnknownError'});console.error(JSON.stringify({phase:mode,result:'FAILED',error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;}
finally {await pool.end();}
