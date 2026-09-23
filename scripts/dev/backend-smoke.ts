import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PlanSchema, PlanInputSchema, PlanDetailSchema, ReceiptSchema } from '@crawlsystem/contracts';
import { fixtureSubmission } from '@crawlsystem/contracts/hash';
function required(name:string):string {const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}
const control=required('CONTROL_API_URL'),ingest=required('INGEST_API_URL');
const operator=readFileSync(required('OPERATOR_TOKEN_FILE'),'utf8').trim(),worker=readFileSync(required('WORKER_TOKEN_FILE'),'utf8').trim();
async function api(base:string,path:string,token:string,body?:unknown):Promise<unknown> {
  const response=await fetch(new URL(path,base),{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error(`Smoke request failed: ${path} HTTP ${response.status}`);
  return response.json();
}
// Deliberately exercises only the backend; it does not claim a Temporal run.
const plan=PlanSchema.parse(await api(control,'/v1/plans',operator,{request_id:randomUUID(),fixture_id:'channel-basic-v1',required_domains:['ABOUT','VIDEO']}));
const context=PlanInputSchema.parse(await api(control,`/v1/plans/${plan.plan_id}/input`,worker));
const receipts=await Promise.all((['ABOUT','VIDEO'] as const).map(async domain=>ReceiptSchema.parse(await api(ingest,'/v1/submissions',worker,fixtureSubmission(context,domain)))));
const detail=PlanDetailSchema.parse(await api(control,`/v1/plans/${plan.plan_id}`,operator));
if(detail.plan.status!=='COMPLETED'||detail.receipts.length!==2)throw new Error('Persisted backend result did not close correctly');
console.log(JSON.stringify({scope:'backend HTTP and PostgreSQL only',plan_id:plan.plan_id,status:detail.plan.status,submission_ids:receipts.map(r=>r.submission_id),temporal_verified:false},null,2));
