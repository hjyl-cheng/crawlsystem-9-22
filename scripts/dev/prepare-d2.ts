import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync,createWriteStream,renameSync,statSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPool} from '@crawlsystem/store/config';
import {migrate} from '@crawlsystem/store/migrate';
const dir='.runtime/d2';mkdirSync(dir,{recursive:true,mode:0o700});
const kube=(a:string[],input?:string)=>execFileSync('kubectl',a,{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],timeout:30000,maxBuffer:16*1024*1024});
const pool=createPool();assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
const primary=kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']).trim();
try{
 const settings=(await pool.query("SELECT version,settings FROM control.runtime_settings WHERE workspace_id='m1-main'")).rows[0];
 if(!existsSync(dir+'/source-before.dump'))await new Promise<void>((resolve,reject)=>{
  const output=createWriteStream(dir+'/source-before.dump.partial',{mode:0o600}),p=spawn('kubectl',['-n','db','exec',primary,'--','pg_dump','-U','postgres','-d','crawlsystem_m1_main_test','-Fc'],{stdio:['ignore','pipe','pipe']});
  p.stdout.pipe(output);p.stderr.resume();let ended=false,finished=false;
  const done=()=>{if(ended&&finished){renameSync(dir+'/source-before.dump.partial',dir+'/source-before.dump');resolve();}};
  output.on('finish',()=>{finished=true;done();});output.on('error',reject);p.on('error',reject);p.on('exit',code=>{if(code!==0)reject(new Error('D2 database backup failed'));else{ended=true;done();}});
 });
 await migrate(pool);
 const secret=JSON.parse(kube(['-n','control','get','secret','control-api-preview','-o','json']));
 const user=new URL(Buffer.from(secret.data['database-url'],'base64').toString()).username;assert.match(user,/^[a-z0-9_]+$/);
 kube(['-n','db','exec','-i',primary,'--','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','crawlsystem_m1_main_test'],
  `GRANT SELECT,INSERT ON control.worker_routing,control.worker_commands TO ${user};GRANT SELECT,INSERT,UPDATE ON control.worker_plans TO ${user};GRANT SELECT,INSERT,DELETE ON control.worker_samples TO ${user};`);
 assert.deepEqual((await pool.query("SELECT version,settings FROM control.runtime_settings WHERE workspace_id='m1-main'")).rows[0],settings);
 writeFileSync(dir+'/bootstrap.json',JSON.stringify({at:new Date().toISOString(),source_database:'crawlsystem_m1_main_test',schema:34,configuration_version:settings.version,backup_bytes:statSync(dir+'/source-before.dump').size,backup_sha256:createHash('sha256').update(readFileSync(dir+'/source-before.dump')).digest('hex')},null,2),{mode:0o600});
 console.log('D2 backup, schema 34 and least-privilege grants ready; runtime settings preserved');
}catch(e){console.error('D2 preparation failed:',e instanceof Error?e.name:'UnknownError');process.exitCode=1;}finally{await pool.end();}
