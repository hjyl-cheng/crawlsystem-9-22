import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {Connection} from '@temporalio/client';
import {temporalOptions} from '../../apps/control-api/src/temporal-config.ts';
const kubectl=(args:string[])=>execFileSync('kubectl',args,{env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000});
const rows=JSON.parse(kubectl(['-n','db','exec','crawler-pg-1','--','psql','-U','postgres','-d','crawler','-Atc',`SELECT json_build_object(
  'role',(SELECT row_to_json(r) FROM (SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolconnlimit FROM pg_roles WHERE rolname='console_app')r),
  'schema_usage',has_schema_privilege('console_app','console','USAGE'),
  'schema_create',has_schema_privilege('console_app','console','CREATE'),
  'database_create',has_database_privilege('console_app','crawler','CREATE'),
  'accounts_select',has_table_privilege('console_app','console.accounts','SELECT'),
  'accounts_delete',has_table_privilege('console_app','console.accounts','DELETE'),
  'accounts_truncate',has_table_privilege('console_app','console.accounts','TRUNCATE'),
  'sessions_delete',has_table_privilege('console_app','console.sessions','DELETE'));`]).trim());
if(rows.role.rolsuper||rows.role.rolcreatedb||rows.role.rolcreaterole||rows.schema_create||rows.database_create||rows.accounts_delete||rows.accounts_truncate||!rows.schema_usage||!rows.accounts_select||!rows.sessions_delete)throw new Error('Console role privileges differ from expected scope');
const options=temporalOptions(),connection=await Connection.connect({address:options.address,tls:options.tls,connectTimeout:'10s'});
let crossNamespace:'ALLOWED'|'DENIED'|'NOT_FOUND';
try {
  await connection.withDeadline(Date.now()+10000,()=>connection.workflowService.describeNamespace({namespace:options.namespace}));
  try {await connection.withDeadline(Date.now()+10000,()=>connection.workflowService.describeNamespace({namespace:'default'}));crossNamespace='ALLOWED';}
  catch(error){const code=(error as {code?:number}).code;if(code===7||code===16)crossNamespace='DENIED';else if(code===5)crossNamespace='NOT_FOUND';else throw error;}
} finally {await connection.close();}
const deployment=JSON.parse(kubectl(['-n','control','get','deployment','control-api-preview','-o','json']));
const container=deployment.spec.template.spec.containers[0];
const poolLimits=Object.fromEntries(container.env.filter((e:{name:string})=>['PG_POOL_MAX','CONSOLE_PG_POOL_MAX'].includes(e.name)).map((e:{name:string;value:string})=>[e.name,Number(e.value)]));
const report={verified_at:new Date().toISOString(),console_database:rows,temporal:{namespace:options.namespace,mtls_connection:'passed',other_namespace_describe:crossNamespace,namespace_authorization:crossNamespace==='DENIED'?'describe denied; execution scope not yet verified':'not established',scope:'read-only namespace metadata probe; no workflow or permissions modified'},deployment:{image:container.image,replicas:deployment.spec.replicas,ready_replicas:deployment.status.readyReplicas,pool_limits:poolLimits,max_surge:deployment.spec.strategy.rollingUpdate.maxSurge}};
writeFileSync('docs/m1/reports/runtime-access.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
