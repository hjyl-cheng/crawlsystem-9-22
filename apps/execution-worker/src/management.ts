import type {WorkerControl} from '../../../packages/contracts/src/workers.ts';
/** Only acknowledged RUNNING controls permit the independent search loop to claim new work. */
export class WorkerAdmission {
 version=0;accepting=false;
 apply(control?:WorkerControl){
  if(!control||control.version<this.version)return;
  this.version=control.version;this.accepting=control.desired==='RUNNING';
 }
}
export class ProcessSampler {
 private at=performance.now();private cpu=process.cpuUsage();
 sample(){const now=performance.now(),next=process.cpuUsage(),elapsed=now-this.at;
  const cpu_cores=elapsed>=1?(next.user-this.cpu.user+next.system-this.cpu.system)/(elapsed*1000):null;
  this.at=now;this.cpu=next;return {cpu_cores,rss_bytes:process.memoryUsage().rss,sampled_at:new Date().toISOString()};
 }
}
