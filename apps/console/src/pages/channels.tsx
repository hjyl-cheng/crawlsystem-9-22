import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CircleCheck, CirclePause, Download, Plus, Search, TriangleAlert, Tv } from 'lucide-react';
import type { ChannelListItem } from '@crawlsystem/contracts';
import {BUSINESS_CATEGORIES,ChannelListFiltersSchema,type ChannelAgentState} from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty, ErrorBox, Pagination, PlanBadge, ResourceView, SafeLink, usePagination } from '../ui.js';
import { categoryLabels, channelPath, dueIn, number, planPath, time } from '../presentation.js';
import ClockPolicy from '../components/clock-policy.js';
import ChannelImport from '../components/channel-import.js';
import { ApiFailure } from '../api.js';
import './overview.css';
import './discover.css';
import './channels.css';

const fmt = (n: number) => n.toLocaleString('zh-CN');
const short = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const subscribers = (n: number | null) => n === null ? '—' : n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万` : fmt(n);
const agentStates:Record<ChannelAgentState,string>={not_scheduled:'尚未安排',waiting:'等待生成',running:'正在生成',completed:'画像已入库',failed:'最近画像失败'};
const publicationStates={NOT_ENABLED:'未启用',PENDING:'待业务确认',DELIVERED:'已交付',FAILED:'交付失败',NOT_READY:'未达发布条件',UNCHANGED:'资料无变化'};
const countryNames=new Intl.DisplayNames(['zh-CN'],{type:'region'});
const countryLabel=(value:string,label:string)=>value==='__missing'?'尚未提供':/^[A-Z]{2}$/.test(value)?countryNames.of(value)??label:label;

function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="kv-row"><dt>{label}</dt><dd>{children}</dd></div>;
const Avatar = ({ title, color = '#3f7fe0', big = false }: { title: string; color?: string; big?: boolean }) => <span className={`avatar-dot ${big ? 'big' : ''}`} style={{ background: color }}>{title.slice(0, 1)}</span>;

/** Real detail: current About facts and latest plan of the selected channel. */
function RealDetail({ id }: { id: string }) {
  const { api, session } = useAuth();
  const [tab, setTab] = useState<'info' | 'policy'>('info');
  const resource = useResource(`channel-side:${id}`, signal => api.channel(id, signal), false);
  const c = resource.data, about = c?.about;
  const [updating, setUpdating] = useState(false), [updateError, setUpdateError] = useState<ApiFailure>(), [updated, setUpdated] = useState<string>();
  async function updateNow() {
    if (!c) return;
    setUpdating(true); setUpdateError(undefined); setUpdated(undefined);
    try { setUpdated((await api.updateChannel(c.channel_id, { request_id: crypto.randomUUID(), expected_version: c.management.version, domains: ['ABOUT', 'VIDEO'] })).plan_id); resource.refresh(); }
    catch (cause) { setUpdateError(cause instanceof ApiFailure ? cause : new ApiFailure('安排更新失败，请重试')); }
    finally { setUpdating(false); }
  }
  return <section className="panel channel-detail">
    <header className="detail-head"><Avatar title={c?.title ?? id} big/><div><b>{c?.title ?? '基础资料待入库'}</b><small>{about?.handle ?? id}</small></div>{about && <SafeLink href={about.channel_url}>YouTube</SafeLink>}</header>
    <div className="detail-tabs" role="tablist"><button role="tab" aria-selected={tab === 'info'} className={tab === 'info' ? 'on' : ''} onClick={() => setTab('info')}>基本信息</button><button role="tab" aria-selected={tab === 'policy'} className={tab === 'policy' ? 'on' : ''} onClick={() => setTab('policy')}>更新策略</button></div>
    <div className="detail-body">
      {resource.error ? <p className="detail-note">{resource.error.message}</p> : !c ? <p className="detail-note">正在查询…</p> : tab === 'info' ? <>
        <dl><Row label="频道 ID"><span className="mono">{c.channel_id}</span></Row><Row label="国家 / 地区">{about?.country ?? '尚未提供'}</Row><Row label="注册日期">{about?.joined_at ?? about?.joined_date_text ?? '尚未提供'}</Row>
          <Row label="订阅数">{about ? number(about.subscriber_count.value) : '—'}</Row><Row label="总播放量">{about ? number(about.total_view_count.value) : '—'}</Row><Row label="视频总数">{about ? number(about.total_video_count.value) : '—'}</Row>
          <Row label="已入库视频">{c.videos.length} 个</Row><Row label="资料采集">{about ? time(about.observed_at) : '—'}</Row></dl>
        <h3>最近一轮采集</h3>
        <dl><Row label="计划"><Link to={planPath(c.latest_plan.plan_id)} className="mono">{c.latest_plan.plan_id.slice(0, 8)}…</Link></Row><Row label="状态"><PlanBadge status={c.latest_plan.status}/></Row><Row label="Agent 画像">{c.agent ? '已入库' : '尚未执行'}</Row><Row label="发布交付"><Link to={'/delivery?search='+encodeURIComponent(c.channel_id)}>{publicationStates[c.latest_plan.publication_status]}</Link></Row></dl>
      </> : <ClockPolicy channel={c} operator={session.role === 'operator'} onChanged={resource.refresh}/>}
    </div>
    <footer className="detail-actions"><Link className="button small" to={channelPath(id)}>查看完整数据</Link>
      {session.role === 'operator' && <button className="button small" disabled={!c || c.management.state !== 'managed' || updating}
        title={c && c.management.state !== 'managed' ? '只有持续更新中的频道可以立即更新' : '立即更新频道资料、视频与评论'} onClick={() => void updateNow()}>{updating ? '正在安排…' : '立即更新'}</button>}</footer>
    {updateError && <ErrorBox error={updateError}/>}{updated && <p className="detail-note">已安排更新，<Link to={planPath(updated)}>查看计划</Link></p>}
  </section>;
}
const clockShort: Record<ChannelListItem['clocks'][number]['clock'], string> = { ABOUT: '资料', VIDEO: '视频', AGENT: 'Agent 画像' };
const localDay = (value: string) => new Date(value).toDateString();
/** "Next update" cell: the next date and what is updated then (every kind due that same day). */
function NextUpdates({ ch }: { ch: ChannelListItem }) {
  if (ch.management_state === 'paused') return <span className="text-muted">已关闭自动更新</span>;
  if (ch.management_state !== 'managed' || !ch.clocks.length) return <span className="text-muted">未开启</span>;
  const next = ch.clocks.reduce((a, b) => Date.parse(b.next_due_at) < Date.parse(a.next_due_at) ? b : a);
  const parts = ch.clocks.filter(k => localDay(k.next_due_at) === localDay(next.next_due_at)).map(k => clockShort[k.clock]).join('、');
  const overdueDays = Math.floor((Date.now() - Date.parse(next.next_due_at)) / 86_400_000);
  return <div className="next-update">{Date.parse(next.next_due_at) <= Date.now()
      ? <b className="text-red">已过期{overdueDays > 0 ? ` ${overdueDays} 天` : ''}</b>
      : <><b>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(next.next_due_at))}</b><small>（{dueIn(next.next_due_at)}）</small></>}
    <small className="cell-note">{parts}</small></div>;
}
export default function Channels() {
  const { api, session } = useAuth(); const paging = usePagination();
  const rawFilters=Object.fromEntries(Object.keys(ChannelListFiltersSchema.shape).flatMap(key=>{const value=paging.params.get(key);return value?[[key,value]]:[];}));
  const parsed=ChannelListFiltersSchema.safeParse(rawFilters),filter=parsed.success?parsed.data:{};
  const search=filter.search??'',state=filter.state??'all';
  const [searchText,setSearchText]=useState(search);
  // Router navigation may render after the next input event. Compose changes
  // from the most recent selection so fast changes cannot restore an old filter.
  const latestParams=useRef(paging.params);
  useLayoutEffect(()=>{latestParams.current=paging.params;},[paging.params]);
  function changeFilter(key:string,value:string){const next=new URLSearchParams(latestParams.current);if(value)next.set(key,value);else next.delete(key);next.delete('cursor');latestParams.current=next;paging.setParams(next);setSelected(undefined);}
  useEffect(()=>setSearchText(search),[search]);
  useEffect(()=>{if(searchText.trim()===search)return;const timer=setTimeout(()=>changeFilter('search',searchText.trim()),300);return()=>clearTimeout(timer);},[searchText,search,paging.params]);
  const resource = useResource(`channels:${paging.cursor}:${JSON.stringify(rawFilters)}`, signal => {if(!parsed.success)throw new ApiFailure('筛选条件不正确，请清除后重新选择',400,'INVALID_REQUEST');return api.channels(paging.cursor,20,signal,filter);});
  const {state:ignoredState,...countFilter}=filter;
  const options=useResource(`channel-filters:${JSON.stringify(countFilter)}`,signal=>api.channelFilterOptions(countFilter,signal),true,15_000);
  const completeness = useResource('channels-completeness', signal => api.completeness(signal), true, 15_000);
  const [selected, setSelected] = useState<string>(), [importing, setImporting] = useState(false);
  const imports = useResource('channel-imports', signal => api.channelImports(signal), true, 15_000);
  const operator = session.role === 'operator', q = imports.data?.counts;
  const realFirst = resource.data?.items[0]?.channel_id;
  const current = resource.data?.items.some(ch=>ch.channel_id===selected)?selected:realFirst;
  function clearFilters(){const next=new URLSearchParams(latestParams.current);for(const key of Object.keys(ChannelListFiltersSchema.shape))next.delete(key);next.delete('cursor');latestParams.current=next;paging.setParams(next);setSearchText('');setSelected(undefined);}
  const c = completeness.data;
  return <div className="dashboard discover channels-page">
    <header className="dashboard-heading">
      <div><h1>频道管理</h1><p>YouTube 频道资料、纳管状态、数据完整性与更新计划</p>
        {completeness.updatedAt ? <span className="data-freshness"><i/>数据已同步 · {short(new Date(completeness.updatedAt).toISOString())}</span> : null}</div>
      {operator && <div className="dashboard-period"><button className="button small" onClick={() => setImporting(true)}><Download size={13}/>导入频道</button><button className="button small primary" onClick={() => setImporting(true)}><Plus size={13}/>新增频道</button></div>}
    </header>

    <div className="discover-kpis">
      <Kpi label="频道记录" tone="blue" icon={<Tv size={22}/>} value={c && fmt(c.total_channels)} foot={c?.latest_channel_update_at ? `最近入库 ${short(c.latest_channel_update_at)}` : '—'}/>
      <Kpi label="数据完整" tone="green" icon={<CircleCheck size={22}/>} value={c && fmt(c.complete)} foot={c ? `部分可用 ${c.partial} · 待补全 ${c.missing} · 未准入 ${c.not_admitted}` : '—'}/>
      <Kpi label="到期待更新" tone="amber" icon={<TriangleAlert size={22}/>} value={c && fmt(c.management.overdue)} foot={c ? `持续更新中 ${fmt(c.management.managed)} 个 · 到期当天 00:30 起依次更新` : '—'}/>
      <Kpi label="已暂停" tone="amber" icon={<CirclePause size={22}/>} value={c && fmt(c.management.paused)} foot="暂停期间到期不会自动更新"/>
    </div>
    {q && q.queued + q.planned + q.failed + q.done + (q.rejected??0) > 0 && <div className="notice import-queue" role="status">导入队列：排队 <b>{q.queued}</b> · 首次采集中 <b>{q.planned}</b> · 已完成 <b>{q.done}</b> · 失败 <b>{q.failed}</b> · 门槛未通过 <b>{q.rejected??0}</b>
      {q.failed > 0 && <small>（等待自动重试 {imports.data?.retry_counts?.waiting??0} · 需人工处理 {imports.data?.retry_counts?.manual??q.failed}；临时故障最多重试 3 次）</small>}</div>}
    <ChannelImport open={importing} onOpenChange={setImporting} onImported={() => { imports.refresh(); resource.refresh(); }}/>

    <div className="discover-row row-channels">
      <section className="panel channels-list">
        <div className="status-tabs" role="tablist" aria-label="频道状态">{([['all', '全部'], ['ok', '正常'], ['overdue', '到期'], ['paused', '已暂停']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={key === state} className={key === state ? 'on' : ''} onClick={()=>changeFilter('state',key==='all'?'':key)}>{label}<span>{options.data?.counts[key]??'—'}</span></button>)}</div>
        <div className="list-tools channel-filters"><label className="list-search" htmlFor="channel-search"><Search size={13}/><input id="channel-search" aria-label="搜索频道" maxLength={160} placeholder="搜索名称 / @handle / 频道 ID" value={searchText} onChange={e=>setSearchText(e.target.value)}/></label>
          <select aria-label="国家 / 地区" value={filter.country??''} onChange={e=>changeFilter('country',e.target.value)}><option value="">全部国家 / 地区</option>{filter.country&&!options.data?.countries.some(v=>v.value===filter.country)&&<option value={filter.country}>{countryLabel(filter.country,filter.country)}</option>}{options.data?.countries.map(v=><option key={v.value} value={v.value}>{countryLabel(v.value,v.label)}（{fmt(v.count)}）</option>)}</select>
          <select aria-label="业务分类" value={filter.category??''} onChange={e=>changeFilter('category',e.target.value)}><option value="">全部业务分类</option>{BUSINESS_CATEGORIES.map(v=><option key={v} value={v}>{categoryLabels[v]}</option>)}<option value="__missing">尚未分类</option></select>
          <select aria-label="更新状态" value={filter.management_state??''} onChange={e=>changeFilter('management_state',e.target.value)}><option value="">全部更新状态</option><option value="managed">持续更新</option><option value="paused">已暂停</option><option value="removed">已移出纳管</option><option value="unmanaged">尚未纳管</option></select>
          <select aria-label="Agent 状态" value={filter.agent_state??''} onChange={e=>changeFilter('agent_state',e.target.value)}><option value="">全部 Agent 状态</option>{Object.entries(agentStates).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select>
          {Object.keys(rawFilters).length>0&&<button className="button small" onClick={clearFilters}>清除筛选</button>}</div>
        {options.error&&<div className="filter-error"><ErrorBox error={options.error}/><button className="button small" onClick={options.refresh}>重试筛选信息</button></div>}
        <ResourceView resource={resource}>{page => <>{page.items.length ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>国家 / 地区</th><th>业务分类</th><th>Agent 状态</th><th className="num">订阅数</th><th className="num">已入库视频</th><th>最近入库</th><th>下次更新</th><th>最近计划</th><th>操作</th></tr></thead>
            <tbody>{page.items.map((ch: ChannelListItem) => <tr key={ch.channel_id} className={ch.channel_id === current ? 'selected' : ''} onClick={() => setSelected(ch.channel_id)} aria-selected={ch.channel_id === current}>
              <td><div className="channel-cell"><Avatar title={ch.title ?? ch.channel_id}/><div><b>{ch.title ?? '基础资料待入库'}</b><small className="mono">{ch.channel_id}</small></div></div></td>
              <td>{ch.country ?? <span className="text-muted">尚未提供</span>}</td><td>{ch.category?(categoryLabels as Record<string,string>)[ch.category]??ch.category:<span className="text-muted">尚未分类</span>}</td><td>{ch.agent_state?agentStates[ch.agent_state]:'—'}</td><td className="num">{subscribers(ch.subscriber_count)}</td><td className="num">{ch.stored_videos}</td><td>{short(ch.updated_at)}</td>
              <td><NextUpdates ch={ch}/></td><td><PlanBadge status={ch.latest_plan_status}/></td><td className="row-actions"><Link to={channelPath(ch.channel_id)} onClick={event => event.stopPropagation()}>详情</Link></td>
            </tr>)}</tbody></table></div> : <Empty title={Object.keys(rawFilters).length?'当前条件下没有频道':'尚无频道记录'}>{Object.keys(rawFilters).length?'调整或清除筛选条件后查看频道。':'创建采集计划后，可在这里查看频道。'}</Empty>}<Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/></>}</ResourceView>
      </section>
      {current ? <RealDetail key={current} id={current}/> : <section className="panel channel-detail"><Empty title="选择频道查看详情">{resource.loading ? '正在查询…' : '暂无频道'}</Empty></section>}
    </div>
    <footer className="dashboard-foot"><span>频道分类来自已入库画像；到期更新按执行名额与预算自动安排，暂停后保留原更新策略。</span><span>点击频道行查看详情</span></footer>
  </div>;
}
