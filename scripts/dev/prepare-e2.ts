import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync,createWriteStream,createReadStream,renameSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPool} from '@crawlsystem/store/config';
import {migrate} from '@crawlsystem/store/migrate';
const dir='.runtime/e2';mkdirSync(dir,{recursive:true,mode:0o700});
const pool=createPool(),workspace='m1-main',env={...process.env,K3S_CONFIG_FILE:'/dev/null',KUBECTL_REMOTE_COMMAND_WEBSOCKETS:'false'};
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try{
  const settings=(await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0];
  const schema=(await pool.query('SELECT max(version)::int n FROM m1.migrations')).rows[0].n;assert.ok([36,37].includes(schema));
  const previous=(await pool.query(`SELECT i.channel_id,i.state,i.plan_id,p.status,
    (SELECT data->>'error_code' FROM control.events e WHERE e.plan_id=i.plan_id AND data->>'kind'='FAILED' ORDER BY created_at DESC,event_id DESC LIMIT 1) code
    FROM control.channel_imports i LEFT JOIN control.plans p USING(plan_id) WHERE i.workspace_id=$1 AND i.state='failed' ORDER BY i.updated_at`,[workspace])).rows;
  if(!existsSync(dir+'/source-before.dump')){
    const primary=execFileSync('kubectl',['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}'],{encoding:'utf8',env,stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
    await new Promise<void>((resolve,reject)=>{
      const output=createWriteStream(dir+'/source-before.dump.partial',{mode:0o600}),p=spawn('kubectl',['-n','db','exec',primary,'--','pg_dump','-U','postgres','-d','crawlsystem_m1_main_test','-Fc'],{env,stdio:['ignore','pipe','pipe']});
      p.stdout.pipe(output);p.stderr.resume();let ended=false,finished=false;
      const done=()=>{if(ended&&finished){renameSync(dir+'/source-before.dump.partial',dir+'/source-before.dump');resolve();}};
      output.on('finish',()=>{finished=true;done();});output.on('error',reject);p.on('error',reject);p.on('exit',code=>{if(code!==0)reject(new Error('E2 source backup failed'));else{ended=true;done();}});
    });
  }
  const hash=createHash('sha256');for await(const chunk of createReadStream(dir+'/source-before.dump'))hash.update(chunk);
  await migrate(pool);
  assert.equal((await pool.query('SELECT max(version)::int n FROM m1.migrations')).rows[0].n,37);
  assert.deepEqual((await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0],settings);
  const failures=(await pool.query("SELECT channel_id,plan_id,last_failure_code,retry_at,retry_blocked_reason FROM control.channel_imports WHERE workspace_id=$1 AND state='failed' ORDER BY updated_at",[workspace])).rows;
  writeFileSync(dir+'/bootstrap.json',JSON.stringify({at:new Date().toISOString(),schema:37,settings_version:settings.version,configuration_preserved:true,backup_bytes:statSync(dir+'/source-before.dump').size,backup_sha256:hash.digest('hex'),previous,failures},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({schema:37,configuration_preserved:true,failed:failures.length,waiting:failures.filter(r=>r.retry_at).length}));
}catch(error){console.error('E2 preparation failed:',error instanceof Error?error.name:'UnknownError');process.exitCode=1;}
finally{await pool.end();}
