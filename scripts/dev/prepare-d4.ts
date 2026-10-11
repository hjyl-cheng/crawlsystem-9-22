import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync,createWriteStream,renameSync,statSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPool} from '@crawlsystem/store/config';
import {migrate} from '@crawlsystem/store/migrate';
const dir='.runtime/d4';mkdirSync(dir,{recursive:true,mode:0o700});
const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['pipe','pipe','pipe'],timeout:30000,maxBuffer:16*1024*1024});
const pool=createPool();assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try{
  const primary=kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']).trim();
  const settings=(await pool.query("SELECT version,settings FROM control.runtime_settings WHERE workspace_id='m1-main'")).rows[0];
  const policies=async()=>(await pool.query(`SELECT source_id,protocol,provider,group_name,interval_minutes,retire_after_misses,server_ids,enabled FROM control.proxy_sources WHERE workspace_id='m1-main' ORDER BY source_id`)).rows;
  const previousPolicies=await policies();
  if(!existsSync(dir+'/source-before.dump'))await new Promise<void>((resolve,reject)=>{
    const output=createWriteStream(dir+'/source-before.dump.partial',{mode:0o600});
    const p=spawn('kubectl',['-n','db','exec',primary,'--','pg_dump','-U','postgres','-d','crawlsystem_m1_main_test','-Fc'],{env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['ignore','pipe','pipe']});
    p.stdout.pipe(output);p.stderr.resume();let ended=false,finished=false;
    const done=()=>{if(ended&&finished){renameSync(dir+'/source-before.dump.partial',dir+'/source-before.dump');resolve();}};
    output.on('finish',()=>{finished=true;done();});output.on('error',reject);p.on('error',reject);p.on('exit',code=>{if(code!==0)reject(new Error('D4 database backup failed'));else{ended=true;done();}});
  });
  await migrate(pool);
  const secret=JSON.parse(kube(['-n','control','get','secret','control-api-preview','-o','json']));
  const user=new URL(Buffer.from(secret.data['database-url'],'base64').toString()).username;assert.match(user,/^[a-z0-9_]+$/);
  kube(['-n','db','exec','-i',primary,'--','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','crawlsystem_m1_main_test'],
    `GRANT SELECT ON control.proxy_availability_recording TO ${user};GRANT SELECT,INSERT,UPDATE,DELETE ON control.proxy_observation_streams,control.proxy_availability_hourly TO ${user};`);
  assert.deepEqual((await pool.query("SELECT version,settings FROM control.runtime_settings WHERE workspace_id='m1-main'")).rows[0],settings);
  assert.deepEqual(await policies(),previousPolicies);
  const schema=(await pool.query('SELECT max(version)::int version FROM m1.migrations')).rows[0].version;assert.equal(schema,35);
  writeFileSync(dir+'/bootstrap.json',JSON.stringify({at:new Date().toISOString(),source_database:'crawlsystem_m1_main_test',schema,configuration_version:settings.version,proxy_policies_preserved:true,backup_bytes:statSync(dir+'/source-before.dump').size,backup_sha256:createHash('sha256').update(readFileSync(dir+'/source-before.dump')).digest('hex')},null,2),{mode:0o600});
  console.log('D4 backup, schema 35 and least-privilege grants ready; configuration and proxy policies preserved');
}catch(error){console.error('D4 preparation failed:',error instanceof Error?error.name:'UnknownError');process.exitCode=1;}
finally{await pool.end();}
