import { Link, useParams } from 'react-router';
import { useState } from 'react';
import { isVideoUnavailable, type ChannelFacts, type ChannelDetail, type VideoFacts, type VideoUnavailable, type AgentResult } from '@crawlsystem/contracts';
import ClockPolicy from '../components/clock-policy.js';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Badge, Empty, Fields, PageHeading, Panel, PlanBadge, ResourceView, SafeLink, SampleBadge } from '../ui.js';
import { number, planPath, time,publicationLabels } from '../presentation.js';

const metricLabels: Record<ChannelFacts['subscriber_count']['status'], string> = { exact: '精确值', estimated: '估算值', empty: '合法空值', unavailable: '不可获得', unresolved: '尚未解析', disabled: '已关闭' };
function Metric({ label, metric }: { label: string; metric: ChannelFacts['subscriber_count'] }) {
  return <div className="metric"><span>{label}</span><strong>{number(metric.value)}</strong><Badge>{metricLabels[metric.status]}</Badge><small title={`${metric.source} · ${time(metric.observed_at)}`}>{metric.source} · {time(metric.observed_at)}</small></div>;
}
const nullableBoolean = (value: boolean | null) => value === null ? '未知' : value ? '是' : '否';
// A listed target whose details could not be collected: shown as such, never as video data.
function UnavailableVideo({ video }: { video: VideoUnavailable }) {
  return <article className="video-card"><div className="panel-heading"><div><h3>视频不可采集</h3><small className="muted mono">{video.source_content_id}</small></div><Badge>{video.access_status}</Badge></div><p>{video.reason}</p><Fields rows={[['判断来源', video.source], ['观察时间', time(video.observed_at)]]}/></article>;
}
function Video({ video }: { video: VideoFacts }) {
  const [requested,setRequested]=useState(false),comments=video.comments_first_page??video.comments_summary;
  return <article className="video-card"><div className="panel-heading"><div><h3>{video.title}</h3><small className="muted mono">{video.source_content_id}</small></div><Badge>{video.content_type}</Badge></div><p>{video.description ?? '描述尚未提供'}</p><Fields rows={[
    ['访问状态', video.access_status], ['视频链接', <SafeLink href={video.url}>{video.url}</SafeLink>], ['发布时间', video.published_at ? `${time(video.published_at)}（${video.published_at_status}）` : `尚未提供（${video.published_at_status}）`], ['采集时间', time(video.observed_at)], ['解析器版本', video.extractor_version],
  ]}/><div className="metrics-grid"><Metric label="播放量" metric={video.view_count}/><Metric label="点赞量" metric={video.like_count}/><Metric label="评论总量" metric={video.comment_count}/><Metric label="时长（秒）" metric={video.duration_seconds}/></div>
    <details className="comments" onToggle={e=>{if(e.currentTarget.open)setRequested(true);}}><summary>首屏评论 · {video.comments_disabled === true ? '评论已关闭' : comments ? `${comments.returned_count} 条已采集` : '尚无入库结果'}</summary>
      {video.comments_disabled === true ? <div className="notice">该视频已关闭评论。</div> : requested ? <Comments video={video}/> : null}
    </details>
  </article>;
}
function Comments({video}:{video:VideoFacts}) {
  const {api}=useAuth();
  const resource=useResource(`comments:${video.channel_id}:${video.source_content_id}:${video.comments_ref?.sha256??'legacy'}`,
    signal=>video.comments_first_page ? Promise.resolve({page:video.comments_first_page,state:'AVAILABLE' as const}) : api.comments(video.channel_id,video.source_content_id,signal),false);
  return <ResourceView resource={resource}>{({page:comments,state})=>comments ? <><p className="fine-print">采集于 {time(comments.collected_at)} · 排序：{comments.sort === 'TOP_COMMENTS' ? '热门评论' : '最新评论'} · 上游总量：{number(comments.total_count)}</p>
    {comments.comments.length ? comments.comments.map(comment=><article className="comment" key={comment.comment_id}><strong>{comment.author_name??'作者未知'}</strong><p>{comment.text}</p><small>点赞 {number(comment.like_count)} · 回复 {number(comment.reply_count)} · {comment.published_at_utc?time(comment.published_at_utc):comment.published_text_raw??'发布时间未知'}{comment.is_pinned===true?' · 已置顶':''}</small></article>) : <Empty title="已采集，首屏评论为空"/>}</>
    : <Empty title={state==='EXPIRED'?'评论正文已超过保留期':'评论尚无入库结果'}>{state==='EXPIRED'?'采集数量与时间仍可查看，后续采集会更新正文。':'尚不能判断首屏是否为空。'}</Empty>}</ResourceView>;
}
const confidenceLabels = { high: '高', medium: '中', low: '低' } as const;
/** Why a value is only an estimate: the model bundle's own status for that field. */
const estimateReasons: Record<string, string> = {
  pretrained_public_model: '公开预训练模型（语言识别）',
  trained_weak_supervision: '弱监督训练的模型，尚未经人工测试集验证',
  uncalibrated_public_estimate: '依据公开信号与先验的估计，未经后台受众数据校准',
  uncalibrated_public_proxy: '公开信号推算的代理指标，未经后台数据校准',
  fallback_only_candidate_model_below_gate: '模型未达上线门槛，使用规则与先验估计',
  fallback_only_candidate_models_below_gate: '模型未达上线门槛，使用规则与先验估计',
};
const agentLabels: Record<keyof AgentResult['facts'], string> = { country: '国家 / 地区', creator_gender: '创作者性别 / 团队类型', creator_age_range: '创作者年龄', creator_language: '创作者语言', audience_region: '受众地区分布', audience_language: '受众语言分布', audience_age_gender: '受众年龄 / 性别', active_subscriber_ratio: '活跃订阅者比例', channel_tags: '频道标签', channel_categories: '频道分类' };
function ChannelDelivery({id}:{id:string}){
 const {api}=useAuth(),r=useResource(`channel-delivery:${id}`,signal=>api.deliveries(signal,undefined,id),true,15000);
 return <Panel title="发布交付"><ResourceView resource={r}>{p=>{const latest=p.items.find(r=>r.channel_id===id);return latest?<Fields rows={[
  ['最近定稿状态',publicationLabels[latest.status]],['业务回执时间',time(latest.received_at)],['数据版本',`r${latest.revision}`],['记录',<Link to={`/delivery?delivery=${latest.delivery_id}&search=${encodeURIComponent(id)}`}>查看交付与回执</Link>]
 ]}/>:<Empty title="尚无交付记录">频道资料、视频与画像完整定稿后自动交付。</Empty>;}}</ResourceView></Panel>;
}
function Content({ channel, operator, onChanged }: { channel: ChannelDetail; operator: boolean; onChanged: () => void }) {
  const { about, agent } = channel;
  return <><div className="plan-summary"><div className="inline"><SampleBadge/><strong>{channel.title ?? channel.channel_id}</strong></div><Link className="button" to={planPath(channel.latest_plan_id)}>查看最近计划 →</Link></div>
    <div className="notice">这里展示当前已入库数据，可能来自之前的计划。最近一轮状态：<PlanBadge status={channel.latest_plan.status}/>。本轮领域结果请进入对应 Plan 核对。</div>
    <Panel title="更新策略" extra={<Link to={`/history/${encodeURIComponent(channel.channel_id)}`}>查看指标历史 →</Link>}><ClockPolicy channel={channel} operator={operator} onChanged={onChanged}/></Panel>
    <Panel title="频道基础资料">{about ? <><div className="channel-intro"><span className="channel-avatar">{about.title.slice(0, 1)}</span><div><h2>{about.title}</h2><p>{about.handle ?? 'Handle 尚未提供'} · <SafeLink href={about.channel_url}>访问频道</SafeLink></p></div></div><div className="metrics-grid three"><Metric label="订阅数" metric={about.subscriber_count}/><Metric label="总播放量" metric={about.total_view_count}/><Metric label="视频总量" metric={about.total_video_count}/></div><Fields rows={[
      ['频道身份', about.channel_id], ['简介', about.about_description ?? about.summary ?? '尚未提供'], ['国家 / 地区', about.country ?? '尚未提供'], ['国家来源', about.country_source ?? '尚未提供'], ['注册日期', about.joined_at ?? about.joined_date_text ?? '尚未提供'], ['关键词', about.keywords.join('、') || '已返回空列表'], ['已认证', nullableBoolean(about.is_verified)], ['商务邮箱入口', nullableBoolean(about.youtube_business_email_available)], ['数据来源', about.source], ['采集时间', time(about.observed_at)], ['外部链接', about.external_links.length ? about.external_links.map(link => <div key={link.url}><SafeLink href={link.url}>{link.title || link.url}</SafeLink></div>) : '已返回空列表'],
    ]}/></> : <Empty title="基础资料尚未入库">创建计划不代表数据已经可用。</Empty>}</Panel>
    <Panel title="视频与评论" extra={<span className="muted">已返回 {channel.videos.length} 条 · 最多 100 条</span>}>{channel.videos.length ? channel.videos.map(video => isVideoUnavailable(video) ? <UnavailableVideo key={video.source_content_id} video={video}/> : <Video key={video.source_content_id} video={video}/>) : <Empty title="当前没有已入库的视频">本轮是否已完成，请查看 Plan 领域结果。</Empty>}</Panel>
    <Panel title="Agent 分析结果">{agent ? <><div className="notice">以下为模型分析结果，请结合来源与证据理解，不作为平台后台实测统计。</div><Fields rows={[["输入版本", <code>{agent.input_hash}</code>], ['模型版本', agent.model_version], ['分类版本', agent.taxonomy_version], ['分析时间', time(agent.observed_at)]]}/><div className="agent-facts">{(Object.keys(agentLabels) as (keyof AgentResult['facts'])[]).map(key => { const fact = agent.facts[key]; return <details key={key}><summary>{agentLabels[key]} · 置信度{confidenceLabels[fact.confidence]}</summary><pre>{JSON.stringify(fact.value, null, 2)}</pre><p>来源：{fact.source}</p>{fact.evidence.map((e, i) => <p key={i}>{e}</p>)}{fact.reason && <p>说明：{estimateReasons[fact.reason] ?? fact.reason}</p>}{fact.source_urls.map(url => <p key={url}><SafeLink href={url}>{url}</SafeLink></p>)}</details>; })}</div></> : <Empty title="Agent 尚未执行">本频道还没有已入库的画像。真实频道计划在资料与视频入库后自动用本地模型分析。</Empty>}</Panel>
    {channel.source_mode==='fixture'?<Panel title="发布交付"><div className="notice">未启用。已有采集数据不代表已完成对外交付。</div></Panel>:<ChannelDelivery id={channel.channel_id}/>}
  </>;
}
export default function ChannelDetailPage() {
  const { id = '' } = useParams(); const { api, session } = useAuth();
  const resource = useResource(`channel:${id}`, signal => api.channel(id, signal));
  return <><PageHeading title="频道详情" description="查看当前资料、视频、评论及其来源与采集时间。"><Link className="button" to="/channels">返回频道列表</Link></PageHeading><ResourceView resource={resource}>{channel => <Content channel={channel} operator={session.role === 'operator'} onChanged={resource.refresh}/>}</ResourceView></>;
}
