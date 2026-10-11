import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dir='.runtime/d3';mkdirSync(dir,{recursive:true,mode:0o700});
const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['pipe','pipe','pipe'],timeout:30000,maxBuffer:16*1024*1024});
try{
  const primary=kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']).trim();assert.ok(primary);
  const secret=JSON.parse(kube(['-n','control','get','secret','control-api-preview','-o','json']));
  const url=new URL(Buffer.from(secret.data['console-database-url'],'base64').toString());assert.equal(url.pathname,'/crawler');
  const role=url.username;assert.equal(role,'console_app');
  const psql=(sql:string)=>kube(['-n','db','exec','-i',primary,'--','psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-U','postgres','-d','crawler'],sql).trim();
  if(!existsSync(dir+'/console-before.sql'))writeFileSync(dir+'/console-before.sql',kube(['-n','db','exec',primary,'--','pg_dump','-U','postgres','-d','crawler','-n','console']),{mode:0o600});
  const sql=readFileSync('database/console/002_audit.sql','utf8');
  if(psql("SELECT to_regclass('console.audit') IS NULL")==='t')psql('BEGIN;SET LOCAL ROLE crawler_owner;'+sql+'COMMIT;');
  assert.equal(psql("SELECT count(*) FROM console.audit_installation"),'1');
  assert.equal(psql("SELECT has_table_privilege('console_app','console.audit','SELECT') AND has_table_privilege('console_app','console.audit','INSERT') AND has_column_privilege('console_app','console.audit','outcome','UPDATE') AND NOT has_column_privilege('console_app','console.audit','actor','UPDATE') AND NOT has_table_privilege('console_app','console.audit','DELETE')"),'t');
  writeFileSync(dir+'/bootstrap.json',JSON.stringify({at:new Date().toISOString(),database:'crawler',schema:'console',migration:2,migration_sha256:createHash('sha256').update(sql).digest('hex'),backup_sha256:createHash('sha256').update(readFileSync(dir+'/console-before.sql')).digest('hex'),audit_history_since:psql("SELECT to_char(installed_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM console.audit_installation"),least_privilege:true},null,2),{mode:0o600});
  console.log('D3 console backup, additive audit tables and least-privilege grants ready');
}catch(error){console.error('D3 preparation failed:',error instanceof Error?error.name:'UnknownError');process.exitCode=1;}
