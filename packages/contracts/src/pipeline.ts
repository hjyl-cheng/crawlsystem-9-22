import { z } from 'zod';
import type { ChannelFacts,AgentResult,VideoItem,VideoSamples,VideoTargetManifest,VideoDiscoveryManifest } from './index.ts';
import { AgentResultSchema, ChannelFactsSchema, IdSchema, ObjectStorageReferenceSchema, StoredCommentSummarySchema, VideoItemSchema, VideoSamplesSchema, VideoTargetManifestSchema, VideoDiscoveryManifestSchema, WorkflowInputSchema } from './index.ts';

export const ObjectReferenceSchema = ObjectStorageReferenceSchema;
export type ObjectReference = z.infer<typeof ObjectReferenceSchema>;
export const CommentSummarySchema = StoredCommentSummarySchema;
export const PipelineStepSchema = z.string().regex(/^(ABOUT|TARGETS|VIDEO-\d{1,2}|SAMPLING|AGENT)$/);
export const RawReferenceSchema = ObjectReferenceSchema.extend({ schema_version: z.literal('crawl.raw.v1'), workspace_id: IdSchema,
  plan_id: z.uuid(), execution_epoch: z.number().int().positive(), input_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/), channel_id: IdSchema,
  step: PipelineStepSchema, unit_id: IdSchema, captured_at: z.iso.datetime({ offset: true }) });
export type RawReference = z.infer<typeof RawReferenceSchema>;
export const StepManifestSchema = z.strictObject({ schema_version: z.literal('crawl.step.v1'), owner: WorkflowInputSchema, channel_id: IdSchema,
  step: PipelineStepSchema, units: z.array(RawReferenceSchema).max(100), completed_at: z.iso.datetime({ offset: true }),
  bucket: z.literal('crawl-raw'), key: z.string().max(1024) }).refine(m => new Set(m.units.map(u => u.key)).size === m.units.length
    && m.units.every(u => u.plan_id === m.owner.plan_id && u.workspace_id === m.owner.workspace_id && u.execution_epoch === m.owner.execution_epoch
      && u.input_hash === m.owner.input_hash && u.channel_id === m.channel_id && u.step === m.step), 'Step ownership or unit identity mismatch');
export type StepManifest = z.infer<typeof StepManifestSchema>;
const Common = { schema_version: z.literal('crawl.fact.v1'), raw: RawReferenceSchema, parsed: ObjectReferenceSchema,
  parser_version: z.literal('youtube-raw/1'), source_revision: z.number().int().positive() };
// Video facts retain comment metadata and an object reference, never comment bodies.
export const StoredVideoSchema = VideoItemSchema.refine(v => 'unavailable' in v || !v.comments_first_page?.comments.length, 'Comment bodies belong in MinIO');
interface FactReference { schema_version:'crawl.fact.v1'; raw:RawReference;parsed:ObjectReference;parser_version:'youtube-raw/1';source_revision:number; }
export type PipelineFact = FactReference & (
  {kind:'ABOUT';payload:ChannelFacts} | {kind:'TARGETS';payload:VideoTargetManifest|VideoDiscoveryManifest}
  | {kind:'VIDEO';payload:VideoItem} | {kind:'SAMPLING';payload:VideoSamples} | {kind:'AGENT';payload:AgentResult}
);
export const PipelineFactSchema: z.ZodType<PipelineFact> = z.discriminatedUnion('kind', [
  z.strictObject({ ...Common, kind: z.literal('ABOUT'), payload: ChannelFactsSchema }),
  z.strictObject({ ...Common, kind: z.literal('TARGETS'), payload: z.union([VideoTargetManifestSchema, VideoDiscoveryManifestSchema]) }),
  z.strictObject({ ...Common, kind: z.literal('VIDEO'), payload: StoredVideoSchema }),
  z.strictObject({ ...Common, kind: z.literal('SAMPLING'), payload: VideoSamplesSchema }),
  z.strictObject({ ...Common, kind: z.literal('AGENT'), payload: AgentResultSchema }),
]);
export const PipelineProgressSchema = z.strictObject({ plan_id: z.uuid(), steps: z.array(z.strictObject({ step: PipelineStepSchema,
  expected: z.number().int().nonnegative(), applied: z.number().int().nonnegative(), state: z.enum(['PENDING','APPLIED']),
  last_reconciled_at: z.iso.datetime({ offset: true }).nullable() })).max(30) });
export type PipelineProgress = z.infer<typeof PipelineProgressSchema>;
