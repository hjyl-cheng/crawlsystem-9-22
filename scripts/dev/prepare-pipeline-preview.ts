import { execFileSync,spawn } from 'node:child_process';
import { mkdirSync,existsSync,createWriteStream,renameSync,chmodSync } from 'node:fs';
import { createPool } from '@crawlsystem/store/config';
import { migrate } from '@crawlsystem/store/migrate';
const pool=createPool(),url=new URL(process.env.DATABASE_URL!),database=url.pathname.slice(1);
if(database!=='crawlsystem_m1_main_test')throw new Error('Pipeline cutover targets the existing preview database');
const kubectl=(args:string[])=>execFileSync('kubectl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const writers=[
  {namespace:'control',resource:'deployment/intent-dispatcher',label:'app.kubernetes.io/name=intent-dispatcher'},
  {namespace:'crawler',resource:'statefulset/execution-worker',label:'app.kubernetes.io/name=execution-worker'},
  {namespace:'ingest',resource:'deployment/ingest-preview',label:'app.kubernetes.io/name=ingest-preview'},
  {namespace:'control',resource:'deployment/control-api-preview',label:'app.kubernetes.io/name=control-api-preview'},
];
const stopped:({namespace:string;resource:string;replicas:string})[]=[];
try {
  const version=Number((await pool.query('SELECT max(version) AS version FROM m1.migrations')).rows[0].version);
  if(version>=20){await migrate(pool);console.log('Pipeline schema already current');process.exitCode=0;}
  else {
    // Frozen legacy workflows remain readable. Drain only an idle business workspace.
    const active=(await pool.query("SELECT count(*)::int AS n FROM m1.plans WHERE workspace_id='m1-main' AND status IN ('QUEUED','RUNNING','WAITING')")).rows[0].n;
    if(active)throw new Error('Finish active legacy business plans before switching their write path');
    mkdirSync('.runtime/r3',{recursive:true,mode:0o700});
    const backup='.runtime/r3/pre-r3.pg.dump';
    if(!existsSync(backup)) {
      const primary=kubectl(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']);
      await new Promise<void>((resolve,reject)=>{
        const child=spawn('kubectl',['-n','db','exec',primary,'--','pg_dump','-U','postgres','-Fc','-d',database],{stdio:['ignore','pipe','pipe']});
        const out=createWriteStream(backup+'.partial',{mode:0o600});child.stdout.pipe(out);child.stderr.resume();
        child.on('error',reject);child.on('exit',code=>{if(code!==0)reject(new Error('Preview backup failed'));else if(out.writableFinished)resolve();else out.once('finish',resolve);});out.on('error',reject);
      });
      renameSync(backup+'.partial',backup);chmodSync(backup,0o600);console.log('Existing preview data backed up before schema change');
    }
    for(const writer of writers) {
      const replicas=kubectl(['-n',writer.namespace,'get',writer.resource,'-o','jsonpath={.spec.replicas}']);
      kubectl(['-n',writer.namespace,'scale',writer.resource,'--replicas=0']);
      stopped.push({...writer,replicas});
    }
    for(const writer of writers) {
      if(kubectl(['-n',writer.namespace,'get','pods','-l',writer.label,'-o','name']))
        kubectl(['-n',writer.namespace,'wait','--for=delete','pods','-l',writer.label,'--timeout=120s']);
    }
    await migrate(pool);console.log('Pipeline schema applied; records retained');
  }
}catch(error){
  const version=Number((await pool.query('SELECT max(version) AS version FROM m1.migrations')).rows[0].version);
  if(version<20) {
    for(const writer of stopped)kubectl(['-n',writer.namespace,'scale',writer.resource,`--replicas=${writer.replicas}`]);
    console.log('Cutover stopped before schema change; previous service replica counts restored');
  }else console.log('Split schema retained; resume deployment with the prepared R3 images');
  throw error;
}finally{await pool.end();}
