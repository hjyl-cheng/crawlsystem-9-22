import { setTimeout as sleep } from 'node:timers/promises';
import type { ChannelFacts, VideoItem, WorkflowInput } from '@crawlsystem/contracts';
import { mergeRecoveryVideoTargets } from '@crawlsystem/contracts';
import { RawArchive, captureFetch, type RawReference, type RawResponse } from '../raw-archive.ts';
import { FingerprintClient, FingerprintError } from './fingerprint.ts';
import { LeaseClient, ProxyUnavailable, type Outcome } from './transport.ts';
import { DataApi, type RequestGuard } from './data-api.ts';
import { ScrapeError } from './scrape.ts';
import { apiChannelFacts, collectedFor, toVideoFacts, unavailableVideo } from './map.ts';
import { browserSession, channelFacts, uploads, videoDetail } from './web-scrape.ts';
import {channelUnavailablePage,confirmedChannelRemoval} from './channel-removal.ts';
import { DEFAULT_REGION, RegionUnavailable, regionCode, regionalFacts } from './region.ts';
import type {ChannelRemoval} from '@crawlsystem/contracts/pipeline';

export interface CollectionContext { owner: WorkflowInput; channelId: string; signal: AbortSignal; deadline: number; note: (message: string) => Promise<void>; guard: RequestGuard; }
export const webOperations = { browserSession, channelFacts, uploads, videoDetail };
/** A country recheck waits this long at most for a busy or cooling proxy of that country. */
const REGION_WAIT_MS = 120_000;
export class WebCollector {
  private regions = new WeakMap<CollectionContext, Promise<string | null>>();
  constructor(private gateway: FingerprintClient, private proxies: LeaseClient, private archive: RawArchive, private dataApi: DataApi, readonly enforceBrazil = false, private operations = webOperations) {}
  /** One proxied session; `region` is the legacy country recheck, with that country's egress and YouTube location. */
  private async web<T>(ctx: CollectionContext, responses: RawResponse[], work: (yt: Awaited<ReturnType<typeof browserSession>>) => Promise<T>, region?: string): Promise<T> {
    const regionDeadline = Date.now() + REGION_WAIT_MS;
    for (;;) {
      ctx.signal.throwIfAborted();
      if (Date.now() >= ctx.deadline) throw new ScrapeError('upstream', 'Collection deadline elapsed');
      let lease;
      try { lease = await this.proxies.acquire(Math.max(5000, Math.min(180_000, ctx.deadline - Date.now())), region ?? (this.enforceBrazil ? 'BR' : undefined)); }
      catch (error) {
        if (!(error instanceof ProxyUnavailable)) throw error;
        // Legacy NO_COUNTRY_RESERVE: a country without a usable proxy keeps the default result instead of holding the plan.
        if (region && (error.reason === 'no_country_proxies' || Date.now() + error.waitMs > regionDeadline)) throw new RegionUnavailable(region);
        await ctx.note(`Waiting for proxy: ${error.reason}${region ? ` (${region})` : ''}`);
        if (Date.now() + error.waitMs >= ctx.deadline) throw new ScrapeError('upstream', 'No proxy before collection deadline');
        await sleep(Math.min(error.waitMs, 30_000), undefined, { signal: ctx.signal }); continue;
      }
      const start = Date.now(), first = responses.length; let outcome: Outcome = 'success', errorClass: string | undefined;
      try {
        return await this.gateway.withProfile(lease, ctx.signal, async transport => {
          await ctx.note(`identity=${transport.identity.profile_id}; pt-BR / ${region ?? DEFAULT_REGION} / America/Sao_Paulo; proxy=${lease.proxy_id ?? 'unknown'}; egress=${lease.egress_country ?? 'unknown'}; clients=WEB,IOS`);
          try { return await work(await this.operations.browserSession(captureFetch(transport.fetch, responses), transport.identity, region)); }
          finally {
            const failure = transport.failureKind?.();
            if (failure && !ctx.signal.aborted) { outcome = failure === 'blocked' ? 'blocked' : 'failure'; errorClass = `web_${outcome}`; }
            // The parser replays a regional attempt on its own, so its responses carry the country.
            if (region) for (const response of responses.slice(first)) response.region = region;
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
  /** The plan's Data API permits, keeping every response in the unit as evidence. */
  private recorded(ctx: CollectionContext, responses: RawResponse[]): RequestGuard {
    return { ...ctx.guard, response: (endpoint, status, body) => { responses.push({ endpoint: `https://www.googleapis.com/youtube/v3/${endpoint}`, method: 'GET', status, body, captured_at: new Date().toISOString() }); } };
  }
  /** The channel's own country: this plan's archived About, else one Data API lookup kept as evidence. */
  private channelRegion(ctx: CollectionContext, responses: RawResponse[]): Promise<string | null> {
    let region = this.regions.get(ctx);
    if (!region) {
      region = (async () => {
        const about = await this.archive.reuse<ChannelFacts | ChannelRemoval>(ctx.owner, ctx.channelId, 'ABOUT', 'channel', ctx.signal).catch(() => null);
        const known = about && 'country_code' in about.result ? regionCode(about.result.country_code) : null;
        return known ?? regionCode((await this.dataApi.channel(ctx.channelId, this.recorded(ctx, responses)))?.snippet.country);
      })().catch(() => null);
      this.regions.set(ctx, region);
    }
    return region;
  }
  /** Legacy country recheck: the same work again in another country; null when not applicable or that attempt fails. */
  private async inRegion<T>(ctx: CollectionContext, region: string | null, label: string, work: (region: string) => Promise<T>): Promise<T | null> {
    if (!region || region === DEFAULT_REGION) return null;
    try { const value = await work(region); await ctx.note(`${label}: rechecked in ${region}`); return value; }
    catch (error) {
      ctx.signal.throwIfAborted();
      await ctx.note(`${label}: ${error instanceof RegionUnavailable ? `no ${region} proxy reserve` : `${region} recheck failed`}; default result kept`);
      return null;
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
  async about(ctx: CollectionContext): Promise<ChannelFacts|ChannelRemoval> {
    const unit = await this.unit<ChannelFacts|ChannelRemoval>(ctx, 'ABOUT', 'channel', async responses => {
      try{return await this.web(ctx,responses,yt=>this.operations.channelFacts(yt,ctx.channelId));}
      catch(error){
        ctx.signal.throwIfAborted();
        if(!channelUnavailablePage(responses,ctx.channelId))throw error;
        const api=await this.dataApi.channel(ctx.channelId,this.recorded(ctx,responses));
        if(!api){
          if(!confirmedChannelRemoval(responses,ctx.channelId))throw error;
          return {channel_id:ctx.channelId,observed_at:new Date().toISOString(),reason:'source_removed',source:'youtubei:unavailable+data_api:absent'};
        }
        // The channel exists: its own country first, else the legacy channel API fallback.
        const regional=await this.inRegion(ctx,regionCode(api.snippet.country),'About',region=>this.web(ctx,responses,yt=>this.operations.channelFacts(yt,ctx.channelId),region));
        if(regional)return regionalFacts(regional,api);
        await ctx.note('About: channel page unavailable to this identity; facts from the Data API channel record');
        return apiChannelFacts(api,new Date().toISOString());
      }
    });
    await this.archive.finish(ctx.owner, ctx.channelId, 'ABOUT', [unit.reference], ctx.signal);
    return unit.result;
  }
  async targets(ctx: CollectionContext, limit: number, anchors?: string[], recoveryIds: string[] = []) {
    const unit = await this.unit(ctx, 'TARGETS', 'uploads', async responses => {
      const scan = (region?: string) => this.web(ctx, responses, yt => this.operations.uploads(yt, ctx.channelId, Math.min(limit, 100), anchors), region);
      const recheck = async () => this.inRegion(ctx, await this.channelRegion(ctx, responses), 'Uploads', scan);
      let listed: Awaited<ReturnType<typeof scan>>;
      // Legacy UploadsCountryRecheck: a missing or verified-empty uploads list is checked again in the channel's country.
      try { listed = await scan(); }
      catch (error) {
        if (!(error instanceof ScrapeError && error.kind === 'not_found')) throw error;
        listed = await recheck() ?? (() => { throw error; })();
      }
      if (!anchors && !listed.ids.length && listed.exhausted) listed = await recheck() ?? listed;
      return { ...listed, ids: mergeRecoveryVideoTargets(listed.ids, recoveryIds) };
    });
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
      const detail = (region?: string) => this.web(ctx, responses, yt => this.operations.videoDetail(yt, ctx.channelId, id, commentLimit, metricsOnly, responses), region);
      let result: VideoItem | undefined;
      for (let attempt = 1; attempt <= (metricsOnly ? 1 : 3); attempt++) {
        try { result = await detail(); break; }
        catch (error) {
          ctx.signal.throwIfAborted();
          if (!(error instanceof ScrapeError) && !(error instanceof FingerprintError)) {await this.preserveFailure(ctx,step,id,responses,error);throw error;}
          if (error instanceof ScrapeError && error.kind === 'not_found') { result = unavailableVideo(ctx.channelId, id, new Date().toISOString()); result.source = 'youtubei:video'; break; }
          if (error instanceof FingerprintError && error.kind === 'gateway' || error instanceof ScrapeError && error.kind === 'upstream') {await this.preserveFailure(ctx,step,id,responses,error);throw error;}
          await ctx.note(`video=${id}; web_attempt=${attempt}; result=${error instanceof ScrapeError ? error.kind : 'transport'}`);
        }
      }
      // Legacy alternate_region: a video blocked for the default identity is read again in the channel's country.
      if (result && 'unavailable' in result && result.access_status === 'region_blocked') result = await this.inRegion(ctx, await this.channelRegion(ctx, responses), `video=${id}`, detail) ?? result;
      if (!result) { fallback.set(id, responses); continue; }
      const reference = await this.archive.save({ schema_version: 'crawl.unit.v1', owner: ctx.owner, channel_id: ctx.channelId, step, unit_id: id,
        captured_at: new Date().toISOString(), responses, result }, ctx.signal);
      results.set(id, result); references.set(id, reference);
    }
    const failedIds = [...fallback.keys()];
    for (let start = 0; start < failedIds.length; start += 50) {
      const batch = failedIds.slice(start, start + 50), apiResponses: RawResponse[] = [];
      let apiVideos:Map<string,import('./map.ts').ApiVideo>;
      try{apiVideos=new Map((await this.dataApi.videos(batch,this.recorded(ctx,apiResponses))).map(v=>[v.id,v]));}
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
        // An artist's uploads can list releases owned by another channel; they stay with this channel, owner recorded.
        const result = api ? collectedFor(toVideoFacts(api, null, comments, commentLimit, new Date().toISOString()), ctx.channelId) : unavailableVideo(ctx.channelId, id, new Date().toISOString());
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
