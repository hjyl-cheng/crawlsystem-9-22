import {randomUUID} from 'node:crypto';
import {ChannelFactsSchema,VideoItemSchema,isVideoUnavailable,AgentResultSchema,type ChannelFacts,type VideoFacts,type VideoItem,type AgentResult} from '@crawlsystem/contracts';
import {observationFactsHash as hash,publicationResultHash,normalizePublicationEnvelope,validateBusinessPublicationEnvelope,buildPublicationShard,type LegacyValue} from '../../legacy-publication/src/index.js';

export type PublicationDomain='channel'|'video'|'agent';
export interface PublicationState {revision:number;payloads:Partial<Record<PublicationDomain,LegacyValue>>;vector:Record<string,LegacyValue>;removed?:boolean;}
export interface PublicationSnapshot {channel_id:string;about:ChannelFacts;agent:AgentResult;videos:VideoItem[];observed_at:string;source:LegacyValue;removed?:boolean;}
const resolved=(m:VideoFacts['view_count'])=>['exact','estimated','disabled'].includes(m.status)?m.value:null;
function channelPayload(a:ChannelFacts):LegacyValue {
 return {channel_id:a.channel_id,title:a.title,canonical_url:a.channel_url,vanity_channel_url:a.handle?`https://www.youtube.com/${a.handle.startsWith('@')?a.handle:'@'+a.handle}`:null,handle:a.handle,
  avatar:a.avatar_url?[{url:a.avatar_url,position:0}]:[],rss_url:`https://www.youtube.com/feeds/videos.xml?channel_id=${a.channel_id}`,keywords:a.keywords,is_family_safe:a.is_family_safe,is_verified:a.is_verified,is_verified_status:a.is_verified===null?'unknown':a.is_verified?'verified':'not_verified',
  has_videos:a.available_tabs.length?a.available_tabs.some(t=>/video/i.test(t)):null,has_shorts:a.available_tabs.length?a.available_tabs.some(t=>/short/i.test(t)):null,has_live_streams:a.available_tabs.length?a.available_tabs.some(t=>/live|stream/i.test(t)):null,description:a.about_description??a.summary,
  subscriber_count:resolved(a.subscriber_count),subscriber_count_status:a.subscriber_count.status,total_video_count:resolved(a.total_video_count),total_video_count_status:a.total_video_count.status,total_view_count:resolved(a.total_view_count),total_view_count_status:a.total_view_count.status,
  joined_date:a.joined_at,joined_date_status:a.joined_at?'exact':'unavailable',joined_date_raw:a.joined_date_text,country_code:a.country_code,country_name:a.country,
  links:a.external_links.map((l,i)=>({link_type:'external',target_url:l.url,title:l.title,position:i})),lifecycle_status:'active',youtube_business_email_available:a.youtube_business_email_available,youtube_business_email_observed_at:a.youtube_business_email_available===null?null:a.observed_at};
}
function videoItem(v:VideoFacts,position:number):LegacyValue {
 const exact=v.published_at_status==='exact'&&v.published_at_precision==='second';
 const item:LegacyValue={position,content_id:v.source_content_id,content_key:`youtube:${v.source_content_id}`,kind:v.content_type,title:v.title,url:v.url,thumbnail_url:v.thumbnail_url,
  published_at:exact||v.published_at_status!=='exact'?v.published_at:null,published_date:v.published_at?.slice(0,10)??null,published_at_precision:v.published_at_precision,published_at_status:exact?'exact':v.published_at_status==='exact'?'date_exact':'estimated',published_at_source:v.published_at_source,
  duration_seconds:resolved(v.duration_seconds),duration_status:v.duration_seconds.status,duration_source:v.duration_seconds.source,
  view_count:resolved(v.view_count),view_count_status:v.view_count.status,view_count_source:v.view_count.source,view_count_observed_at:v.view_count.observed_at,
  like_count:resolved(v.like_count),like_count_status:v.like_count.status,like_count_source:v.like_count.source,like_count_observed_at:v.like_count.observed_at,
  comment_count:resolved(v.comment_count),comment_count_status:v.comment_count.status,comment_count_source:v.comment_count.source,comment_count_observed_at:v.comment_count.observed_at,
  comments_disabled:v.comments_disabled,description:v.description,description_status:v.description===null?'unavailable':'exact',description_source:v.extractor_version,hashtags:v.hashtags,keywords:v.keywords,
  access_status:v.access_status,access_status_source:v.access_status_source,is_members_only:v.is_members_only,live_scheduled_at:v.live_scheduled_at,live_started_at:v.live_started_at,live_ended_at:v.live_ended_at,extractor_version:v.extractor_version};
 item.item_hash=hash(Object.fromEntries(Object.entries(item).filter(([k])=>k!=='position'&&!k.endsWith('_observed_at')&&!k.endsWith('_source')&&k!=='extractor_version')));
 return item;
}
function agentPayload(a:AgentResult,about:ChannelFacts):LegacyValue {
 // The current Agent contract retains its input hash, but not the frozen input ID list.
 // Preserve that hash as provenance; do not infer historical input IDs from today's window.
 return {channel_id:a.channel_id,agent_mode:'local_model',input_url:about.channel_url,facts:a.facts,agent_model:a.model_version,agent_config_id:null,prompt_template_id:null,prompt_hash:null,prompt_variant:null,agent_version_hash:null,output_hash:hash(a.facts),input_content_ids:[],input_content_hash:hash([]),taxonomy_version:a.taxonomy_version};
}
export function mapPublication(snapshot:PublicationSnapshot,previous:PublicationState|undefined,streamId:string,deliveryId:string) {
 const a=ChannelFactsSchema.parse(snapshot.about),agent=AgentResultSchema.parse(snapshot.agent),asOf=snapshot.observed_at,cutoff=new Date(new Date(asOf).getTime()-90*86400000).toISOString();
 if(a.channel_id!==snapshot.channel_id||agent.channel_id!==a.channel_id)throw new Error('PUBLICATION_IDENTITY_MISMATCH');
 const observations=snapshot.videos.map(v=>VideoItemSchema.parse(v)),unavailable=new Map(observations.filter(isVideoUnavailable).map(v=>[v.source_content_id,v]));
 const candidates=observations.filter((v):v is VideoFacts=>!isVideoUnavailable(v));
 const eligible=candidates.filter(v=>v.channel_id===a.channel_id&&v.published_at&&['exact','relative','estimated'].includes(v.published_at_status)&&v.published_at>=cutoff&&v.published_at<=asOf&&['public','unlisted','members_only'].includes(v.access_status)).sort((x,y)=>y.published_at!.localeCompare(x.published_at!)||x.source_content_id.localeCompare(y.source_content_id));
 const items=snapshot.removed?[]:eligible.slice(0,30).map((v,i)=>videoItem(v,i+1));
 const video:LegacyValue={channel_id:a.channel_id,window_policy:{policy_version:'video-window-v1',as_of:asOf,cutoff_at:cutoff,cutoff_date:cutoff.slice(0,10),max_age_days:90,max_items:30},window_proof:{complete:true,terminal_condition:'durable_finalized_window',catalog_candidate_count:candidates.length,qualified_count:eligible.length,selected_count:items.length,excluded_count:candidates.length-items.length,latest_scan_items:null,latest_scan_pages:null,latest_scan_stop_reason:null,latest_scan_detail_failure_count:0},items};
 video.result_hash=publicationResultHash('video',video);
 const payloads:Record<PublicationDomain,LegacyValue>={channel:snapshot.removed?{channel_id:a.channel_id,retraction:{reason:'policy_removed',removed_at:asOf}}:channelPayload(a),video,agent:snapshot.removed?{channel_id:a.channel_id,retraction:{reason:'policy_removed',removed_at:asOf}}:agentPayload(agent,a)};
 const priorChannel=previous?.payloads.channel;
 if(!snapshot.removed&&priorChannel&&priorChannel.youtube_business_email_available===payloads.channel.youtube_business_email_available)
  payloads.channel.youtube_business_email_observed_at=priorChannel.youtube_business_email_observed_at;
 const next:PublicationState={revision:(previous?.revision??0)+1,payloads,vector:{...previous?.vector},removed:!!snapshot.removed};
 const envelopes:LegacyValue[]=[];
 for(const domain of ['channel','video','agent'] as const) {
  const old=previous?.payloads[domain],result=publicationResultHash(domain,payloads[domain]);
  if(old&&publicationResultHash(domain,old)===result)continue;
  if(snapshot.removed&&!old)continue;
  const prior=previous?.vector[domain],sequence=Number(prior?.sequence??0)+1,revisionId=randomUUID();
  let payload=payloads[domain];
  if(domain==='video'&&old) {
   const newIds=new Set(items.map(i=>i.content_id)),byId=new Map((old.items??[]).map((i:LegacyValue)=>[i.content_id,i]));
   const exits:LegacyValue[]=[],retractions:LegacyValue[]=[];
   for(const i of old.items??[])if(!newIds.has(i.content_id)) {
    if(snapshot.removed)retractions.push({content_id:i.content_id,reason:'policy_removed'});
    else if(unavailable.has(i.content_id)){const v=unavailable.get(i.content_id)!;retractions.push({content_id:i.content_id,reason:v.access_status==='private'?'source_private':v.access_status==='removed'?'source_deleted':'source_unavailable'});}
    else exits.push({content_id:i.content_id,reason:i.published_date<cutoff.slice(0,10)?'aged_out':'outside_limit'});
   }
   payload={channel_id:a.channel_id,window_policy:video.window_policy,window_proof:video.window_proof,upserts:items.filter(i=>{const oldItem=byId.get(i.content_id) as LegacyValue|undefined;return !oldItem||oldItem.item_hash!==i.item_hash||oldItem.position!==i.position;}),window_exits:exits,retractions,result_hash:result};
  }
  const retraction=snapshot.removed&&domain!=='video';
  const envelope=normalizePublicationEnvelope({revision_id:revisionId,publication_stream_id:streamId,revision_type:old?(retraction?'retraction':'incremental'):'bootstrap',channel_id:a.channel_id,domain,data_sequence:sequence,previous_data_sequence:prior?.sequence??null,operation:retraction?(domain==='channel'?'retract_channel':'retract_agent'):domain==='video'?(old?'apply_window_delta':'replace_window'):'replace',contract_version:domain==='channel'?2:1,policy_version:domain==='video'?'video-window-v1':'publication-policy-v1',occurred_at:asOf,source:{...snapshot.source,complete_observation:{observed_at:domain==='channel'?a.observed_at:domain==='agent'?agent.observed_at:asOf},...(snapshot.removed?{terminal_channel:{removed_at:asOf}}:{}),...(domain==='agent'?{agent_input_hash:agent.input_hash}:{})},previous_result_hash:prior?.result_hash??null,result_hash:result,payload_hash:hash(payload),payload});
  validateBusinessPublicationEnvelope(envelope);envelopes.push(envelope);
  next.vector[domain]={publication_stream_id:streamId,sequence,revision_id:revisionId,result_hash:result};
 }
 return {state:next,envelopes,shard:envelopes.length?buildPublicationShard(envelopes,{shardId:deliveryId,createdAt:asOf}):null};
}
