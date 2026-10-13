import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync,createWriteStream,renameSync} from 'node:fs';
import {createPool} from '@crawlsystem/store/config';
import {migrate} from '@crawlsystem/store/migrate';
import {updateLimits,discoveryLimits} from '../../apps/control-api/src/update-config.ts';
import {defaultSettings,RuntimeSettingsSchema} from '../../packages/contracts/src/configuration.ts';
const dir='.runtime/d1';mkdirSync(dir,{recursive:true,mode:0o700});
const kube=(a:string[],input?:string)=>execFileSync('kubectl',a,{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],timeout:30000,maxBuffer:16*1024*1024});
const env=(name:string)=>Object.fromEntries(JSON.parse(kube(['-n','control','get','deployment',name,'-o','json'])).spec.template.spec.containers.flatMap((c:any)=>c.env??[]).filter((e:any)=>e.name.startsWith('UPDATE_')||e.name.startsWith('QUERY_')).map((e:any)=>{assert.equal(typeof e.value,'string');return [e.name,e.value];}));
const api=env('control-api-preview'),dispatch=env('intent-dispatcher');
const settings=RuntimeSettingsSchema.parse({...defaultSettings(),update:updateLimits(api),discovery:discoveryLimits(api)});
assert.deepEqual(settings.update,updateLimits(dispatch));assert.deepEqual(settings.discovery,discoveryLimits(dispatch));
assert.equal(settings.update.enabled,true);assert.equal(settings.discovery.enabled,true);assert.equal(settings.discovery.auto_admit,true);
const pool=createPool();assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
const primary=kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']).trim();
try{
 if(!existsSync(dir+'/source-before.dump'))await new Promise<void>((resolve,reject)=>{
  const output=createWriteStream(dir+'/source-before.dump.partial',{mode:0o600}),p=spawn('kubectl',['-n','db','exec',primary,'--','pg_dump','-U','postgres','-d','crawlsystem_m1_main_test','-Fc'],{stdio:['ignore','pipe','pipe']});
  p.stdout.pipe(output);p.stderr.resume();let ended=false,finished=false;
  const done=()=>{if(ended&&finished){renameSync(dir+'/source-before.dump.partial',dir+'/source-before.dump');resolve();}};output.on('finish',()=>{finished=true;done();});output.on('error',reject);p.on('error',reject);p.on('exit',code=>{if(code!==0)reject(new Error('D1 database backup failed'));else{ended=true;done();}});
 });
 await migrate(pool);
 const secret=JSON.parse(kube(['-n','control','get','secret','control-api-preview','-o','json']));
 const user=new URL(Buffer.from(secret.data['database-url'],'base64').toString()).username;assert.match(user,/^[a-z0-9_]+$/);
 kube(['-n','db','exec','-i',primary,'--','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','crawlsystem_m1_main_test'],
  `GRANT SELECT,INSERT,UPDATE ON control.runtime_settings,control.runtime_settings_consumers TO ${user};GRANT SELECT,INSERT ON control.runtime_settings_history TO ${user};`);
 await pool.query(`INSERT INTO control.runtime_settings(workspace_id,version,settings,operator) VALUES('m1-main',1,$1,'deployment-bootstrap') ON CONFLICT DO NOTHING`,[settings]);
 const current=(await pool.query("SELECT version,settings FROM control.runtime_settings WHERE workspace_id='m1-main'")).rows[0];
 assert.deepEqual(current.settings,settings,'Existing configuration must be preserved');
 writeFileSync(dir+'/bootstrap.json',JSON.stringify({at:new Date().toISOString(),version:current.version,settings,source_database:'crawlsystem_m1_main_test',schema:32},null,2),{mode:0o600});
 console.log('D1 schema 32 and least-privilege grants ready; existing runtime values persisted');
}catch(e){console.error('D1 preparation failed:',e instanceof Error?e.name:'UnknownError');process.exitCode=1;}finally{await pool.end();}
