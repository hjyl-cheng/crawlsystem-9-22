import {execFileSync} from 'node:child_process';
import {ClickHouse} from '../../apps/control-api/src/analytics.ts';
const kube=(args:string[])=>execFileSync('kubectl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export function r5ClickHouse() {
 const data=JSON.parse(kube(['-n','analytics','get','secret','clickhouse-r5','-o','json'])).data as Record<string,string>;
 const decode=(name:string)=>Buffer.from(data[name]!,'base64').toString();
 return new ClickHouse({url:process.env.CLICKHOUSE_PREVIEW_URL??'https://127.0.0.1:18443',user:decode('username'),password:decode('password'),ca:decode('ca.crt'),servername:'clickhouse.analytics.svc.cluster.local'});
}
