import {RawReferenceSchema,StepManifestSchema} from '@crawlsystem/contracts/pipeline';
import {FailureReportSchema} from '@crawlsystem/contracts/analytics';
/** A DLQ contains only a validated replay reference, never the fact/response payload. */
export function failureEnvelope(stage:'PARSER'|'SINK',topic:string,partition:number,offset:string,code:string,attempts:number,value:string) {
  let input:unknown;try{input=JSON.parse(value);}catch{input=null;}
  const data=input as Record<string,unknown>|null;
  const ref=RawReferenceSchema.safeParse(data?.raw??input),manifest=StepManifestSchema.safeParse(input);
  const raw=ref.success?ref.data:null,m=manifest.success?manifest.data:null;
  const report=FailureReportSchema.parse({report_id:`dlq:${stage}:${topic}:${partition}:${offset}`,stage,code,attempts,
    plan_id:raw?.plan_id??m?.owner.plan_id??null,execution_epoch:raw?.execution_epoch??m?.owner.execution_epoch??null,
    step:raw?.step??m?.step??'',unit_id:raw?.unit_id??(m?'_manifest':''),raw,manifest:m,source:{topic,partition,offset}});
  return {schema_version:'crawl.failure.v2',observed_at:new Date().toISOString(),report};
}
