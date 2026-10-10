import {z} from 'zod';
export const DeliveryStateSchema=z.enum(['PENDING','DELIVERED','FAILED','NOT_READY','UNCHANGED']);
export const DeliveryRecordSchema=z.strictObject({delivery_id:z.uuid(),channel_id:z.string(),title:z.string().nullable(),plan_id:z.uuid().nullable(),revision:z.number().int().nonnegative(),status:DeliveryStateSchema,target:z.string(),created_at:z.iso.datetime(),received_at:z.iso.datetime().nullable(),error_code:z.string().nullable(),attempts:z.number().int().nonnegative(),domains:z.array(z.enum(['channel','video','agent'])),receipt:z.record(z.string(),z.unknown()).nullable()});
export type DeliveryRecord=z.infer<typeof DeliveryRecordSchema>;
export const DeliverySummarySchema=z.strictObject({enabled:z.boolean(),target:z.string().nullable(),total:z.number().int().nonnegative(),pending:z.number().int().nonnegative(),delivered:z.number().int().nonnegative(),failed:z.number().int().nonnegative(),not_ready:z.number().int().nonnegative(),unchanged:z.number().int().nonnegative(),delivered_today:z.number().int().nonnegative(),oldest_pending_at:z.iso.datetime().nullable()});
export const DeliveryRetrySchema=z.strictObject({command_id:z.uuid(),reason:z.string().trim().min(3).max(500)});
export type DeliverySummary=z.infer<typeof DeliverySummarySchema>;
export const DeliveryReceiptSchema=z.strictObject({delivery_id:z.uuid(),stream_id:z.uuid(),channel_id:z.string().min(1).max(160),manifest_hash:z.string().regex(/^sha256:[a-f0-9]{64}$/),status:z.enum(['DELIVERED','FAILED','PENDING']),code:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).nullable(),verified_at:z.iso.datetime(),business_batch_id:z.string().nullable(),version_vector:z.record(z.string(),z.unknown())});
export type DeliveryReceipt=z.infer<typeof DeliveryReceiptSchema>;
