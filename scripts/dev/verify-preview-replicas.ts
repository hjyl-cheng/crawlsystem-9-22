import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {PlansSummarySchema,CompletenessSchema,SessionSchema,ChannelListItemSchema,pageSchema} from '@crawlsystem/contracts';
const kubectl=(...args:string[])=>JSON.parse(execFileSync('kubectl',args,{env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}));
const service=kubectl('-n','control','get','service','control-api-preview','-o','json');
const base=`http://${service.spec.clusterIP}:18100`;
const stateFile='.runtime/preview-verification-session.json';
const call=async(url:string,options:RequestInit={})=>fetch(url,{...options,signal:AbortSignal.timeout(10000)});
if(process.argv[2]==='capture'){
  const path=process.env.CONSOLE_VERIFY_CREDENTIALS_FILE;if(!path)throw new Error('CONSOLE_VERIFY_CREDENTIALS_FILE is required');
  const credentials=JSON.parse(readFileSync(path,'utf8'));
  const response=await call(base+'/v1/auth/login',{method:'POST',headers:{'content-type':'application/json','x-console-request':'1'},body:JSON.stringify(credentials)});
  assert.equal(response.status,200,'preview login status');const principal=SessionSchema.parse(await response.json());
  const cookie=response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  writeFileSync(stateFile,JSON.stringify({cookie,subject:principal.subject,role:principal.role,workspace_id:principal.workspace_id}),{mode:0o600});chmodSync(stateFile,0o600);
  console.log(JSON.stringify({captured:true,role:principal.role,scope:'Cookie stored in ignored private file for rollout check'}));
} else {
  if(!existsSync(stateFile))throw new Error('Capture a session before rollout');
  const state=JSON.parse(readFileSync(stateFile,'utf8'));
  const pods=kubectl('-n','control','get','pods','-l','app.kubernetes.io/name=control-api-preview','-o','json').items.filter((p:any)=>!p.metadata.deletionTimestamp&&p.status.conditions?.some((c:any)=>c.type==='Ready'&&c.status==='True'));
  assert.equal(pods.length,2);const urls=pods.map((p:any)=>`http://${p.status.podIP}:18100`);
  const expected=process.env.EXPECTED_BUILD;if(!expected)throw new Error('EXPECTED_BUILD is required');
  const traceId=randomBytes(16).toString('hex');
  const headers={cookie:state.cookie,traceparent:`00-${traceId}-${randomBytes(8).toString('hex')}-01`};
  for(const url of urls){
    assert.equal((await call(url+'/readyz')).status,200);
    const health=await (await call(url+'/healthz')).json() as {build_version:string};assert.equal(health.build_version,expected);
    const restored=await call(url+'/v1/session',{headers});assert.equal(restored.status,200);assert.equal(SessionSchema.parse(await restored.json()).subject,state.subject);assert.match(restored.headers.get('traceparent')??'',new RegExp(`^00-${traceId}-`));
    for(const [path,schema] of [['/v1/overview/plans',PlansSummarySchema],['/v1/overview/completeness',CompletenessSchema],['/v1/channels',pageSchema(ChannelListItemSchema)]] as const){const result=await call(url+path,{headers});assert.equal(result.status,200);schema.parse(await result.json());}
    if(state.role==='reader'){const denied=await call(url+'/v1/plans',{method:'POST',headers:{...headers,'content-type':'application/json','x-console-request':'1'},body:JSON.stringify({request_id:randomUUID(),fixture_id:'channel-basic-v1'})});assert.equal(denied.status,403);}
    const metrics=await call(url+'/metrics');assert.equal(metrics.status,200);assert.match(await metrics.text(),/m1_receipts\{state="APPLIED"\}/);
  }
  const probe=`limit-${randomUUID()}`;
  for(let i=0;i<11;i++){
    const response=await call(urls[i%2]+'/v1/auth/login',{method:'POST',headers:{'content-type':'application/json','x-console-request':'1'},body:JSON.stringify({username:probe,password:'intentionally-incorrect-test-password'})});
    assert.equal(response.status,i<10?401:429,`shared budget attempt ${i+1}`);if(i===10)assert.equal(response.headers.get('retry-after'),'60');
  }
  const logout=await call(urls[0]+'/v1/auth/logout',{method:'POST',headers:{...headers,'content-type':'application/json','x-console-request':'1'},body:'{}'});assert.equal(logout.status,200);
  assert.equal((await call(urls[1]+'/v1/session',{headers})).status,401);
  const report={verified_at:new Date().toISOString(),build:expected,replicas:pods.map((p:any)=>({pod:p.metadata.name,node:p.spec.nodeName})),same_cookie_after_rollout:'passed',shared_login_budget:'passed',logout_other_replica_status:401,reader_write_denied:state.role==='reader',api_schemas:'passed',business_metrics:'passed',trace_id:traceId};
  writeFileSync('docs/m1/reports/preview-replicas.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
