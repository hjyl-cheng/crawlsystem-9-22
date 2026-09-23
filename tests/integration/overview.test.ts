import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '@crawlsystem/store';
import {createPool} from '@crawlsystem/store/config';
import {prepareDatabase} from './database-ready.ts';
import {fixtureSubmission} from '@crawlsystem/contracts/hash';
import {ChannelListItemSchema,CompletenessSchema,PlansSummarySchema,pageSchema,type Principal} from '@crawlsystem/contracts';
import {issueToken} from '@crawlsystem/http/auth';
import {createControlApi} from '../../apps/control-api/src/app.ts';
const pool=createPool(),store=new Store(pool),key=randomBytes(48),app=createControlApi({store,signingKey:key});
before(()=>prepareDatabase(pool));after(async()=>{await app.close();await pool.end();});
const identity=():Principal=>({subject:'overview-test',workspace_id:`overview-${randomUUID()}`,role:'operator'});
async function create(who:Principal,agent=false){return store.createPlan(who,{request_id:randomUUID(),fixture_id:'channel-basic-v1',required_domains:agent?['ABOUT','VIDEO','AGENT']:['ABOUT','VIDEO']});}
async function apply(who:Principal,id:string){const worker={...who,role:'worker' as const};const input=await store.getInput(worker,id);for(const domain of ['ABOUT','VIDEO'] as const)await store.apply(worker,fixtureSubmission(input,domain));}
const headers=async(p:Principal)=>({authorization:`Bearer ${await issueToken(p,key)}`});
test('overview totals, missing required Agent and channel facts come from the authenticated workspace',async()=>{
  const who=identity(),first=await create(who);await apply(who,first.plan_id);
  const waiting=await create(who,true);await apply(who,waiting.plan_id);
  const summary=PlansSummarySchema.parse(await store.plansSummary(who));
  assert.equal(summary.total,2);assert.equal(summary.by_status.COMPLETED,1);assert.equal(summary.by_status.WAITING,1);
  assert.equal(summary.domains.find(d=>d.domain==='AGENT')?.applied,0);
  const complete=CompletenessSchema.parse(await store.completeness(who));
  assert.equal(complete.total_channels,1);assert.equal(complete.partial,1);assert.equal(complete.missing_by_domain.AGENT,1);
  const rows=pageSchema(ChannelListItemSchema).parse(await store.listChannels(who));
  assert.equal(rows.items[0]?.stored_videos,1);assert.equal(rows.items[0]?.latest_plan_status,'WAITING');assert.equal(rows.items[0]?.subscriber_count,100);
  const empty=identity();assert.equal((await store.plansSummary(empty)).total,0);assert.equal((await store.completeness(empty)).total_channels,0);
  for(const url of ['/v1/overview/plans','/v1/overview/completeness','/v1/channels']) {
    assert.equal((await app.inject({url,headers:await headers({...who,role:'worker'})})).statusCode,403);
    assert.equal((await app.inject({url,headers:await headers({...who,role:'reader'})})).statusCode,200);
  }
});
test('summary remains internally consistent while plans are created and completed',async()=>{
  const who=identity();
  const writer=(async()=>{for(let i=0;i<8;i++){const plan=await create(who,i%2===0);await apply(who,plan.plan_id);}})();
  const reader=(async()=>{for(let i=0;i<16;i++){const s=PlansSummarySchema.parse(await store.plansSummary(who));assert.equal(Object.values(s.by_status).reduce((a,b)=>a+b,0),s.total);for(const d of s.domains)assert.equal(d.required,s.total===0?0:d.domain==='AGENT'?d.required:s.total);}})();
  await Promise.all([writer,reader]);const final=await store.plansSummary(who);assert.equal(final.total,8);assert.equal(final.by_status.COMPLETED,4);assert.equal(final.by_status.WAITING,4);
});
