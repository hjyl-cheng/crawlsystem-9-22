import { z } from 'zod';
import { ApiRoutes, CONTRACT_VERSION, CreatePlanSchema, CancelPlanSchema, ExecutionEventSchema, HeartbeatSchema, IdSchema, LoginSchema } from '@crawlsystem/contracts';
import { requireRole, StoreError } from '@crawlsystem/store';
import { createServer, pagination, planId, sourceMode, type ServerOptions } from '@crawlsystem/http';
import { authenticate } from '@crawlsystem/http/auth';
import type { WorkloadIdentity } from '@crawlsystem/http/workload';
import type { ProxyStore } from '@crawlsystem/store/proxies';
import { ConsoleAuth } from './console-auth.ts';

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
  app.get('/v1/plans/:id/input',async request=>{requireRole(request.principal,'worker');return store.getInput(request.principal,planId(request));});
  app.get('/v1/plans/:id/agent-input',async request=>store.agentInput(request.principal,planId(request)));
  app.post('/v1/plans/:id/cancel',async request=>store.cancel(request.principal,planId(request),CancelPlanSchema.parse(request.body)));
  app.post('/v1/plans/:id/events',async request=>store.event(request.principal,planId(request),ExecutionEventSchema.parse(request.body)));
  app.get('/v1/receipts/:id',async request=>store.getReceipt(request.principal,planId(request)));
  app.get('/v1/channels',async request=>{const q=pagination(request.query);return store.listChannels(request.principal,q.limit,q.offset,q.sourceMode);});
  app.get(ApiRoutes.plansSummary,async request=>store.plansSummary(request.principal,sourceMode(request.query)));
  app.get(ApiRoutes.completeness,async request=>store.completeness(request.principal,sourceMode(request.query)));
  app.get('/v1/channels/:id',async request=>store.getChannel(request.principal,z.object({id:IdSchema}).parse(request.params).id));
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
