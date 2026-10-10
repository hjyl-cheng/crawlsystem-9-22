import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,createWriteStream,renameSync} from 'node:fs';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createPool} from '@crawlsystem/store/config';
import {migrate} from '@crawlsystem/store/migrate';
const mode=process.argv[2]??'test';assert.ok(['test','live'].includes(mode));
const dir='.runtime/c1';mkdirSync(dir,{recursive:true,mode:0o700});
const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],maxBuffer:16*1024*1024}).trim();
const primary=kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']);
const sql=(database:string,input:string)=>kube(['-n','db','exec','-i',primary,'--','psql','-X','-q','-tA','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],input);
function password(name:string){const path=`${dir}/${name}.password`;if(!existsSync(path)) {if(sql('postgres',`SELECT 1 FROM pg_roles WHERE rolname='${name}';`))throw new Error('Recover the existing C1 credential before reprovisioning');writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600});}return readFileSync(path,'utf8').trim();}
function role(name:string,replication=false){const p=password(name);sql('postgres',`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${name}') THEN CREATE ROLE ${name} LOGIN PASSWORD '${p}' NOSUPERUSER NOCREATEDB NOCREATEROLE ${replication?'REPLICATION':'NOREPLICATION'};END IF;END $$;`);return p;}
function business(database:string,user:string){
 const p=role(user);
 if(!sql('postgres',`SELECT 1 FROM pg_database WHERE datname='${database}';`)) {
  sql('postgres',`CREATE DATABASE ${database} OWNER ${user};`);
  sql(database,readFileSync('database/business/bootstrap.sql','utf8'));
 }
 const kind=sql(database,'SELECT database_kind FROM publication.database_identity');assert.equal(kind,'business');
 assert.equal(Number(sql(database,"SELECT count(*) FROM pg_tables WHERE schemaname IN ('public','publication','raw_crawler','result');")),64);
 sql(database,readFileSync('database/business/transport.sql','utf8'));
 sql(database,`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC;GRANT CONNECT ON DATABASE ${database} TO ${user};
 GRANT USAGE ON SCHEMA public,publication,result,raw_crawler,delivery_transport TO ${user};GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public,publication,result,delivery_transport TO ${user};GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public,publication,result TO ${user};`);
 const u=new URL(process.env.DATABASE_URL!);u.username=user;u.password=p;u.pathname='/'+database;return u.href;
}
function secret(ns:string,name:string,data:Record<string,string>){kube(['apply','-f','-'],JSON.stringify({apiVersion:'v1',kind:'Secret',metadata:{namespace:ns,name},type:'Opaque',stringData:data}));}
if(mode==='test') {
 const testDatabase=process.argv.includes('--fresh')?`crawlsystem_business_c1_test_${Date.now()}`:'crawlsystem_business_c1_test';
 const uri=business(testDatabase,'crawlsystem_c1_test');
 writeFileSync(`${dir}/test.env`,`BUSINESS_DATABASE_URL=${uri}\n`,{mode:0o600});
 console.log('C1 isolated test business database restored with 64 legacy tables');
}else {
 const pool=createPool();
 try {
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'crawlsystem_m1_main_test');
  if(!existsSync(`${dir}/preservation-before.json`))writeFileSync(`${dir}/preservation-before.json`,JSON.stringify({at:new Date().toISOString(),ids:(await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos ORDER BY 1,2,3')).rows}),{mode:0o600});
  if(!existsSync(`${dir}/pre-c1.pg.dump`)) {
   await new Promise<void>((resolve,reject)=>{const child=spawn('kubectl',['-n','db','exec',primary,'--','pg_dump','-U','postgres','-Fc','-d','crawlsystem_m1_main_test'],{stdio:['ignore','pipe','pipe']}),out=createWriteStream(`${dir}/pre-c1.pg.dump.partial`,{mode:0o600});child.stdout.pipe(out);child.stderr.resume();child.once('error',reject);out.once('error',reject);child.once('exit',code=>{if(code)reject(new Error('C1 backup failed'));else if(out.writableFinished)resolve();else out.once('finish',resolve);});});renameSync(`${dir}/pre-c1.pg.dump.partial`,`${dir}/pre-c1.pg.dump`);
  }
  await migrate(pool);
  const businessUri=business('crawlsystem_business_main','crawlsystem_c1_business');
  const cdcPassword=role('crawlsystem_c1_cdc',true),receiptPassword=role('crawlsystem_c1_receipts');
  const sourceUri=new URL(process.env.DATABASE_URL!),sourceDb=sourceUri.pathname.slice(1);
  assert.match(sourceDb,/^crawlsystem_m1_main_test$/);
  const apiSecret=JSON.parse(kube(['-n','control','get','secret','control-api-preview','-o','json'])).data;
  const controlUser=new URL(Buffer.from(apiSecret['database-url'],'base64').toString()).username;assert.match(controlUser,/^[a-z0-9_]+$/);
  sql(sourceDb,`GRANT USAGE ON SCHEMA delivery TO ${controlUser},crawlsystem_c1_cdc,crawlsystem_c1_receipts;
   GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA delivery TO ${controlUser};
   GRANT CONNECT ON DATABASE ${sourceDb} TO crawlsystem_c1_cdc,crawlsystem_c1_receipts;
   GRANT SELECT ON delivery.outbox TO crawlsystem_c1_cdc;
   GRANT INSERT,UPDATE,SELECT ON delivery.heartbeat TO crawlsystem_c1_cdc;
   GRANT SELECT ON delivery.targets TO crawlsystem_c1_receipts;GRANT SELECT,UPDATE ON delivery.records TO crawlsystem_c1_receipts;
   GRANT USAGE ON SCHEMA control TO crawlsystem_c1_receipts;GRANT SELECT(plan_id),UPDATE(publication_status) ON control.plans TO crawlsystem_c1_receipts;
   GRANT EXECUTE ON FUNCTION delivery.cleanup_outbox(integer) TO ${controlUser},crawlsystem_c1_receipts;`);
  if(!sql(sourceDb,"SELECT 1 FROM pg_publication WHERE pubname='c1_publication';"))sql(sourceDb,'CREATE PUBLICATION c1_publication FOR TABLE delivery.outbox,delivery.heartbeat;');
  let t=(await pool.query("SELECT stream_id FROM delivery.targets WHERE workspace_id='m1-main'")).rows[0];
  if(!t){const id=randomUUID();await pool.query("INSERT INTO delivery.targets(workspace_id,stream_id,name) VALUES('m1-main',$1,'业务库（旧服务器结构）')",[id]);t={stream_id:id};}
  sql('crawlsystem_business_main',`INSERT INTO publication.stream(publication_stream_id,source_deployment_key,source_identity_json,status,accepted_contract_versions,automatic_onboarding_projection_mode,registered_by,registered_reason,status_changed_by,status_reason) VALUES('${t.stream_id}','crawlsystem-new-main','{"system":"crawlsystem-new"}','active',ARRAY[1,2],'online','c1-deployment','new collector stream using legacy business schema','c1-deployment','automatic onboarding enabled') ON CONFLICT(publication_stream_id) DO NOTHING;`);
  const ca=readFileSync(process.env.PG_CA_FILE!,'utf8');
  const clusterBusiness=new URL(businessUri);clusterBusiness.hostname='crawler-pg-pool.db.svc.cluster.local';clusterBusiness.port='5432';
  secret('ingest','c1-business-db',{'database-url':clusterBusiness.href,'pg-ca.crt':ca});
  sourceUri.username='crawlsystem_c1_receipts';sourceUri.password=receiptPassword;
  sourceUri.hostname='crawler-pg-pool.db.svc.cluster.local';sourceUri.port='5432';
  secret('control','c1-receipts-db',{'database-url':sourceUri.href,'pg-ca.crt':ca});
  secret('kafka','c1-cdc-pg',{'credentials.properties':`password=${cdcPassword}\n`});
  writeFileSync(`${dir}/business.env`,`BUSINESS_DATABASE_URL=${businessUri}\n`,{mode:0o600});
  writeFileSync(`${dir}/prepared.json`,JSON.stringify({at:new Date().toISOString(),stream_id:t.stream_id,business_database:'crawlsystem_business_main',business_tables:64,schema_version:31,backup_sha256:createHash('sha256').update(readFileSync(`${dir}/pre-c1.pg.dump`)).digest('hex')}),{mode:0o600});
  console.log('C1 live database, scoped roles and disabled publication target prepared; no existing database reset');
 }finally{await pool.end();}
}
