import {z} from 'zod';

export const WorkerModeSchema=z.enum(['RUNNING','PAUSED','DRAINING']);
export const WorkerControlSchema=z.strictObject({
 version:z.number().int().positive(),desired:WorkerModeSchema,
 applied_version:z.number().int().nonnegative(),
 status:z.enum(['UNSUPPORTED','OFFLINE','PENDING','RUNNING','PAUSED','DRAINING','DRAINED']),
 reason:z.string().max(500).nullable(),changed_at:z.iso.datetime().nullable(),
 active_plan_ids:z.array(z.uuid()).max(100),active_query_run_ids:z.array(z.uuid()).max(100),legacy_pending:z.number().int().nonnegative(),
});
export const WorkerManagementReportSchema=z.strictObject({protocol:z.literal('worker-control-1'),applied_version:z.number().int().nonnegative(),ready:z.boolean()});
export const WorkerProcessSchema=z.strictObject({cpu_cores:z.number().finite().min(0).max(1024).nullable(),rss_bytes:z.number().int().nonnegative(),sampled_at:z.iso.datetime()});
export const WorkerCommandSchema=z.strictObject({command_id:z.uuid(),expected_version:z.number().int().positive(),reason:z.string().trim().min(3).max(500)});
export type WorkerCommand=z.infer<typeof WorkerCommandSchema>;
export type WorkerControl=z.infer<typeof WorkerControlSchema>;
export const WorkerMetricsSchema=z.strictObject({
 worker_id:z.string(),server_id:z.string(),sampled_at:z.iso.datetime(),monitoring_available:z.boolean(),
 node:z.strictObject({cpu_percent:z.number().min(0).max(100).nullable(),memory_used_bytes:z.number().int().nonnegative().nullable(),memory_total_bytes:z.number().int().nonnegative().nullable(),sampled_at:z.iso.datetime().nullable()}),
 process:WorkerProcessSchema.nullable(),
 resources:z.array(z.strictObject({at:z.iso.datetime(),cpu_cores:z.number().min(0).nullable(),rss_bytes:z.number().min(0).nullable()})).max(300),
 tasks:z.array(z.strictObject({at:z.iso.datetime(),plans_completed:z.number().int().nonnegative(),plans_failed:z.number().int().nonnegative(),queries_completed:z.number().int().nonnegative(),queries_failed:z.number().int().nonnegative()})).max(24),
});
export type WorkerMetrics=z.infer<typeof WorkerMetricsSchema>;
/** Stable StatefulSet Pod identities keep their queue across process replacement. */
export const workerTaskQueue=(base:string,worker:string)=>`${base}/workers/${worker}`;
