import type { RawResponse } from '../raw-archive.ts';
/** Only an explicit channel-unavailable page counts; generic HTTP errors never do. */
export function channelUnavailablePage(responses:RawResponse[],channelId:string):boolean {
 let unavailable=false;
 for(const r of responses.filter(r=>r.endpoint==='https://www.youtube.com/youtubei/v1/browse'&&r.status===200)) {
  let page:any;try{page=JSON.parse(r.body);}catch{continue;}
  const metadata=page.metadata?.channelMetadataRenderer;
  if(metadata?.externalId===channelId || metadata?.title) return false;
  const alerts=Array.isArray(page.alerts)?page.alerts:[];
  for(const alert of alerts) {
   const text=alert.alertRenderer?.text,reason=String(text?.simpleText??text?.runs?.map((r:any)=>r.text).join('')??'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
   if(/this channel (?:is not available|does not exist|has been (?:removed|deleted))|this account has been terminated|(?:este|esse) canal (?:nao esta disponivel|nao existe|foi removido|foi excluido)|(?:esta|essa) conta foi (?:encerrada|suspensa)|此频道(?:已被删除|不存在|不可用)/.test(reason))unavailable=true;
  }
 }
 return unavailable;
}
export function confirmedChannelRemoval(responses:RawResponse[],channelId:string):boolean {
 return channelUnavailablePage(responses,channelId)&&responses.some(r=>{
  if(r.endpoint!=='https://www.googleapis.com/youtube/v3/channels'||r.status!==200)return false;
  try{const body=JSON.parse(r.body);return Array.isArray(body.items)&&body.items.length===0;}catch{return false;}
 });
}
