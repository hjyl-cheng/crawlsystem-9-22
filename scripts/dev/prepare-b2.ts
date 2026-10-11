import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync,createWriteStream,renameSync,statSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPool} from '@crawlsystem/store/config';
import {migrate} from '@crawlsystem/store/migrate';
const dir='.runtime/b2';mkdirSync(dir,{recursive:true,mode:0o700});
const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['pipe','pipe','pipe'],timeout:30000,maxBuffer:16*1024*1024});
const pool=createPool();assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try{
  const primary=kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']).trim();
  const settings=(await pool.query("SELECT version,settings FROM control.runtime_settings WHERE workspace_id='m1-main'")).rows[0];
  if(!existsSync(dir+'/source-before.dump'))await new Promise<void>((resolve,reject)=>{
    const output=createWriteStream(dir+'/source-before.dump.partial',{mode:0o600});
    const p=spawn('kubectl',['-n','db','exec',primary,'--','pg_dump','-U','postgres','-d','crawlsystem_m1_main_test','-Fc'],{env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['ignore','pipe','pipe']});
    p.stdout.pipe(output);p.stderr.resume();let ended=false,finished=false;
    const done=()=>{if(ended&&finished){renameSync(dir+'/source-before.dump.partial',dir+'/source-before.dump');resolve();}};
    output.on('finish',()=>{finished=true;done();});output.on('error',reject);p.on('error',reject);p.on('exit',code=>{if(code!==0)reject(new Error('B2 database backup failed'));else{ended=true;done();}});
  });
  await migrate(pool);
  const users=new Set<string>();
  for(const name of ['control-api-preview','intent-dispatcher']){
    const deploy=JSON.parse(kube(['-n','control','get','deployment',name,'-o','json']));
    const ref=deploy.spec.template.spec.containers.flatMap((c:any)=>c.env??[]).find((e:any)=>e.name==='DATABASE_URL').valueFrom.secretKeyRef;
    const secret=JSON.parse(kube(['-n','control','get','secret',ref.name,'-o','json']));
    const user=new URL(Buffer.from(secret.data[ref.key],'base64').toString()).username;assert.match(user,/^[a-z0-9_]+$/);users.add(user);
  }
  for(const user of users)kube(['-n','db','exec','-i',primary,'--','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','crawlsystem_m1_main_test'],
    `GRANT SELECT,INSERT,UPDATE,DELETE ON control.query_collection_scans,control.query_collection_candidates,control.query_collection_evidence,control.query_collection_days TO ${user};`);
  assert.deepEqual((await pool.query("SELECT version,settings FROM control.runtime_settings WHERE workspace_id='m1-main'")).rows[0],settings);
  const schema=(await pool.query('SELECT max(version)::int version FROM m1.migrations')).rows[0].version;assert.equal(schema,36);
  writeFileSync(dir+'/bootstrap.json',JSON.stringify({at:new Date().toISOString(),source_database:'crawlsystem_m1_main_test',schema,configuration_version:settings.version,existing_configuration_preserved:true,backup_bytes:statSync(dir+'/source-before.dump').size,backup_sha256:createHash('sha256').update(readFileSync(dir+'/source-before.dump')).digest('hex')},null,2),{mode:0o600});
  console.log('B2 backup, schema 36 and Control/dispatcher grants ready; existing settings preserved');
}catch(error){console.error('B2 preparation failed:',error instanceof Error?error.name:'UnknownError');process.exitCode=1;}
finally{await pool.end();}
