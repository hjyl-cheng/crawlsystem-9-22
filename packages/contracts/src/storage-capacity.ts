import {z} from 'zod';

export const STORAGE_BUCKETS=[
  {bucket:'crawl-raw',label:'原始响应',retention_days:1},
  {bucket:'crawl-parsed',label:'解析结果与评论',retention_days:90},
  {bucket:'crawl-evidence',label:'失败证据',retention_days:90},
] as const;
const Bytes=z.number().int().nonnegative().safe().nullable();
export const StorageCapacitySchema=z.strictObject({
  source:z.literal('prometheus'),observed_at:z.iso.datetime({offset:true}),available:z.boolean(),
  sampled_at:z.iso.datetime({offset:true}).nullable(),scan_age_seconds:z.number().nonnegative().nullable(),
  warning_percent:z.literal(70),critical_percent:z.literal(85),
  disk:z.strictObject({total_bytes:Bytes,free_bytes:Bytes}),
  buckets:z.array(z.strictObject({
    bucket:z.enum(['crawl-raw','crawl-parsed','crawl-evidence']),label:z.string(),retention_days:z.number().int().positive(),
    used_bytes:Bytes,quota_bytes:Bytes,remaining_bytes:Bytes,objects:Bytes,
    used_percent:z.number().nonnegative().nullable(),state:z.enum(['ok','warning','critical','unknown']),
  })).length(3),
});
export type StorageCapacity=z.infer<typeof StorageCapacitySchema>;
