import { setTimeout as sleep } from 'node:timers/promises';
import type { ChannelFacts, VideoItem, WorkflowInput } from '@crawlsystem/contracts';
import { RawArchive, captureFetch, type RawReference, type RawResponse } from '../raw-archive.ts';
import { FingerprintClient, FingerprintError } from './fingerprint.ts';
import { LeaseClient, ProxyUnavailable, type Outcome } from './transport.ts';
import { DataApi, type RequestGuard } from './data-api.ts';
import { ScrapeError } from './scrape.ts';
import { toVideoFacts, unavailableVideo } from './map.ts';
import { browserSession, channelFacts, uploads, videoDetail } from './web-scrape.ts';

export interface CollectionContext { owner: WorkflowInput; channelId: string; signal: AbortSignal; deadline: number; note: (message: string) => Promise<void>; guard: RequestGuard; }
export const webOperations = { browserSession, channelFacts, uploads, videoDetail };
export class WebCollector {
  constructor(private gateway: FingerprintClient, private proxies: LeaseClient, private archive: RawArchive, private dataApi: DataApi, readonly enforceBrazil = false, private operations = webOperations) {}
  private async web<T>(ctx: CollectionContext, responses: RawResponse[], work: (yt: Awaited<ReturnType<typeof browserSession>>) => Promise<T>): Promise<T> {
    for (;;) {
      ctx.signal.throwIfAborted();
      if (Date.now() >= ctx.deadline) throw new ScrapeError('upstream', 'Collection deadline elapsed');
      let lease;
      try { lease = await this.proxies.acquire(Math.max(5000, Math.min(180_000, ctx.deadline - Date.now())), this.enforceBrazil ? 'BR' : undefined); }
      catch (error) {
        if (!(error instanceof ProxyUnavailable)) throw error;
        await ctx.note(`Waiting for proxy: ${error.reason}`);
        if (Date.now() + error.waitMs >= ctx.deadline) throw new ScrapeError('upstream', 'No proxy before collection deadline');
        await sleep(Math.min(error.waitMs, 30_000), undefined, { signal: ctx.signal }); continue;
      }
      const start = Date.now(); let outcome: Outcome = 'success', errorClass: string | undefined;
      try {
        return await this.gateway.withProfile(lease, ctx.signal, async transport => {
          await ctx.note(`identity=${transport.identity.profile_id}; pt-BR / BR / America/Sao_Paulo; proxy=${lease.proxy_id ?? 'unknown'}; egress=${lease.egress_country ?? 'unknown'}; clients=WEB,IOS`);
          try { return await work(await this.operations.browserSession(captureFetch(transport.fetch, responses), transport.identity)); }
          finally {
            const failure = transport.failureKind?.();
            if (failure && !ctx.signal.aborted) { outcome = failure === 'blocked' ? 'blocked' : 'failure'; errorClass = `web_${outcome}`; }
          }
        });
      } catch (error) {
        if (!ctx.signal.aborted && (error instanceof ScrapeError && ['blocked', 'network'].includes(error.kind) || error instanceof FingerprintError && error.penalizeProxy)) {
          outcome = error instanceof ScrapeError && error.kind === 'blocked' ? 'blocked' : 'failure'; errorClass = `web_${outcome}`;
          await ctx.note(`proxy=${lease.proxy_id ?? 'unknown'}; failure=${outcome === 'blocked' ? 'bot_challenge_or_rate_limit' : 'transport'}`).catch(() => {});
        }
        throw error;
      } finally { await this.proxies.release(lease, outcome, Date.now() - start, errorClass); }
    }
  }
  private async unit<T>(ctx: CollectionContext, step: string, unitId: string, work: (responses: RawResponse[]) => Promise<T>) {
    const reused = await this.archive.reuse<T>(ctx.owner, ctx.channelId, step, unitId, ctx.signal);
    if (reused) return reused;
    const responses: RawResponse[] = [];let result:T;
    try{result=await work(responses);}catch(error){await this.preserveFailure(ctx,step,unitId,responses,error);throw error;}
    const reference = await this.archive.save({ schema_version: 'crawl.unit.v1', owner: ctx.owner, channel_id: ctx.channelId, step, unit_id: unitId,
      captured_at: new Date().toISOString(), responses, result }, ctx.signal);
    return { result, reference };
  }
  private async preserveFailure(ctx:CollectionContext,step:string,unit:string,responses:RawResponse[],error:unknown) {
    if(ctx.signal.aborted||!(error instanceof Error))return;
    try {Object.assign(error,{raw_evidence:await this.archive.failure(ctx.owner,step,unit,responses,'COLLECTION_FAILED')});}catch{ /* The execution error still survives a storage outage. */ }
  }
  async about(ctx: CollectionContext): Promise<ChannelFacts> {
    const unit = await this.unit(ctx, 'ABOUT', 'channel', responses => this.web(ctx, responses, yt => this.operations.channelFacts(yt, ctx.channelId)));
    await this.archive.finish(ctx.owner, ctx.channelId, 'ABOUT', [unit.reference], ctx.signal);
    return unit.result;
  }
  async targets(ctx: CollectionContext, limit: number, anchors?: string[]) {
    const unit = await this.unit(ctx, 'TARGETS', 'uploads', responses => this.web(ctx, responses, yt => this.operations.uploads(yt, ctx.channelId, Math.min(limit, 100), anchors)));
    await this.archive.finish(ctx.owner, ctx.channelId, 'TARGETS', [unit.reference], ctx.signal);
    return unit.result;
  }
  /** Save every completed video immediately. Only exhausted web details enter the quota-bound API batch. */
  async videos(ctx: CollectionContext, ids: string[], commentLimit: number, step: string, metricsOnly = false): Promise<VideoItem[]> {
    const results = new Map<string, VideoItem>(), references = new Map<string, RawReference>();
    const fallback = new Map<string, RawResponse[]>();
    for (const id of ids) {
      ctx.signal.throwIfAborted();
      const reused = await this.archive.reuse<VideoItem>(ctx.owner, ctx.channelId, step, id, ctx.signal);
      if (reused) { results.set(id, reused.result); references.set(id, reused.reference); continue; }
      const responses: RawResponse[] = [];
      let result: VideoItem | undefined;
      for (let attempt = 1; attempt <= (metricsOnly ? 1 : 3); attempt++) {
        try { result = await this.web(ctx, responses, yt => this.operations.videoDetail(yt, ctx.channelId, id, commentLimit, metricsOnly, responses)); break; }
        catch (error) {
          ctx.signal.throwIfAborted();
          if (!(error instanceof ScrapeError) && !(error instanceof FingerprintError)) {await this.preserveFailure(ctx,step,id,responses,error);throw error;}
          if (error instanceof ScrapeError && error.kind === 'not_found') { result = unavailableVideo(ctx.channelId, id, new Date().toISOString()); result.source = 'youtubei:video'; break; }
          if (error instanceof FingerprintError && error.kind === 'gateway' || error instanceof ScrapeError && error.kind === 'upstream') {await this.preserveFailure(ctx,step,id,responses,error);throw error;}
          await ctx.note(`video=${id}; web_attempt=${attempt}; result=${error instanceof ScrapeError ? error.kind : 'transport'}`);
        }
      }
      if (!result) { fallback.set(id, responses); continue; }
      const reference = await this.archive.save({ schema_version: 'crawl.unit.v1', owner: ctx.owner, channel_id: ctx.channelId, step, unit_id: id,
        captured_at: new Date().toISOString(), responses, result }, ctx.signal);
      results.set(id, result); references.set(id, reference);
    }
    const failedIds = [...fallback.keys()];
    for (let start = 0; start < failedIds.length; start += 50) {
      const batch = failedIds.slice(start, start + 50), apiResponses: RawResponse[] = [];
      const guard: RequestGuard = { ...ctx.guard, response: (endpoint, status, body) => { apiResponses.push({ endpoint: `https://www.googleapis.com/youtube/v3/${endpoint}`, method: 'GET', status, body, captured_at: new Date().toISOString() }); } };
      let apiVideos:Map<string,import('./map.ts').ApiVideo>;
      try{apiVideos=new Map((await this.dataApi.videos(batch,guard)).map(v=>[v.id,v]));}
      catch(error){await this.preserveFailure(ctx,step,batch[0]!,[...batch.flatMap(id=>fallback.get(id)??[]),...apiResponses],error);throw error;}
      await ctx.note(`Data API fallback: ${batch.length} videos after ${metricsOnly ? 'lightweight web detail failure' : '3 web attempts'}`);
      for (const id of batch) {
        const api = apiVideos.get(id), responses = [...fallback.get(id)!, ...apiResponses];
        // Comments always use the web, including when the video's details came from the API.
        let comments: import('./map.ts').CommentsResult = { kind: 'skipped' };
        if (api && commentLimit && !metricsOnly) {
          const { topComments } = await import('./scrape.ts');
          comments = await this.web(ctx, responses, yt => topComments(yt, id, api.statistics?.commentCount, 'pt-BR')).catch(() => ({ kind: 'unavailable' as const, collected_at: new Date().toISOString() }));
          ctx.signal.throwIfAborted();
        }
        if (api && api.snippet.channelId !== ctx.channelId) throw new ScrapeError('parse', 'API fallback channel mismatch');
        const result = api ? toVideoFacts(api, null, comments, commentLimit, new Date().toISOString()) : unavailableVideo(ctx.channelId, id, new Date().toISOString());
        const reference = await this.archive.save({ schema_version: 'crawl.unit.v1', owner: ctx.owner, channel_id: ctx.channelId, step, unit_id: id,
          captured_at: new Date().toISOString(), responses, result }, ctx.signal);
        results.set(id, result); references.set(id, reference);
      }
    }
    await this.archive.finish(ctx.owner, ctx.channelId, step, ids.map(id => references.get(id)!), ctx.signal);
    return ids.map(id => results.get(id)!);
  }
  diagnostics() { return this.gateway.diagnostics(this.enforceBrazil); }
}
