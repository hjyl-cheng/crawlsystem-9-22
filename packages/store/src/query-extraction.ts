import {BUSINESS_CATEGORIES,normalizeQueryText,type BusinessCategory} from '@crawlsystem/contracts';

const regions='AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const languages='aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(' ');
function names(codes:string[],type:'region'|'language'){
  const m=new Map<string,string>(),names=new Intl.DisplayNames(['en'],{type});
  for(const c of codes){m.set(normalizeQueryText(c),c);m.set(normalizeQueryText(names.of(c)??c),c);}return m;
}
const countries=names(regions,'region'),langs=names(languages,'language');
for(const [name,code] of [['brasil','BR'],['méxico','MX'],['estados unidos','US'],['south korea','KR'],['united states of america','US']])countries.set(name!,code!);
for(const [name,code] of [['brazilian portuguese','pt'],['português','pt'],['español','es'],['mandarin','zh'],['filipino','tl']])langs.set(name!,code!);
const generic=new Set('short-form video|long-form video|digital culture|channel series|video commentary|educational content|video|videos|youtube|shorts|live|ao vivo|subscribe|inscreva-se|like|follow|news|notícias|noticias|vlog|vlogs|entertainment|trending|viral|official|oficial|channel|canal'.split('|'));
const stops=new Set('a o os as de do da dos das e em no na nos nas para por com um uma the and of in on to for with from is are el la los las del y en un una por con que é se this that my your le les des et une der die das und mit'.split(' '));
const noise=/https?:|www\.|@|\p{N}|ao vivo|assista|inscreva|subscribe|follow me|click here|link na|edição|edicion|breaking news/iu;
export interface ExtractedQuery {text:string;country:string;language:string;category:BusinessCategory;source_type:'CHANNEL_ABOUT'|'AUTO_TAG'|'VIDEO_TITLE';video_id:string|null;}
type Json=Record<string,any>;
/** Conservative suggestions: never guess a missing country/category or split prose into an unbounded vocabulary. */
export function extractQueries(about:Json|null,agent:Json|null,videos:Json[]):ExtractedQuery[]|null {
  const facts=agent?.facts;
  const credible=(v:Json|undefined)=>v&&['medium','high'].includes(v.confidence);
  if(!credible(facts?.creator_language)||!credible(facts?.channel_categories))return null;
  const country=countries.get(normalizeQueryText(about?.country_code??''))??(credible(facts?.country)?countries.get(normalizeQueryText(facts.country.value??'')):undefined);
  const language=langs.get(normalizeQueryText(facts.creator_language.value??''));
  const category=facts.channel_categories.value?.level_1 as BusinessCategory;
  if(!country||!language||!BUSINESS_CATEGORIES.includes(category))return null;
  const result=new Map<string,ExtractedQuery>();
  const add=(raw:unknown,source_type:ExtractedQuery['source_type'],video_id:string|null=null)=>{
    if(typeof raw!=='string')return;
    const text=normalizeQueryText(raw.replace(/^#+/u,'')).replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu,'');
    const tokens=text.split(' ');
    if(text.length<2||text.length>80||tokens.length>6||noise.test(text)||generic.has(text)||!/^\p{L}[\p{L}\p{M}\s'’-]*$/u.test(text)||tokens.every(t=>stops.has(t)))return;
    if(!result.has(text))result.set(text,{text,country,language,category,source_type,video_id});
  };
  for(const word of (about?.keywords??[]).slice(0,100))add(word,'CHANNEL_ABOUT');
  // Profile labels may be broad or in English even for a Portuguese channel. Require a public
  // textual anchor so repeated model labels cannot manufacture support for unrelated topics.
  const publicText=[about?.title,about?.description,...(about?.keywords??[]),...videos.slice(0,30).flatMap(v=>{
    const d=v.data??v;return [d.title,...(d.keywords??[]),...(d.hashtags??[])];
  })].filter(v=>typeof v==='string').map(v=>' '+normalizeQueryText(v).replace(/[^\p{L}\p{M}\p{N}]+/gu,' ')+' ');
  if(credible(facts.channel_tags))for(const tag of (facts.channel_tags.value?.tags??[]).slice(0,10)){
    const anchor=' '+normalizeQueryText(tag).replace(/[^\p{L}\p{M}\p{N}]+/gu,' ')+' ';
    if(publicText.some(v=>v.includes(anchor)))add(tag,'AUTO_TAG');
  }
  // Titles contribute short phrases, not complete sentences. Single-channel repetition still counts once.
  for(const video of videos.slice(0,30)){
    const d=video.data??video,id=video.video_id??d.source_content_id;
    if(!/^[A-Za-z0-9_-]{11}$/.test(id??''))continue;
    for(const word of [...(d.keywords??[]),...(d.hashtags??[])].slice(0,100))add(word,'AUTO_TAG',id);
    const title=normalizeQueryText(d.title??'');
    if(noise.test(title))continue;
    for(const part of title.split(/[|:!?–—]/u)){
      const words=part.trim().split(/\s+/u);
      if(words.length<=4)add(part,'VIDEO_TITLE',id);
      else for(let i=0;i<words.length-1;i++)if(!stops.has(words[i]!)&&!stops.has(words[i+1]!))add(words.slice(i,i+2).join(' '),'VIDEO_TITLE',id);
    }
  }
  return [...result.values()].slice(0,20);
}
