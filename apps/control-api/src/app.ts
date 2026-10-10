import { z } from 'zod';
import { AgentTaskStateSchema, BusinessCategorySchema, CandidateStateSchema, QueryStateSchema, YoutubeChannelIdSchema, ApiRoutes, CONTRACT_VERSION, CreatePlanSchema, CancelPlanSchema, ExecutionEventSchema, HeartbeatSchema, IdSchema, LoginSchema, UpdateStateSchema } from '@crawlsystem/contracts';
import { requireRole, StoreError } from '@crawlsystem/store';
import { createServer, pagination, planId, sourceMode, type ServerOptions } from '@crawlsystem/http';
import { authenticate } from '@crawlsystem/http/auth';
import type { WorkloadIdentity } from '@crawlsystem/http/workload';
import type { ProxyStore } from '@crawlsystem/store/proxies';
import { ConsoleAuth } from './console-auth.ts';
import { SubmissionSchema } from '@crawlsystem/contracts';

export function createControlApi(options:ServerOptions & { consoleAuth?:ConsoleAuth; workloadIdentity?:WorkloadIdentity; proxies?:ProxyStore }) {
  const auth=options.consoleAuth,workload=options.workloadIdentity;
  const proxies=()=>{if(!options.proxies) throw new StoreError('DEPENDENCY_NOT_IMPLEMENTED','Proxy Control is not configured',503);return options.proxies;};
  const app=createServer('control',{...options,authenticateRequest:async request=>{
    const path=request.url.split('?')[0];
    const publicAuth=request.method==='POST' && (path===ApiRoutes.login || path===ApiRoutes.logout);
    if(publicAuth || (request.headers.cookie && !request.headers.authorization && request.method!=='GET' && request.method!=='HEAD')) {
      if(request.headers['x-console-request']!=='1') throw new StoreError('FORBIDDEN','Console request header is required',403);
    }
    if(publicAuth) return undefined;
    // The bearer here is a Kubernetes ServiceAccount token, verified by TokenReview in the route.
    if(request.method==='POST' && (path===ApiRoutes.workloadToken || path===ApiRoutes.temporalToken)) return undefined;
    if(request.headers.authorization) return authenticate(request.headers.authorization,options.signingKey);
    if(auth) return auth.authenticate(request.headers.cookie);
    return authenticate(undefined,options.signingKey);
  }}),store=options.store;
  app.post(ApiRoutes.login,{bodyLimit:2048},async(request,reply)=>{
    if(!auth) throw new StoreError('DEPENDENCY_NOT_IMPLEMENTED','Account login is not configured',503);
    const input=LoginSchema.parse(request.body);
    const result=await auth.login(input.username,input.password,request.headers.cookie);
    reply.header('set-cookie',result.cookie);
    return {...result.principal,contract_version:CONTRACT_VERSION};
  });
  app.post(ApiRoutes.logout,{bodyLimit:2048},async(request,reply)=>{
    if(auth) {await auth.revoke(request.headers.cookie);reply.header('set-cookie',auth.clearCookie());}
    return {ok:true};
  });
  app.post(ApiRoutes.workloadToken,{bodyLimit:1024},async request=>{
    if(!workload) throw new StoreError('DEPENDENCY_NOT_IMPLEMENTED','Workload identity is not configured',503);
    const result=await workload.exchange(request.headers.authorization);
    return {token:result.token,...result.principal,server_id:result.server_id,expires_in:result.expires_in};
  });
  app.post(ApiRoutes.temporalToken,{bodyLimit:1024},async request=>{
    if(!workload) throw new StoreError('DEPENDENCY_NOT_IMPLEMENTED','Workload identity is not configured',503);
    return workload.exchangeTemporal(request.headers.authorization);
  });
  app.get('/v1/session',async request=>({...request.principal,contract_version:CONTRACT_VERSION}));
  app.get(ApiRoutes.consoleAccounts,async request=>{
    if(!auth) throw new StoreError('DEPENDENCY_NOT_IMPLEMENTED','Account login is not configured',503);
    return auth.listAccounts(request.principal);
  });
  // The creating request's trace context is stored so dispatch and execution continue that trace.
  app.post('/v1/plans',async request=>store.createPlan(request.principal,CreatePlanSchema.parse(request.body),request.traceparent));
  app.get('/v1/plans',async request=>{const q=pagination(request.query);return store.listPlans(request.principal,q.limit,q.offset,q.status,q.sourceMode);});
  app.get('/v1/plans/:id',async request=>store.getPlan(request.principal,planId(request)));
  app.get('/v1/plans/:id/input',async request=>{requireRole(request.principal,'worker','parser','sink');return store.getInput(request.principal,planId(request));});
  app.post('/v1/pipeline/manifests',async request=>store.pipelineManifest(request.principal,request.body));
  app.get('/v1/pipeline/reconciliation',async request=>store.pipelineReconciliation(request.principal));
  app.post('/v1/plans/:id/pipeline/confirm',async request=>store.confirmPipeline(request.principal,planId(request)));
  app.get('/v1/plans/:id/pipeline',async request=>store.pipelineProgress(request.principal,planId(request)));
  app.post('/v1/pipeline/navigation',async request=>{
    const s=SubmissionSchema.parse(request.body);
    if(s.domain!=='VIDEO'||!['targets','discovery'].includes(s.payload.kind)||s.domain_complete) throw new StoreError('INVALID_REQUEST','Only navigation manifests are accepted',400);
    return store.apply(request.principal,s);
  });
  app.get('/v1/plans/:id/agent-input',async request=>store.agentInput(request.principal,planId(request)));
  app.post('/v1/plans/:id/cancel',async request=>store.cancel(request.principal,planId(request),CancelPlanSchema.parse(request.body)));
  app.post('/v1/plans/:id/events',async request=>store.event(request.principal,planId(request),ExecutionEventSchema.parse(request.body)));
  app.get('/v1/receipts/:id',async request=>store.getReceipt(request.principal,planId(request)));
  app.get('/v1/channels',async request=>{const q=pagination(request.query);return store.listChannels(request.principal,q.limit,q.offset,q.sourceMode);});
  app.get(ApiRoutes.plansSummary,async request=>store.plansSummary(request.principal,sourceMode(request.query)));
  app.get(ApiRoutes.completeness,async request=>store.completeness(request.principal,sourceMode(request.query)));
  app.get(ApiRoutes.updatesSummary,async request=>(await store.updates(request.principal,1)).summary);
  app.get(ApiRoutes.updates,async request=>{
    const q=pagination(request.query), filter=z.object({state:UpdateStateSchema.optional(),search:z.string().max(160).optional()}).parse(request.query);
    return (await store.updates(request.principal,q.limit,q.offset,filter)).page;
  });
  app.post(ApiRoutes.dataApiPermit,{bodyLimit:2048},async request=>store.dataApiPermit(request.principal,request.body));
  app.post(ApiRoutes.dataApiFailure,{bodyLimit:2048},async request=>store.dataApiFailure(request.principal,request.body));
  app.get(ApiRoutes.dataApiSummary,async request=>store.dataApiSummary(request.principal));
  app.get(ApiRoutes.agentSummary,async request=>store.agentSummary(request.principal));
  app.get(ApiRoutes.agentTasks,async request=>{
    const q=pagination(request.query), filter=z.object({state:AgentTaskStateSchema.optional()}).parse(request.query);
    return store.agentTasks(request.principal,q.limit,q.offset,filter.state);
  });
  app.get(ApiRoutes.queriesSummary,async request=>store.querySummary(request.principal));
  app.get(ApiRoutes.queries,async request=>{
    const q=pagination(request.query), filter=z.object({state:QueryStateSchema.optional(),category:BusinessCategorySchema.optional(),country:z.string().regex(/^[A-Z]{2}$/).optional(),search:z.string().max(200).optional()}).parse(request.query);
    return store.queries(request.principal,q.limit,q.offset,filter);
  });
  app.post(ApiRoutes.queries,{bodyLimit:4096},async request=>store.createQuery(request.principal,request.body));
  app.post('/v1/queries/:id',{bodyLimit:4096},async request=>store.queryCommand(request.principal,z.object({id:z.uuid()}).parse(request.params).id,request.body));
  app.get(ApiRoutes.candidatesSummary,async request=>store.candidateSummary(request.principal));
  app.get(ApiRoutes.candidates,async request=>{
    const q=pagination(request.query), filter=z.object({state:CandidateStateSchema.optional(),category:BusinessCategorySchema.optional(),search:z.string().max(200).optional()}).parse(request.query);
    return store.candidates(request.principal,q.limit,q.offset,filter);
  });
  app.post('/v1/candidates/:id',{bodyLimit:4096},async request=>store.candidateCommand(request.principal,z.object({id:YoutubeChannelIdSchema}).parse(request.params).id,request.body));
  // Worker: search execution under a lease (claim, renew, pages, result, failure, Data API permits).
  const runId=(request:{params:unknown})=>z.object({id:z.uuid()}).parse(request.params).id;
  app.post(ApiRoutes.queryRunClaim,{bodyLimit:1024},async request=>store.claimQueryRun(request.principal));
  app.post('/v1/query-runs/:id/heartbeat',{bodyLimit:1024},async request=>store.queryRunHeartbeat(request.principal,runId(request),request.body));
  app.post('/v1/query-runs/:id/page',{bodyLimit:65536},async request=>store.queryRunPage(request.principal,runId(request),request.body));
  app.post('/v1/query-runs/:id/complete',{bodyLimit:1048576},async request=>store.queryRunComplete(request.principal,runId(request),request.body));
  app.post('/v1/query-runs/:id/fail',{bodyLimit:1024},async request=>store.queryRunFail(request.principal,runId(request),request.body));
  app.post('/v1/query-runs/:id/data-api-permit',{bodyLimit:1024},async request=>store.queryRunPermit(request.principal,runId(request),request.body));
  app.post('/v1/query-runs/:id/data-api-failure',{bodyLimit:1024},async request=>store.queryRunPermitFailure(request.principal,runId(request),request.body));
  app.post(ApiRoutes.channelImport,{bodyLimit:262144},async request=>store.importChannels(request.principal,request.body));
  app.get(ApiRoutes.channelImports,async request=>store.channelImports(request.principal));
  app.get('/v1/channels/:id',async request=>store.getChannel(request.principal,z.object({id:IdSchema}).parse(request.params).id));
  app.get('/v1/channels/:id/videos/:video/comments',async request=>{
    const p=z.object({id:IdSchema,video:IdSchema}).parse(request.params);return store.videoComments(request.principal,p.id,p.video);
  });
  app.post('/v1/channels/:id/management',{bodyLimit:1024},async request=>store.manageChannel(request.principal,z.object({id:IdSchema}).parse(request.params).id,request.body));
  app.post('/v1/channels/:id/clock-override',{bodyLimit:1024},async request=>store.overrideClock(request.principal,z.object({id:IdSchema}).parse(request.params).id,request.body));
  app.post('/v1/channels/:id/update',{bodyLimit:2048},async request=>store.updateChannel(request.principal,z.object({id:IdSchema}).parse(request.params).id,request.body));
  app.post('/v1/workers/heartbeat',async request=>store.heartbeat(request.principal,HeartbeatSchema.parse(request.body)));
  app.get(ApiRoutes.proxies,async request=>proxies().overview(request.principal));
  app.post(ApiRoutes.proxyImport,{bodyLimit:262144},async request=>proxies().importProxies(request.principal,request.body));
  app.post('/v1/proxies/:id',async request=>proxies().update(request.principal,planId(request),request.body));
  app.post('/v1/proxies/:id/delete',async request=>{await proxies().remove(request.principal,planId(request),z.strictObject({expected_version:z.number().int().positive()}).parse(request.body).expected_version);return {deleted:true};});
  app.get(ApiRoutes.proxySources,async request=>({items:await proxies().listSources(request.principal)}));
  app.post(ApiRoutes.proxySources,{bodyLimit:8192},async request=>proxies().createSource(request.principal,request.body));
  app.post('/v1/proxy-sources/:id',async request=>proxies().updateSource(request.principal,planId(request),request.body));
  app.post(ApiRoutes.proxySync,{bodyLimit:262144},async request=>proxies().sync(request.principal,request.body));
  app.get('/v1/workers',async request=>{const q=pagination(request.query);return store.listWorkers(request.principal,q.limit,q.offset);});
  app.get('/v1/errors',async request=>{const q=pagination(request.query);return store.listErrors(request.principal,q.limit,q.offset,q.sourceMode);});
  return app;
}
