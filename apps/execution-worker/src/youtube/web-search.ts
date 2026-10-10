import type { QueryRunParams } from '@crawlsystem/contracts';
import { ScrapeError, classify, type SearchPage } from './scrape.ts';

/** Read a JSON object embedded in HTML without executing any page JavaScript. */
export function embeddedObject(html: string, markers: string[]): Record<string, any> {
  for (const marker of markers) {
    const at=html.indexOf(marker); if(at<0) continue;
    const start=html.indexOf('{',at+marker.length); if(start<0) continue;
    let depth=0,quoted=false,escaped=false;
    for(let i=start;i<html.length;i++) {
      const c=html[i];
      if(quoted) { if(escaped) escaped=false; else if(c==='\\') escaped=true; else if(c==='"') quoted=false; }
      else if(c==='"') quoted=true;
      else if(c==='{') depth++;
      else if(c==='}' && --depth===0) { try {return JSON.parse(html.slice(start,i+1));} catch {break;} }
    }
  }
  throw new ScrapeError('parse','Search HTML is missing its initial data or configuration');
}
function walk(root: unknown, visit: (value: Record<string, any>)=>void) {
  if(!root || typeof root!=='object') return;
  if(!Array.isArray(root)) visit(root as Record<string, any>);
  for(const value of Object.values(root)) walk(value,visit);
}
export function searchNavigation(data: unknown): SearchPage & {continuation:string|null} {
  const items:SearchPage['items']=[]; let continuation:string|null=null,videoNodes=0;
  walk(data,node=>{
    if(node.continuationItemRenderer) {
      const c=node.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
      if(typeof c==='string') continuation=c;
    }
    const video=node.videoRenderer;
    if(video) {
      if(/^[\w-]{11}$/.test(video.videoId??'')) videoNodes++;
      const owner=[video.ownerText,video.longBylineText,video.shortBylineText].flatMap(t=>t?.runs??[]).map(r=>r.navigationEndpoint?.browseEndpoint?.browseId).find(id=>/^UC[\w-]{22}$/.test(id??''));
      if(/^[\w-]{11}$/.test(video.videoId??'') && owner) items.push({video_id:video.videoId,channel_id:owner});
    }
    const lockup=node.lockupViewModel;
    if(lockup && /^[\w-]{11}$/.test(lockup.contentId??'')) {
      videoNodes++;
      let owner:string|undefined;
      walk(lockup.metadata??{},n=>{const id=n.browseEndpoint?.browseId;if(!owner && /^UC[\w-]{22}$/.test(id??'')) owner=id;});
      if(owner) items.push({video_id:lockup.contentId,channel_id:owner});
    }
  });
  // A valid empty result has a contents/envelope. Challenges and changed HTML never count as empty.
  if(!data || typeof data!=='object' || !['contents','onResponseReceivedCommands','onResponseReceivedActions'].some(k=>k in data))
    throw new ScrapeError('parse','Unexpected search result envelope');
  if(videoNodes && !items.length) throw new ScrapeError('parse','Search videos have no readable channel identities');
  return {items,more:continuation!==null,continuation};
}
export async function* webSearchPages(fetcher: typeof fetch, params: QueryRunParams): AsyncGenerator<SearchPage> {
  try {
    const date={THIS_YEAR:5,THIS_WEEK:3,THIS_MONTH:4}[params.window];
    const url=new URL('https://www.youtube.com/results');
    url.searchParams.set('search_query',params.text);
    url.searchParams.set('sp',Buffer.from([8,3,18,4,8,date,16,1]).toString('base64'));
    url.searchParams.set('hl',params.language);url.searchParams.set('gl',params.country);
    const response=await fetcher(url),html=await response.text();
    if([403,429].includes(response.status) || /captcha-form|Our systems have detected unusual traffic|before you continue to YouTube/i.test(html)) throw new ScrapeError('blocked','Search was challenged');
    if(!response.ok) throw new ScrapeError(response.status>=500?'upstream':'network','Search HTTP request failed');
    let data=embeddedObject(html,['var ytInitialData =','window["ytInitialData"] =','ytInitialData =']);
    const config=embeddedObject(html,['ytcfg.set(']);
    for(;;) {
      const page=searchNavigation(data);yield {items:page.items,more:page.more};
      if(!page.continuation) return;
      if(!config.INNERTUBE_CONTEXT) throw new ScrapeError('parse','Search continuation context missing');
      const next=await fetcher('https://www.youtube.com/youtubei/v1/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({context:config.INNERTUBE_CONTEXT,continuation:page.continuation})});
      if([403,429].includes(next.status)) throw new ScrapeError('blocked','Search continuation was rate limited');
      if(!next.ok) throw new ScrapeError(next.status>=500?'upstream':'network','Search continuation HTTP request failed');
      data=await next.json() as Record<string,any>;
    }
  } catch(error) {throw classify(error);}
}
