import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Span, type TextMapGetter } from '@opentelemetry/api';
import { W3CTraceContextPropagator, ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { BasicTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, type SpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';

const propagator=new W3CTraceContextPropagator();
const getter:TextMapGetter<Record<string,unknown>>={keys:Object.keys,get:(carrier,key)=>typeof carrier[key]==='string'?carrier[key] as string:undefined};
/** Export only our explicit, bounded attributes. Never record payloads, full URLs,
 * cookies, authorization headers or arbitrary exception messages. Existing log
 * collection can ingest these spans; no new tracing service is installed. */
class LogSpanExporter implements SpanExporter {
  constructor(private write:(record:Record<string,unknown>)=>void,private service:string){}
  export(spans:ReadableSpan[],done:(result:ExportResult)=>void) {
    try {
      for(const span of spans)this.write({event:'trace_span',service:this.service,name:span.name,
        trace_id:span.spanContext().traceId,span_id:span.spanContext().spanId,parent_span_id:span.parentSpanContext?.spanId,
        duration_ms:span.duration[0]*1000+span.duration[1]/1e6,status:span.status.code,attributes:span.attributes});
      done({code:ExportResultCode.SUCCESS});
    } catch {done({code:ExportResultCode.FAILED});}
  }
  async shutdown(){}
}
export class RequestTracing {
  private provider:BasicTracerProvider;
  private tracer;
  constructor(service:string,write:(record:Record<string,unknown>)=>void,rate=0.1,exporter?:SpanExporter){
    if(!Number.isFinite(rate)||rate<0||rate>1)throw new Error('TRACE_SAMPLE_RATIO must be between 0 and 1');
    this.provider=new BasicTracerProvider({sampler:new ParentBasedSampler({root:new TraceIdRatioBasedSampler(rate)}),
      spanLimits:{attributeCountLimit:16,attributeValueLengthLimit:160,eventCountLimit:0,linkCountLimit:0},
      spanProcessors:[new BatchSpanProcessor(exporter??new LogSpanExporter(write,service),{maxQueueSize:256,maxExportBatchSize:32,scheduledDelayMillis:1000,exportTimeoutMillis:2000})]});
    this.tracer=this.provider.getTracer('@crawlsystem/http','0.1.0');
  }
  start(headers:Record<string,unknown>,method:string,route:string,requestId:string){
    const parent=propagator.extract(ROOT_CONTEXT,headers,getter);
    const span=this.tracer.startSpan(`${method} ${route}`,{kind:SpanKind.SERVER,attributes:{'http.request.method':method,'http.route':route,'request.id':requestId}},parent);
    const outgoing:Record<string,string>={};
    propagator.inject(trace.setSpan(ROOT_CONTEXT,span),outgoing,{set:(carrier,key,value)=>{carrier[key]=value;}});
    return {span,traceparent:outgoing.traceparent!};
  }
  /** Internal/client span continuing a stored W3C context (dispatcher, Worker Activity).
   * Its traceparent is sent on outgoing HTTP calls so server spans join the same trace. */
  child(parent:string|undefined,name:string,attributes:Record<string,string|number>={},kind:SpanKind=SpanKind.INTERNAL){
    const context=parent?propagator.extract(ROOT_CONTEXT,{traceparent:parent},getter):ROOT_CONTEXT;
    const span=this.tracer.startSpan(name,{kind,attributes},context);
    const outgoing:Record<string,string>={};
    propagator.inject(trace.setSpan(ROOT_CONTEXT,span),outgoing,{set:(carrier,key,value)=>{carrier[key]=value;}});
    return {span,traceparent:outgoing.traceparent!,end:(failed=false)=>{if(failed)span.setStatus({code:SpanStatusCode.ERROR});span.end();}};
  }
  finish(span:Span,status:number){span.setAttribute('http.response.status_code',status);if(status>=500)span.setStatus({code:SpanStatusCode.ERROR});span.end();}
  async flush(){await this.provider.forceFlush();}
  async close(){await this.provider.shutdown();}
}
