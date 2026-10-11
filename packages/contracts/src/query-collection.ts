import {z} from 'zod';
import {QuerySourceTypeSchema,YoutubeChannelIdSchema,YoutubeVideoIdSchema} from './index.ts';
import {QueryCollectionLimitsSchema} from './configuration.ts';
const count=z.number().int().nonnegative();
export const QueryCollectionSummarySchema=z.strictObject({
  observed_at:z.iso.datetime(),limits:QueryCollectionLimitsSchema,created_today:count,woken_today:count,auto_bindings:count,
  candidates:count,waiting_support:count,waiting_promotion:count,candidate_limit:z.literal(20000),
  scanned_channels:count,skipped_channels:count,last_scan_at:z.iso.datetime().nullable(),
  limited:z.enum(['disabled','daily','total','candidates']).nullable(),
});
export type QueryCollectionSummary=z.infer<typeof QueryCollectionSummarySchema>;
export const QuerySourceDetailSchema=z.strictObject({
  type:QuerySourceTypeSchema,ref:z.string().max(300),created_at:z.iso.datetime(),
  channel_id:YoutubeChannelIdSchema.nullable(),video_id:YoutubeVideoIdSchema.nullable(),
});
export const QuerySourcesSchema=z.strictObject({items:z.array(QuerySourceDetailSchema).max(100),next_cursor:z.string().nullable()});
