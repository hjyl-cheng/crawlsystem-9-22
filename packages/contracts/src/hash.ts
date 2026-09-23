import { createHash } from 'node:crypto';
import { CONTRACT_VERSION, type Domain, type PlanInput, type Submission } from './index.ts';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new TypeError('Only finite JSON values can be hashed');
}
export function contentHash(value: unknown): string { return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`; }
export function submissionHash(value: Omit<Submission, 'payload_hash'> | Submission): string {
  const { payload_hash: _ignored, ...body } = value as Submission;
  return contentHash(body);
}
/** RFC 9562 UUIDv8: application-defined SHA-256 identity, stable across retries. */
export function stableSubmissionId(plan_id: string, execution_epoch: number, domain: Domain, logical_batch_key: string): string {
  const bytes = createHash('sha256').update(canonicalJson([CONTRACT_VERSION, plan_id, execution_epoch, domain, logical_batch_key])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function fixtureSubmission(context: PlanInput, domain: 'ABOUT' | 'VIDEO'): Submission {
  const logical_batch_key = `${domain.toLowerCase()}:all:v1`;
  const base = { schema_version: CONTRACT_VERSION, submission_id: stableSubmissionId(context.plan.plan_id, context.plan.execution_epoch, domain, logical_batch_key),
    plan_id: context.plan.plan_id, execution_epoch: context.plan.execution_epoch, input_hash: context.plan.input_hash, logical_batch_key, domain_complete: true };
  const body = domain === 'ABOUT' ? { ...base, domain, payload: context.input.sample.about } : { ...base, domain, payload: context.input.sample.videos };
  return { ...body, payload_hash: submissionHash(body as Omit<Submission, 'payload_hash'>) } as Submission;
}
