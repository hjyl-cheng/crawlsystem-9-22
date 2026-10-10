import {execFileSync,spawn} from 'node:child_process';
import {createWriteStream,mkdirSync,renameSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPool} from '@crawlsystem/store/config';
const pool=createPool(),directory='.runtime/r5';
mkdirSync(directory,{recursive:true,mode:0o700});
try {
  if((await pool.query('SELECT current_database() AS name')).rows[0].name!=='crawlsystem_m1_main_test')throw new Error('Wrong preservation database');
  const path=directory+'/preservation-before.json';
  if(!existsSync(path)) {
    const ids=(await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos ORDER BY 1,2,3')).rows;
    const counts=(await pool.query(`SELECT count(*)::int AS videos,count(*) FILTER(WHERE data->'comments_first_page' IS NOT NULL AND data->'comments_first_page'<>'null'::jsonb)::int AS comment_bodies,count(*) FILTER(WHERE data->'comments_ref' IS NOT NULL AND data->'comments_ref'<>'null'::jsonb)::int AS comment_refs FROM crawl_data.videos`)).rows[0];
    writeFileSync(path,JSON.stringify({at:new Date().toISOString(),ids,counts}),{mode:0o600});
  }
  const backup=directory+'/pre-r5.pg.dump';
  if(!existsSync(backup)) {
    const pod=execFileSync('kubectl',['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    await new Promise<void>((resolve,reject)=>{
      const child=spawn('kubectl',['-n','db','exec',pod,'--','pg_dump','-U','postgres','-Fc','-d','crawlsystem_m1_main_test'],{stdio:['ignore','pipe','pipe']});
      const stream=createWriteStream(backup+'.partial',{mode:0o600});child.stdout.pipe(stream);child.stderr.resume();
      child.once('error',reject);stream.once('error',reject);child.once('exit',code=>{if(code)reject(new Error('Backup failed'));else if(stream.writableFinished)resolve();else stream.once('finish',resolve);});
    });renameSync(backup+'.partial',backup);
  }
  const bytes=readFileSync(backup),before=JSON.parse(readFileSync(path,'utf8'));
  console.log(JSON.stringify({baseline:before.counts,backup_bytes:bytes.length,backup_sha256:createHash('sha256').update(bytes).digest('hex')}));
}finally{await pool.end();}
