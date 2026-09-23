import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

// Local development only: kube port-forward can exit after an individual TCP reset.
// Keep existing credentials/configuration; no cluster resource is created or changed.
const port=Number(process.argv[2] ?? '15432');
if(![15432,15433].includes(port))throw new Error('Use reserved M1 PG port 15432 or 15433');
let stopping=false,child:ReturnType<typeof spawn>|undefined;
const stop=()=>{stopping=true;child?.kill('SIGTERM');};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
while(!stopping) {
  child=spawn('kubectl',['-n','db','port-forward','--address','127.0.0.1','service/crawler-pg-pool',`${port}:5432`],{env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['ignore','inherit','inherit']});
  const code=await new Promise<number|null>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',resolve);});
  if(!stopping){process.stderr.write(`PG development tunnel ${port} exited (${code}); reconnecting in 1s\n`);await setTimeout(1000);}
}
