import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {createPool} from '@crawlsystem/store/config';
import {QueryCollectionSummarySchema,QuerySourcesSchema} from '../../packages/contracts/src/query-collection.ts';
import {ConfigSnapshotSchema} from '../../packages/contracts/src/configuration.ts';
const dir='.runtime/b2',origin='http://127.0.0.1:18103',workspace='m1-main';mkdirSync(dir,{recursive:true,mode:0o700});
const key=loadSigningKey(),token=await issueToken({subject:'b2-live',workspace_id:workspace,role:'operator'},key,600);
const headers={authorization:'Bearer '+token},pool=createPool(),browser=await chromium.launch({headless:true});
const evidence:Record<string,unknown>={},errors:string[]=[],failed:string[]=[];let phase='automatic-growth';
const get=async(path:string)=>{const r=await fetch(origin+'/api'+path,{headers,signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return r.json();};
try{
  let initial=QueryCollectionSummarySchema.parse(await get('/v1/queries/collection')),current=initial;
  await expect.poll(async()=>{current=QueryCollectionSummarySchema.parse(await get('/v1/queries/collection'));return current.scanned_channels;},{timeout:65000,intervals:[2000]}).toBeGreaterThan(initial.scanned_channels);
  await expect.poll(async()=>{current=QueryCollectionSummarySchema.parse(await get('/v1/queries/collection'));return current.auto_bindings;},{timeout:90000,intervals:[2000]}).toBeGreaterThan(0);
  assert.ok(current.created_today+current.woken_today<=current.limits.daily_binding_limit);assert.ok(current.auto_bindings<=current.limits.max_auto_bindings);assert.ok(current.candidates<=20000);
  const integrity=(await pool.query(`SELECT count(*) FILTER(WHERE c.support_count<2 AND c.auto_created)::int insufficient_support,
    count(*) FILTER(WHERE c.support_count<>(SELECT count(*) FROM control.query_collection_evidence e WHERE e.candidate_id=c.candidate_id))::int inconsistent_support
    FROM control.query_collection_candidates c WHERE c.workspace_id=$1`,[workspace])).rows[0];assert.deepEqual(integrity,{insufficient_support:0,inconsistent_support:0});
  const binding=(await pool.query(`SELECT b.binding_id,t.text,b.country,b.category,b.state,b.priority,c.support_count FROM control.query_collection_candidates c
    JOIN control.query_bindings b ON b.binding_id=c.binding_id JOIN control.query_terms t ON t.term_id=b.term_id
    WHERE c.workspace_id=$1 AND c.auto_created ORDER BY c.created_at,c.candidate_id LIMIT 1`,[workspace])).rows[0];assert.ok(binding);assert.equal(binding.priority,-10);
  const sources=QuerySourcesSchema.parse(await get(`/v1/queries/${binding.binding_id}/sources`));assert.ok(sources.items.length>=2);assert.ok(sources.items.every(s=>s.channel_id));
  const distinct=new Set(sources.items.map(s=>s.channel_id));assert.equal(distinct.size,sources.items.length);
  const config=ConfigSnapshotSchema.parse(await get('/v1/config'));assert.equal(config.settings.discovery.daily_run_limit,300);assert.equal(config.settings.discovery.max_active_runs,2);assert.equal(config.settings.discovery.backlog_limit,2000);assert.equal(config.settings.update.daily_plan_limit,100);
  evidence.initial=initial;evidence.current=current;evidence.binding=binding;evidence.sources=sources;evidence.integrity=integrity;evidence.search_limits_preserved=true;
  phase='permissions';
  for(const role of ['reader','node','worker'] as const){
    const t=await issueToken({subject:'b2-'+role,workspace_id:workspace,role,...(role==='node'?{server_id:'b2-node'}:{})},key,600);
    for(const path of ['/v1/queries/collection',`/v1/queries/${binding.binding_id}/sources`]){
      const r=await fetch(origin+'/api'+path,{headers:{authorization:'Bearer '+t},signal:AbortSignal.timeout(15000)});assert.equal(r.status,role==='reader'?200:403);
    }
  }
  const isolated=await issueToken({subject:'b2-isolated',workspace_id:'b2-absent-'+randomUUID(),role:'reader'},key,600);
  const absent=await fetch(origin+'/api/v1/queries/collection',{headers:{authorization:'Bearer '+isolated},signal:AbortSignal.timeout(15000)});
  assert.equal(QueryCollectionSummarySchema.parse(await absent.json()).candidates,0);
  const hidden=await fetch(origin+`/api/v1/queries/${binding.binding_id}/sources`,{headers:{authorization:'Bearer '+isolated},signal:AbortSignal.timeout(15000)});assert.equal(hidden.status,404);evidence.permissions_passed=true;
  phase='page';const page=await browser.newPage({viewport:{width:1920,height:937},extraHTTPHeaders:headers});
  page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.url().includes('/api/v1/')&&r.status()>=400)failed.push(new URL(r.url()).pathname+':'+r.status());});
  await page.goto(origin+'/discover/queries');const panel=page.locator('.query-collection');await expect(panel).toContainText('自动收集搜索词');await expect(panel).toContainText('至少 2 个不同频道支持');
  await page.getByLabel('搜索搜索词',{exact:true}).fill(binding.text);await page.getByLabel('业务分类',{exact:true}).selectOption(binding.category);await page.getByLabel('国家',{exact:true}).selectOption(binding.country);
  await page.getByRole('button',{name:`查看 ${binding.text} 的来源`,exact:true}).click();await expect(page.getByRole('heading',{name:'搜索词来源',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'查看来源频道 '+sources.items[0]!.channel_id,exact:true})).toBeVisible();
  await page.keyboard.press('Escape');evidence.source_dialog_passed=true;
  phase='layouts';const layouts=[];
  for(const [width,height] of [[1920,937],[1586,992],[390,844]] as const){
    await page.setViewportSize({width,height});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
    await page.screenshot({path:dir+'/queries-'+width+'.png',fullPage:true});layouts.push({width,height,horizontal_overflow:0});
  }
  evidence.layouts=layouts;assert.equal(failed.length,0);
  phase='error-recovery';await page.route('**/api/v1/queries/collection',route=>route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'B2 读取恢复验收',retryable:true,correlation_id:'b2-browser'}}}));
  await panel.getByRole('button',{name:'刷新收集状态',exact:true}).click();await expect(panel.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/v1/queries/collection');await panel.getByRole('button',{name:'刷新收集状态',exact:true}).click();await expect(panel.getByRole('alert')).toHaveCount(0);evidence.error_recovered=true;
  phase='reader';const reader=await issueToken({subject:'b2-reader-browser',workspace_id:workspace,role:'reader'},key,600);
  const readonly=await browser.newPage({viewport:{width:390,height:844},extraHTTPHeaders:{authorization:'Bearer '+reader}});await readonly.goto(origin+'/discover/queries');await expect(readonly.locator('.query-collection')).toContainText('自动收集搜索词');await expect(readonly.getByRole('button',{name:'添加搜索词',exact:true})).toHaveCount(0);
  assert.equal(errors.length,0);evidence.final=QueryCollectionSummarySchema.parse(await get('/v1/queries/collection'));
  writeFileSync(dir+'/browser-evidence.json',JSON.stringify({result:'PASSED',at:new Date().toISOString(),...evidence,page_errors:errors,unexpected_api_failures:failed.filter(p=>!p.endsWith(':503'))},null,2),{mode:0o600});
  console.log('B2 natural collection growth, provenance, budgets, permissions, recovery and responsive layouts passed');
}catch(error){writeFileSync(dir+'/browser-failure.json',JSON.stringify({phase,error:error instanceof Error?error.name:'UnknownError',...evidence,page_errors:errors,failed_api_reads:failed},null,2),{mode:0o600});console.error('B2 verification failed at '+phase);process.exitCode=1;}
finally{await browser.close();await pool.end();}
