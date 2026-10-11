import { z } from 'zod';
export const AuditKindSchema=z.enum(['LOGIN','LOGOUT','COMMAND','ACCOUNT']);
export const AuditOutcomeSchema=z.enum(['PENDING','SUCCESS','REJECTED','FAILED']);
export const ConsoleAuditQuerySchema=z.strictObject({
  limit:z.coerce.number().int().min(1).max(100).default(25),
  cursor:z.string().max(180).regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\|[a-f0-9-]{36}$/).optional(),
  actor:z.string().min(1).max(160).optional(),kind:AuditKindSchema.optional(),outcome:AuditOutcomeSchema.optional(),
  days:z.coerce.number().int().min(1).max(90).default(7),
}).refine(q=>!q.cursor||z.iso.datetime().safeParse(q.cursor.split('|')[0]).success&&z.uuid().safeParse(q.cursor.split('|')[1]).success,'Invalid cursor');
export const ConsoleAuditEntrySchema=z.strictObject({
  audit_id:z.uuid(),actor:z.string().max(160),username:z.string().max(64).nullable(),role:z.enum(['reader','operator']).nullable(),
  kind:AuditKindSchema,action:z.string().max(200),target:z.string().max(200).nullable(),request_id:z.uuid().nullable(),command_id:z.uuid().nullable(),
  occurred_at:z.iso.datetime(),finished_at:z.iso.datetime().nullable(),outcome:AuditOutcomeSchema,http_status:z.number().int().nullable(),
});
export const ConsoleAuditPageSchema=z.strictObject({
  items:z.array(ConsoleAuditEntrySchema).max(100),next_cursor:z.string().nullable(),observed_at:z.iso.datetime(),history_since:z.iso.datetime(),
});
export const ConsoleLoginSummarySchema=z.strictObject({
  observed_at:z.iso.datetime(),history_since:z.iso.datetime(),
  points:z.array(z.strictObject({day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),success:z.number().int().nonnegative().nullable(),rejected:z.number().int().nonnegative().nullable()})).length(7),
});
export type ConsoleAuditQuery=z.infer<typeof ConsoleAuditQuerySchema>;
export type ConsoleAuditEntry=z.infer<typeof ConsoleAuditEntrySchema>;
