import {z} from 'zod';
export const ProxyAvailabilityQuerySchema=z.strictObject({
  resolution:z.enum(['day','hour']).default('day'),
  server_id:z.string().min(1).max(160).regex(/^[a-zA-Z0-9:_./-]+$/).optional(),
  provider:z.string().min(1).max(80).optional(),
});
const count=z.number().int().nonnegative(),percent=z.number().min(0).max(100).nullable();
export const ProxyAvailabilityCountsSchema=z.strictObject({
  healthy:count,degraded:count,trial:count,cooldown:count,failed:count,
  samples:count,available_samples:count,requests:count,failures:count,
  available_percent:percent,request_success_percent:percent,
}).refine(p=>p.samples===p.healthy+p.degraded+p.trial+p.cooldown+p.failed&&p.available_samples===p.healthy+p.degraded,'Sample counts disagree')
  .refine(p=>(p.samples===0)===(p.available_percent===null),'Missing samples must have no rate');
export const ProxyAvailabilitySchema=z.strictObject({
  observed_at:z.iso.datetime(),recording_since:z.iso.datetime(),resolution:z.enum(['day','hour']),timezone:z.literal('Asia/Shanghai'),
  latest_report_at:z.iso.datetime().nullable(),stale:z.boolean(),
  summary:ProxyAvailabilityCountsSchema,
  points:z.array(z.strictObject({bucket_at:z.iso.datetime(),counts:ProxyAvailabilityCountsSchema})).min(7).max(24),
}).refine(p=>p.points.length===(p.resolution==='day'?7:24),'Wrong bucket count');
export type ProxyAvailabilityQuery=z.infer<typeof ProxyAvailabilityQuerySchema>;
export type ProxyAvailabilityCounts=z.infer<typeof ProxyAvailabilityCountsSchema>;
