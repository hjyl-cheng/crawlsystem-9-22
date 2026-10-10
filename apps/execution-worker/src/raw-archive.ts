import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { AwsClient } from 'aws4fetch';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import type { WorkflowInput } from '@crawlsystem/contracts';

export interface RawResponse { endpoint: string; method: string; status: number; captured_at: string; body: string; client?: string; }
export interface RawUnit<T = unknown> {
  schema_version: 'crawl.unit.v1'; owner: WorkflowInput; channel_id: string; step: string; unit_id: string; captured_at: string;
  responses: RawResponse[];
  /** R2 compatibility projection; R3 will parse the original responses independently. */
  result: T;
}
export interface RawReference { schema_version: 'crawl.raw.v1'; workspace_id: string; plan_id: string; execution_epoch: number; input_hash: string; channel_id: string;
  step: string; unit_id: string; bucket: string; key: string; sha256: string; bytes: number; captured_at: string; }
export class ArchiveError extends Error { constructor(readonly stage: 'storage' | 'publish' | 'integrity', readonly code = 'UNAVAILABLE') { super(`Raw archive ${stage} failed`); this.name = 'ArchiveError'; } }
export interface ObjectStore { get(key: string, signal: AbortSignal): Promise<Uint8Array | null>; put(key: string, bytes: Uint8Array, signal: AbortSignal, ifAbsent?: boolean): Promise<void>; }
export interface RawPublisher { send(topic: 'crawl.raw' | 'crawl.step', channelId: string, message: unknown): Promise<void>; }
export class MinioStore implements ObjectStore {
  private signer: AwsClient;
  constructor(private endpoint: string, private bucket: string, accessKey: string, secretKey: string, private fetcher: typeof fetch = fetch) {
    this.signer = new AwsClient({ accessKeyId: accessKey, secretAccessKey: secretKey, service: 's3', region: 'us-east-1' });
  }
  private async request(key: string, init: RequestInit, signal: AbortSignal) {
    const url = `${this.endpoint}/${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetcher(await this.signer.sign(url, init), { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
        if (response.status >= 500 && attempt < 2) { await response.body?.cancel(); continue; }
        return response;
      } catch { signal.throwIfAborted(); if (attempt >= 2) throw new ArchiveError('storage'); }
    }
  }
  async get(key: string, signal: AbortSignal) {
    const response = await this.request(key, { method: 'GET' }, signal);
    if (response.status === 404) return null;
    if (!response.ok) throw new ArchiveError('storage');
    return new Uint8Array(await response.arrayBuffer());
  }
  async put(key: string, bytes: Uint8Array, signal: AbortSignal, ifAbsent = false) {
    const response = await this.request(key, { method: 'PUT', headers: { 'content-type': 'application/gzip', ...(ifAbsent ? { 'if-none-match': '*' } : {}) }, body: Buffer.from(bytes) }, signal);
    if (!response.ok) throw new ArchiveError('storage');
    await response.body?.cancel();
  }
}
export class KafkaPublisher implements RawPublisher {
  private producer: Producer; private connected?: Promise<void>;
  constructor(brokers: string[], username: string, password: string, ca: string) {
    const kafka = new Kafka({ clientId: 'crawl-worker', brokers, ssl: { ca: [ca] }, sasl: { mechanism: 'scram-sha-512', username, password }, logLevel: logLevel.NOTHING,
      connectionTimeout: 5000, requestTimeout: 15_000, retry: { retries: 3 } });
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false });
  }
  async send(topic: 'crawl.raw' | 'crawl.step', channelId: string, message: unknown) {
    try {
      this.connected ??= this.producer.connect().catch(error => { this.connected = undefined; throw error; }); await this.connected;
      await this.producer.send({ topic, acks: -1, messages: [{ key: channelId, value: JSON.stringify(message) }] });
    } catch (error) {
      const code = (error as { type?: string }).type;
      const known = ['CLUSTER_AUTHORIZATION_FAILED', 'TOPIC_AUTHORIZATION_FAILED', 'SASL_AUTHENTICATION_FAILED', 'NOT_ENOUGH_REPLICAS', 'REQUEST_TIMED_OUT', 'NETWORK_EXCEPTION', 'UNKNOWN_TOPIC_OR_PARTITION'];
      throw new ArchiveError('publish', code && known.includes(code) ? code : 'UNAVAILABLE');
    }
  }
  async close() { await this.producer.disconnect(); }
}
export class RawArchive {
  constructor(private store: ObjectStore, private publisher: RawPublisher, private bucket = 'crawl-raw') {}
  key(owner: WorkflowInput, step: string, unitId: string) {
    return `v1/${encodeURIComponent(owner.workspace_id)}/${owner.plan_id}/${owner.execution_epoch}/${step}/${unitId}.json.gz`;
  }
  private reference(unit: RawUnit, bytes: Uint8Array): RawReference {
    return { schema_version: 'crawl.raw.v1', workspace_id: unit.owner.workspace_id, plan_id: unit.owner.plan_id, execution_epoch: unit.owner.execution_epoch, input_hash: unit.owner.input_hash,
      channel_id: unit.channel_id, step: unit.step, unit_id: unit.unit_id, bucket: this.bucket, key: this.key(unit.owner, unit.step, unit.unit_id),
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, captured_at: unit.captured_at };
  }
  async reuse<T>(owner: WorkflowInput, channelId: string, step: string, unitId: string, signal: AbortSignal): Promise<{ result: T; reference: RawReference } | null> {
    const bytes = await this.store.get(this.key(owner, step, unitId), signal);
    if (!bytes) return null;
    let unit: RawUnit<T>;
    try { unit = JSON.parse(gunzipSync(bytes).toString()) as RawUnit<T>; } catch { throw new ArchiveError('integrity'); }
    if (unit.schema_version !== 'crawl.unit.v1' || unit.owner.input_hash !== owner.input_hash || unit.owner.plan_id !== owner.plan_id || unit.owner.execution_epoch !== owner.execution_epoch || unit.channel_id !== channelId || unit.step !== step || unit.unit_id !== unitId) throw new ArchiveError('integrity');
    const reference = this.reference(unit, bytes);
    signal.throwIfAborted(); await this.publisher.send('crawl.raw', channelId, reference);
    return { result: unit.result, reference };
  }
  async save<T>(unit: RawUnit<T>, signal: AbortSignal): Promise<RawReference> {
    const bytes = gzipSync(JSON.stringify(unit)), reference = this.reference(unit, bytes);
    // Concurrent late attempts cannot replace a completed unit. A conflict retries through reuse().
    await this.store.put(reference.key, bytes, signal, true);
    // A notification only ever names an object whose PUT succeeded. Reuse republishes after a crash in this gap.
    signal.throwIfAborted(); await this.publisher.send('crawl.raw', unit.channel_id, reference);
    return reference;
  }
  async finish(owner: WorkflowInput, channelId: string, step: string, references: RawReference[], signal: AbortSignal) {
    const manifest = { schema_version: 'crawl.step.v1', owner, channel_id: channelId, step, units: references, completed_at: new Date().toISOString() };
    const key = this.key(owner, step, '_manifest');
    await this.store.put(key, gzipSync(JSON.stringify(manifest)), signal);
    signal.throwIfAborted(); await this.publisher.send('crawl.step', channelId, { ...manifest, bucket: this.bucket, key });
  }
}
/** Capture unchanged response bodies, without cookies, proxy credentials or Data API keys in metadata. */
export function captureFetch(fetcher: typeof fetch, responses: RawResponse[]): typeof fetch {
  return async (input, init) => {
    let client: string | undefined;
    try {
      const requestBody = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : null;
      const name = requestBody ? JSON.parse(requestBody)?.context?.client?.clientName : undefined;
      if (typeof name === 'string' && /^[A-Z_]{1,40}$/.test(name)) client = name;
    } catch { /* Some endpoints use binary bodies. */ }
    const response = await fetcher(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = await response.clone().text();
    responses.push({ endpoint: url.origin + url.pathname, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), status: response.status, captured_at: new Date().toISOString(), body, ...(client ? { client } : {}) });
    return response;
  };
}
