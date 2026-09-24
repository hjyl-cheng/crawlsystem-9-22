import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z, ZodError } from 'zod';
import { MAX_BODY_BYTES, PlanStatusSchema, SourceModeSchema, type Principal, type SourceMode } from '@crawlsystem/contracts';
import { Store, StoreError } from '@crawlsystem/store';
import { authenticate } from './auth.ts';
import { RequestTracing } from './tracing.ts';

declare module 'fastify' { interface FastifyRequest { principal:Principal; traceparent?:string; } }
export interface ServerOptions { store:Store; signingKey:Uint8Array; logger?:boolean; allowedOrigin?:string; maxInFlight?:number; metricsWorkspace?:string; tracing?:RequestTracing; readiness?:()=>Promise<void>; authenticateRequest?:(request:FastifyRequest)=>Promise<Principal|undefined>; }
// Business views count real channels only; fixture (test sample) plans are listed on explicit request.
const SourceQuery={source_mode:SourceModeSchema.default('youtube')};
export function sourceMode(query:unknown):SourceMode {return z.strictObject(SourceQuery).parse(query ?? {}).source_mode;}
export function pagination(query:unknown): {limit:number;offset:number;status?:string;sourceMode:SourceMode} {
  const q=z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(20),cursor:z.string().regex(/^\d{1,6}$/).default('0'),status:PlanStatusSchema.optional(),...SourceQuery}).parse(query);
  const offset=Number(q.cursor);if(offset>100000) throw new StoreError('INVALID_REQUEST','Cursor exceeds maximum',400);
  return {limit:q.limit,offset,status:q.status,sourceMode:q.source_mode};
}
export function planId(request:FastifyRequest):string {return z.object({id:z.uuid()}).parse(request.params).id;}
export function createServer(service:'control'|'ingest',options:ServerOptions):FastifyInstance {
  const app=Fastify({bodyLimit:MAX_BODY_BYTES,requestTimeout:15000,connectionTimeout:15000,keepAliveTimeout:5000,routerOptions:{maxParamLength:200},
    genReqId:()=>randomUUID(),logController:new LogController({disableRequestLogging:true}),logger:options.logger ?? false});
  app.decorateRequest('principal');
  app.decorateRequest('traceparent');
  const tracing=options.tracing??new RequestTracing(service,record=>app.log.info(record,'trace span'),Number(process.env.TRACE_SAMPLE_RATIO??'0.1'));
  const traces=new WeakMap<FastifyRequest,ReturnType<RequestTracing['start']>>();
  const ended=new WeakSet<FastifyRequest>();
  const endTrace=(request:FastifyRequest,status:number)=>{const current=traces.get(request);if(current&&!ended.has(request)){ended.add(request);tracing.finish(current.span,status);}};
  app.addHook('onClose',async()=>{await tracing.close();});
  let inflight=0;
  const buckets=[0.01,0.05,0.1,0.25,0.5,1,2.5,5,10,Infinity];
  const metrics=new Map<string,{count:number;sum:number;buckets:number[]}>();
  const starts=new WeakMap<FastifyRequest,number>();
  app.addHook('onRequest',async(request,reply)=>{
    starts.set(request,performance.now());
    const route=request.routeOptions.url??'unmatched';
    const current=tracing.start(request.headers,request.routeOptions.method?.toString()??'UNKNOWN',route,request.id);traces.set(request,current);
    reply.header('traceparent',current.traceparent);request.traceparent=current.traceparent;
    reply.raw.once('close',()=>endTrace(request,reply.raw.writableFinished?reply.statusCode:499));
    reply.header('x-request-id',request.id).header('cache-control','no-store').header('x-content-type-options','nosniff');
    const origin=request.headers.origin;
    if(origin && options.allowedOrigin && origin===options.allowedOrigin) {
      reply.header('access-control-allow-origin',origin).header('access-control-allow-credentials','true').header('access-control-expose-headers','X-Request-Id,Traceparent').header('vary','Origin').header('access-control-allow-headers','Authorization,Content-Type,X-Console-Request,Traceparent,Tracestate').header('access-control-allow-methods','GET,POST,OPTIONS');
      if(request.method==='OPTIONS') return reply.code(204).send();
    }
    if(origin && origin!==options.allowedOrigin) throw new StoreError('FORBIDDEN','Origin is not allowed',403);
    if(inflight >= (options.maxInFlight ?? 64)) throw new StoreError('UNAVAILABLE','Request capacity reached',503,true);
    inflight++;
    let released=false;
    const release=()=>{if(!released){released=true;inflight--;}};
    reply.raw.once('finish',release);reply.raw.once('close',release);
    if(request.url.startsWith('/v1/')) {
      const principal=options.authenticateRequest ? await options.authenticateRequest(request) : await authenticate(request.headers.authorization,options.signingKey);
      if(principal) request.principal=principal;
    }
  });
  app.addHook('preSerialization',async(request,_reply,payload)=>{
    const current=traces.get(request);
    if(current&&payload&&typeof payload==='object'){
      const record=payload as Record<string,unknown>;
      const plan=record.plan&&typeof record.plan==='object'?record.plan as Record<string,unknown>:record;
      for(const field of ['plan_id','submission_id'] as const){const value=field==='plan_id'?plan[field]:record[field];if(typeof value==='string'&&z.uuid().safeParse(value).success)current.span.setAttribute('business.'+field,value);}
    }
    return payload;
  });
  app.addHook('onResponse',async(request,reply)=>{
    const route=request.routeOptions.url ?? 'unmatched';
    const elapsed=(performance.now()-(starts.get(request) ?? performance.now()))/1000;
    const label=`service="${service}",route="${route}",method="${request.routeOptions.method}",status="${reply.statusCode}"`;
    const m=metrics.get(label) ?? {count:0,sum:0,buckets:buckets.map(()=>0)};m.count++;m.sum+=elapsed;
    buckets.forEach((bound,index)=>{if(elapsed<=bound)m.buckets[index]=m.buckets[index]!+1;});metrics.set(label,m);
    const current=traces.get(request);const context=current?.span.spanContext();
    request.log.info({request_id:request.id,trace_id:context?.traceId,span_id:context?.spanId,route,status:reply.statusCode,duration_ms:Math.round(elapsed*1000)},'request completed');
    endTrace(request,reply.statusCode);
  });
  app.setErrorHandler((err:Error & {statusCode?:number;code?:string},request,reply)=>{
    let error:StoreError;
    if(err instanceof StoreError) error=err;
    else if(err instanceof ZodError || err.statusCode===400) error=new StoreError('INVALID_REQUEST','Request does not match the contract',400);
    else if(err.statusCode===413) error=new StoreError('INVALID_REQUEST','Request body exceeds 1 MiB',413);
    else if(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01','53300','55P03','57014'].includes(err.code ?? '') || /^08/.test(err.code ?? '') || /connection.*(timeout|terminated)|timeout.*connection|query read timeout/i.test(err.message)) error=new StoreError('UNAVAILABLE','Database or dependency is temporarily unavailable',503,true);
    else error=new StoreError('INTERNAL_ERROR','Unexpected server error',500);
    if(error.status>=500) request.log.error({request_id:request.id,code:error.code,internal_code:err.code ?? 'unknown'},'request failed');
    if(error.retryable) reply.header('retry-after',error.status===429?'60':'1');
    reply.code(error.status).send({error:{code:error.code,message:error.message,retryable:error.retryable,correlation_id:request.id}});
  });
  app.setNotFoundHandler((request,reply)=>reply.code(404).send({error:{code:'NOT_FOUND',message:'Route not found',retryable:false,correlation_id:request.id}}));
  app.get('/healthz',async()=>({status:'ok',service,build_version:process.env.BUILD_VERSION??'development'}));
  app.get('/readyz',async()=>{await options.store.pool.query('SELECT 1');await options.readiness?.();return {status:'ready',service};});
  app.get('/metrics',async(_request,reply)=>{
    const rows=['# TYPE m1_http_requests_total counter','# TYPE m1_http_request_duration_seconds histogram','# TYPE m1_http_inflight gauge',`m1_http_inflight{service="${service}"} ${inflight}`];
    for(const [label,m] of metrics) {
      rows.push(`m1_http_requests_total{${label}} ${m.count}`,`m1_http_request_duration_seconds_sum{${label}} ${m.sum}`,`m1_http_request_duration_seconds_count{${label}} ${m.count}`);
      buckets.forEach((bound,index)=>rows.push(`m1_http_request_duration_seconds_bucket{${label},le="${Number.isFinite(bound)?bound:'+Inf'}"} ${m.buckets[index]}`));
    }
    if(options.metricsWorkspace) {
      const facts=await options.store.businessMetrics(options.metricsWorkspace);
      for(const metric of new Set(facts.map(fact=>fact.metric)))rows.push(`# TYPE m1_${metric} gauge`);
      for(const fact of facts)rows.push(`m1_${fact.metric}{state="${fact.state}"} ${fact.value}`);
    }
    return reply.type('text/plain; version=0.0.4').send(rows.join('\n')+'\n');
  });
  app.options('/*',async(_request,reply)=>reply.code(204).send());
  return app;
}
