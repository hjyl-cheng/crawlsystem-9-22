import {z} from 'zod';
import {ObjectReferenceSchema} from './pipeline.ts';
export const RawCleanupItemSchema=z.strictObject({
  workspace_id:z.string(),key:z.string().max(1024),kind:z.enum(['UNIT','MANIFEST','SEARCH']),
  plan_id:z.uuid().nullable(),run_id:z.uuid().nullable(),execution_epoch:z.number().int().positive().nullable(),
  lease_token:z.uuid(),required_refs:z.array(ObjectReferenceSchema).max(200),expected_bytes:z.number().int().nonnegative().nullable(),
});
export type RawCleanupItem=z.infer<typeof RawCleanupItemSchema>;
export const RawCleanupResultSchema=z.strictObject({key:z.string().max(1024),lease_token:z.uuid(),
  outcome:z.enum(['DELETED','MISSING','ERROR']),bytes:z.number().int().nonnegative().safe(),
  error:z.enum(['DEPENDENCY_UNAVAILABLE','PARSED_MISSING','INTEGRITY','INVALID_KEY']).optional()});
export type RawCleanupResult=z.infer<typeof RawCleanupResultSchema>;
export const RawRetentionStatusSchema=z.strictObject({
  retention_hours:z.literal(24),pending:z.number().int(),leased:z.number().int(),deleted:z.number().int(),
  deleted_bytes:z.number().nonnegative(),missing:z.number().int(),errors:z.number().int(),last_deleted_at:z.iso.datetime({offset:true}).nullable(),
});
