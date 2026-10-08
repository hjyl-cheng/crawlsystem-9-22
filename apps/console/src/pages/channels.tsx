import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CircleCheck, CirclePause, Download, Plus, Search, TriangleAlert, Tv } from 'lucide-react';
import type { ChannelListItem } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty, Pagination, PlanBadge, ResourceView, SafeLink, usePagination } from '../ui.js';
import { channelPath, clockState, managementLabels, number, planPath, time } from '../presentation.js';
import ClockPolicy from '../components/clock-policy.js';
import './overview.css';
import './discover.css';
import './channels.css';

const SCHEDULER_PENDING = '调度器在 M3 第 2 步上线后可用';
const fmt = (n: number) => n.toLocaleString('zh-CN');
const short = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const subscribers = (n: number | null) => n === null ? '—' : n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万` : fmt(n);

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
  return <section className="panel channel-detail">
    <header className="detail-head"><Avatar title={c?.title ?? id} big/><div><b>{c?.title ?? '基础资料待入库'}</b><small>{about?.handle ?? id}</small></div>{about && <SafeLink href={about.channel_url}>YouTube</SafeLink>}</header>
    <div className="detail-tabs" role="tablist"><button role="tab" aria-selected={tab === 'info'} className={tab === 'info' ? 'on' : ''} onClick={() => setTab('info')}>基本信息</button><button role="tab" aria-selected={tab === 'policy'} className={tab === 'policy' ? 'on' : ''} onClick={() => setTab('policy')}>更新策略</button></div>
    <div className="detail-body">
      {resource.error ? <p className="detail-note">{resource.error.message}</p> : !c ? <p className="detail-note">正在查询…</p> : tab === 'info' ? <>
        <dl><Row label="频道 ID"><span className="mono">{c.channel_id}</span></Row><Row label="国家 / 地区">{about?.country ?? '尚未提供'}</Row><Row label="注册日期">{about?.joined_at ?? about?.joined_date_text ?? '尚未提供'}</Row>
          <Row label="订阅数">{about ? number(about.subscriber_count.value) : '—'}</Row><Row label="总播放量">{about ? number(about.total_view_count.value) : '—'}</Row><Row label="视频总数">{about ? number(about.total_video_count.value) : '—'}</Row>
          <Row label="已入库视频">{c.videos.length} 个</Row><Row label="资料采集">{about ? time(about.observed_at) : '—'}</Row></dl>
        <h3>最近一轮采集</h3>
        <dl><Row label="计划"><Link to={planPath(c.latest_plan.plan_id)} className="mono">{c.latest_plan.plan_id.slice(0, 8)}…</Link></Row><Row label="状态"><PlanBadge status={c.latest_plan.status}/></Row><Row label="Agent 画像">{c.agent ? '已入库' : '尚未执行'}</Row><Row label="发布交付">未启用</Row></dl>
      </> : <ClockPolicy channel={c} operator={session.role === 'operator'} onChanged={resource.refresh}/>}
    </div>
    <footer className="detail-actions"><Link className="button small" to={channelPath(id)}>查看完整数据</Link><button className="button small" disabled title={SCHEDULER_PENDING}>立即更新</button></footer>
  </section>;
}
const clockShort: Record<ChannelListItem['clocks'][number]['clock'], string> = { ABOUT: '资料', VIDEO: '视频', AGENT: 'Agent' };
const day = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(value));
/** "Next update" cell: one line per clock with its state, as in the old dashboard. */
function NextUpdates({ ch }: { ch: ChannelListItem }) {
  if (!ch.clocks.length) return <span className="text-muted">{managementLabels[ch.management_state ?? 'none']}</span>;
  return <div className="clock-lines">{ch.clocks.map(k => { const s = clockState(k, ch.management_state); return <div key={k.clock} className="clock-line">
    <span className="clock-name">{clockShort[k.clock]}</span><span className="mono">{day(k.next_due_at)}</span><span className={`status-chip ${s.tone === 'bad' ? 'red' : s.tone === 'warn' ? 'amber' : ''}`}>{s.label}</span></div>; })}</div>;
}

export default function Channels() {
  const { api } = useAuth(); const paging = usePagination();
  const resource = useResource(`channels:${paging.cursor}`, signal => api.channels(paging.cursor, 20, signal));
  const completeness = useResource('channels-completeness', signal => api.completeness(signal), true, 15_000);
  const [selected, setSelected] = useState<string>();
  const realFirst = resource.data?.items[0]?.channel_id;
  const current = selected ?? realFirst;
  const c = completeness.data;
  return <div className="dashboard discover channels-page">
    <header className="dashboard-heading">
      <div><h1>频道管理</h1><p>已纳管的 YouTube 频道：采集状态、数据完整性与更新计划</p>
        {completeness.updatedAt ? <span className="data-freshness"><i/>数据已同步 · {short(new Date(completeness.updatedAt).toISOString())}</span> : null}</div>
      <div className="dashboard-period"><button className="button small" disabled title="频道导入尚未接入"><Download size={13}/>导入频道</button><button className="button small primary" disabled title="添加频道尚未接入"><Plus size={13}/>新增频道</button></div>
    </header>

    <div className="discover-kpis">
      <Kpi label="纳管频道" tone="blue" icon={<Tv size={22}/>} value={c && fmt(c.total_channels)} foot={c?.latest_channel_update_at ? `最近入库 ${short(c.latest_channel_update_at)}` : '—'}/>
      <Kpi label="数据完整" tone="green" icon={<CircleCheck size={22}/>} value={c && fmt(c.complete)} foot={c ? `部分可用 ${c.partial} · 待补全 ${c.missing}` : '—'}/>
      <Kpi label="逾期未更新" tone="red" icon={<TriangleAlert size={22}/>} value={c && fmt(c.management.overdue)} foot={c ? `持续更新中 ${fmt(c.management.managed)} 个` : '—'}/>
      <Kpi label="已暂停" tone="amber" icon={<CirclePause size={22}/>} value={c && fmt(c.management.paused)} foot="暂停期间到期不会自动更新"/>
    </div>

    <div className="discover-row row-channels">
      <section className="panel channels-list">
        <div className="status-tabs" role="tablist">{([['all', '全部'], ['ok', '正常'], ['overdue', '逾期'], ['paused', '已暂停']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={key === 'all'} className={key === 'all' ? 'on' : ''} disabled={key !== 'all'} title={key === 'all' ? undefined : '按状态筛选在 M3 第 6 步接入'}>{label}<span>{c ? { all: c.total_channels, ok: c.management.managed - c.management.overdue, overdue: c.management.overdue, paused: c.management.paused }[key] : '—'}</span></button>)}</div>
        <div className="list-tools channel-filters"><label className="list-search" htmlFor="channel-search"><Search size={13}/><input id="channel-search" placeholder="搜索频道名称 / 频道 ID" disabled/></label>
          {['国家 / 地区', '业务分类', '更新状态', 'Agent 状态'].map(label => <select key={label} aria-label={label} disabled><option>{label}</option></select>)}</div>
        <ResourceView resource={resource}>{page => <>{page.items.length ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>国家 / 地区</th><th className="num">订阅数</th><th className="num">已入库视频</th><th>最近入库</th><th>下次更新</th><th>最近计划</th><th>操作</th></tr></thead>
            <tbody>{page.items.map((ch: ChannelListItem) => <tr key={ch.channel_id} className={ch.channel_id === current ? 'selected' : ''} onClick={() => setSelected(ch.channel_id)} aria-selected={ch.channel_id === current}>
              <td><div className="channel-cell"><Avatar title={ch.title ?? ch.channel_id}/><div><b>{ch.title ?? '基础资料待入库'}</b><small className="mono">{ch.channel_id}</small></div></div></td>
              <td>{ch.country ?? <span className="text-muted">尚未提供</span>}</td><td className="num">{subscribers(ch.subscriber_count)}</td><td className="num">{ch.stored_videos}</td><td>{short(ch.updated_at)}</td>
              <td><NextUpdates ch={ch}/></td><td><PlanBadge status={ch.latest_plan_status}/></td><td className="row-actions"><Link to={channelPath(ch.channel_id)} onClick={event => event.stopPropagation()}>详情</Link></td>
            </tr>)}</tbody></table></div> : <Empty title="尚无频道记录">创建采集计划后，可在这里查看频道。</Empty>}<Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/></>}</ResourceView>
      </section>
      {current ? <RealDetail key={current} id={current}/> : <section className="panel channel-detail"><Empty title="选择频道查看详情">{resource.loading ? '正在查询…' : '暂无频道'}</Empty></section>}
    </div>
    <footer className="dashboard-foot"><span>频道数据以已入库事实为准；“下次更新”按每个频道的更新策略计算，调度器上线前到期不会自动执行。</span><span>点击频道行查看详情</span></footer>
  </div>;
}
