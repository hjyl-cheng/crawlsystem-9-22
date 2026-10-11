import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {createConnection} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
const connection=new URL(process.env.DATABASE_URL!);if(connection.pathname==='/crawlsystem_m1_main_test')throw new Error('Use the isolated integration database');
const log=createWriteStream('.runtime/d2/crash-tunnel.log',{mode:0o600});
// SIGKILL intentionally resets one database connection. Keep its port-forward separate
// from the suite and from the shared preview connection, without retrying assertions.
const forward=spawn('kubectl',['-n','db','port-forward','--address','127.0.0.1','service/crawler-pg-pool','15434:5432'],{env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['ignore','pipe','pipe']});
forward.stdout.pipe(log,{end:false});forward.stderr.pipe(log,{end:false});
const ready=()=>new Promise<boolean>(resolve=>{const socket=createConnection({host:'127.0.0.1',port:15434});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(1000,()=>{socket.destroy();resolve(false);});});
try{
 for(let i=0;i<30;i++){if(await ready())break;if(i===29)throw new Error('Isolated crash connection unavailable');await delay(1000);}
 connection.port='15434';
 const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1','tests/integration/main.test.ts','tests/integration/query-runs.test.ts','tests/integration/workers.test.ts'],{env:{...process.env,M1_CRASH_DATABASE_URL:connection.toString()},stdio:'inherit'});
 process.exitCode=await new Promise<number>(resolve=>child.once('exit',code=>resolve(code??1)));
}finally{forward.kill('SIGTERM');log.end();}
