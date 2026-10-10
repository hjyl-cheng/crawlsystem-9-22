import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Innertube, Log } from 'youtubei.js';
import { AgentResultSchema, CommentPageSchema, type PlanInput, type VideoItem, type YoutubeFrozenInput } from '@crawlsystem/contracts';
import { contentHash } from '@crawlsystem/contracts/hash';
import { PipelineFactSchema, RawReferenceSchema, type PipelineFact, type RawReference, type ObjectReference } from '@crawlsystem/contracts/pipeline';
import type { ObjectStore, RawResponse, RawUnit } from '../../execution-worker/src/raw-archive.ts';
import { channelFacts, uploads, videoDetail } from '../../execution-worker/src/youtube/web-scrape.ts';
import { topComments } from '../../execution-worker/src/youtube/scrape.ts';
import { toVideoFacts, unavailableVideo } from '../../execution-worker/src/youtube/map.ts';
import { ScrapeError } from '../../execution-worker/src/youtube/scrape.ts';
import type { ApiVideo } from '../../execution-worker/src/youtube/map.ts';

Log.setLevel(Log.Level.NONE);
export class ParseFailure extends Error {
  constructor(readonly code: 'INTEGRITY' | 'REPLAY_INCOMPLETE' | 'INVALID_FACT' | 'INPUT_MISMATCH') { super(`Raw parse ${code}`); this.name = 'ParseFailure'; }
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Every fetch is served from the captured unit. No parser request can reach YouTube. */
export class ResponseReplay {
  readonly played: RawResponse[] = [];
  private remaining: RawResponse[];
  constructor(readonly responses: RawResponse[]) { this.remaining = [...responses]; }
  fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url); let client: string | undefined;
    try { client = JSON.parse(await request.clone().text()).context?.client?.clientName; } catch {}
    const index = this.remaining.findIndex(r => r.endpoint === url.origin + url.pathname && r.method === request.method
      && (!r.client || !client || r.client === client));
    if (index < 0) throw new ParseFailure('REPLAY_INCOMPLETE');
    const r = this.remaining.splice(index, 1)[0]!; this.played.push(r);
    return new Response([204,205,304].includes(r.status) ? null : r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  client() { return Innertube.create({ fetch: this.fetch, lang: 'pt-BR', location: 'BR', timezone: 'America/Sao_Paulo', retrieve_player: false,
    generate_session_locally: true, retrieve_innertube_config: false, enable_session_cache: false }); }
}
export interface ParserOptions { raw: ObjectStore; parsed: ObjectStore; loadPlan: (ref: RawReference) => Promise<PlanInput>;
  publish: (topic: 'facts.channel' | 'facts.video' | 'facts.observation' | 'facts.agent', channelId: string, fact: PipelineFact) => Promise<void>; }
interface ParsedUnit { schema_version: 'crawl.parsed.v1'; raw: RawReference; parser_version: 'youtube-raw/1'; source_revision: number; kind: PipelineFact['kind']; payload: unknown; }
export class RawParser {
  constructor(private options: ParserOptions) {}
  private async put(key: string, value: unknown, signal: AbortSignal): Promise<ObjectReference> {
    const bytes = gzipSync(JSON.stringify(value));
    try { await this.options.parsed.put(key, bytes, signal, true); }
    catch (error) {
      const previous = await this.options.parsed.get(key, signal);
      if (!previous || !Buffer.from(previous).equals(bytes)) throw error;
    }
    return { bucket: 'crawl-parsed', key, sha256: hash(bytes), bytes: bytes.length };
  }
  async parse(rawInput: unknown, signal: AbortSignal): Promise<PipelineFact | null> {
    const raw = RawReferenceSchema.parse(rawInput), plan = await this.options.loadPlan(raw);
    if (!('pipeline_version' in plan.input) || plan.input.pipeline_version !== 'r3.v1') return null;
    if (plan.plan.workspace_id !== raw.workspace_id || plan.plan.plan_id !== raw.plan_id || plan.plan.channel_id !== raw.channel_id
      || plan.plan.input_hash !== raw.input_hash || contentHash(plan.input) !== raw.input_hash) throw new ParseFailure('INPUT_MISMATCH');
    const expected = `v1/${encodeURIComponent(raw.workspace_id)}/${raw.plan_id}/${raw.execution_epoch}/${raw.step}/${raw.unit_id}.json.gz`;
    if (raw.bucket !== 'crawl-raw' || raw.key !== expected) throw new ParseFailure('INTEGRITY');
    const parsedKey = `v1/${encodeURIComponent(raw.workspace_id)}/${raw.plan_id}/${raw.execution_epoch}/${raw.step}/${raw.unit_id}.youtube-raw-1.${raw.sha256}.json.gz`;
    let bytes = await this.options.parsed.get(parsedKey, signal), record: ParsedUnit;
    if (bytes) {
      record = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString());
      if (contentHash(record.raw) !== contentHash(raw) || record.parser_version !== 'youtube-raw/1') throw new ParseFailure('INTEGRITY');
    } else {
      const source = await this.options.raw.get(raw.key, signal);
      if (!source || source.length !== raw.bytes || hash(source) !== raw.sha256) throw new ParseFailure('INTEGRITY');
      const unit: RawUnit = JSON.parse(gunzipSync(source, { maxOutputLength: 64 * 1024 * 1024 }).toString());
      if (unit.schema_version !== 'crawl.unit.v1' || unit.owner.plan_id !== raw.plan_id || unit.owner.execution_epoch !== raw.execution_epoch
        || unit.owner.workspace_id !== raw.workspace_id || unit.owner.input_hash !== raw.input_hash || unit.step !== raw.step
        || unit.unit_id !== raw.unit_id || unit.channel_id !== raw.channel_id || unit.captured_at !== raw.captured_at) throw new ParseFailure('INTEGRITY');
      const data = await this.decode(unit, plan, raw, signal);
      record = { schema_version: 'crawl.parsed.v1', raw, parser_version: 'youtube-raw/1', source_revision: plan.plan.source_revision, ...data };
      const ref = await this.put(parsedKey, record, signal); bytes = await this.options.parsed.get(ref.key, signal);
      if (!bytes) throw new ParseFailure('INTEGRITY');
    }
    const fact = PipelineFactSchema.parse({ ...record, schema_version: 'crawl.fact.v1', parsed: { bucket: 'crawl-parsed', key: parsedKey, sha256: hash(bytes), bytes: bytes.length } });
    const topic = fact.kind === 'ABOUT' ? 'facts.channel' : fact.kind === 'AGENT' ? 'facts.agent' : fact.kind === 'SAMPLING' ? 'facts.observation' : 'facts.video';
    await this.options.publish(topic, raw.channel_id, fact); return fact;
  }
  private async decode(unit: RawUnit, plan: PlanInput, raw: RawReference, signal: AbortSignal): Promise<Pick<ParsedUnit,'kind'|'payload'>> {
    const input = plan.input, replay = new ResponseReplay(unit.responses), observed = raw.captured_at;
    if (unit.step === 'AGENT') {
      const generated = unit.responses.find(r => r.endpoint === 'local:profile-agent');
      if (!generated) throw new ParseFailure('REPLAY_INCOMPLETE');
      return { kind: 'AGENT', payload: AgentResultSchema.parse(JSON.parse(generated.body)) };
    }
    if (input.source_mode === 'fixture') {
      const fixture = unit.responses.find(r => r.endpoint === 'local:fixture');
      if (!fixture) throw new ParseFailure('REPLAY_INCOMPLETE');
      return { kind: unit.step === 'ABOUT' ? 'ABOUT' : 'VIDEO', payload: unit.step === 'ABOUT' ? input.sample.about : await this.comments(input.sample.videos.find(v => v.source_content_id === unit.unit_id)!, raw, signal) };
    }
    if (unit.step === 'ABOUT') return { kind: 'ABOUT', payload: await channelFacts(await replay.client(), raw.channel_id, observed) };
    if (unit.step === 'TARGETS') {
      const listed = await uploads(await replay.client(), raw.channel_id, input.plan_kind === 'UPDATE' ? 100 : input.scope.video_limit, input.plan_kind === 'UPDATE' ? input.discovery_anchor_ids ?? [] : undefined);
      return { kind: 'TARGETS', payload: input.plan_kind === 'UPDATE' ? { kind: 'discovery', channel_id: raw.channel_id, video_ids: listed.ids,
        listed_at: observed, scanned_count: listed.scanned, pages: listed.pages, matched_anchor_id: listed.matched_anchor_id, stop_reason: listed.stop_reason, source: 'youtubei:uploads' }
        : { kind: 'targets', channel_id: raw.channel_id, video_ids: listed.ids, listed_at: observed, window_start: new Date(0).toISOString(), exhausted: listed.exhausted, source: 'youtubei:uploads' } };
    }
    const video = await this.video(replay, input, raw);
    if (unit.step === 'SAMPLING') return { kind: 'SAMPLING', payload: { kind: 'samples', observed_at: observed, source: 'youtubei:video_or_api_fallback',
      items: 'unavailable' in video ? [] : [{ video_id: raw.unit_id, view_count: video.view_count.value, like_count: video.like_count.value, comment_count: video.comment_count.value,
        metrics:{view_count:video.view_count,like_count:video.like_count,comment_count:video.comment_count} }],
      missing_video_ids: 'unavailable' in video ? [raw.unit_id] : [] } };
    if (!/^VIDEO-\d+$/.test(unit.step)) throw new ParseFailure('INVALID_FACT');
    return { kind: 'VIDEO', payload: await this.comments(video, raw, signal) };
  }
  private async comments(video: VideoItem, raw: RawReference, signal: AbortSignal): Promise<VideoItem> {
    if ('unavailable' in video) return video;
    const page = video.comments_first_page;
    if (!page) return { ...video, comments_first_page: null, comments_ref: null, comments_summary: null };
    const comments = CommentPageSchema.parse(page), { comments: _body, ...summary } = comments;
    const key = `v1/${encodeURIComponent(raw.workspace_id)}/${raw.plan_id}/${raw.execution_epoch}/comments/${raw.unit_id}.${raw.sha256}.json.gz`;
    const ref = await this.put(key, comments, signal);
    return { ...video, comments_first_page: null, comments_ref: ref, comments_summary: summary };
  }
  private async video(replay: ResponseReplay, input: YoutubeFrozenInput, raw: RawReference): Promise<VideoItem> {
    for (let attempt = 0; attempt < (raw.step === 'SAMPLING' ? 1 : 3); attempt++) {
      try { return await videoDetail(await replay.client(), raw.channel_id, raw.unit_id, input.scope.comments_per_video, raw.step === 'SAMPLING', replay.played, raw.captured_at); }
      catch(error) {
        if(error instanceof ScrapeError && error.kind==='not_found') {
          const missing=unavailableVideo(raw.channel_id,raw.unit_id,raw.captured_at);
          missing.source='youtubei:video';missing.reason='The captured YouTube video response reported this upload as unavailable';return missing;
        }
        /* The same captured attempts precede the recorded, quota-controlled API fallback. */
      }
    }
    // Fallback must be evidenced by an actual captured Data API response, never the R2 projection.
    const response = replay.responses.find(r => r.endpoint === 'https://www.googleapis.com/youtube/v3/videos' && r.status === 200);
    if (!response) throw new ParseFailure('REPLAY_INCOMPLETE');
    const api = (JSON.parse(response.body).items as ApiVideo[]).find(v => v.id === raw.unit_id);
    if (!api) return unavailableVideo(raw.channel_id, raw.unit_id, raw.captured_at);
    if (api.snippet.channelId !== raw.channel_id) throw new ParseFailure('INVALID_FACT');
    const comments = raw.step === 'SAMPLING' || !input.scope.comments_per_video ? { kind: 'skipped' as const }
      : await topComments(await replay.client(), raw.unit_id, api.statistics?.commentCount, 'pt-BR', raw.captured_at).catch(() => ({ kind: 'unavailable' as const, collected_at: raw.captured_at }));
    return toVideoFacts(api, null, comments, input.scope.comments_per_video, raw.captured_at);
  }
}
