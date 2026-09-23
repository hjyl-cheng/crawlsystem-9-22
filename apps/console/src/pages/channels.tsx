import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CircleCheck, CirclePause, Download, MoreHorizontal, Plus, Search, TriangleAlert, Tv } from 'lucide-react';
import type { ChannelListItem } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty, Pagination, PlanBadge, ResourceView, SafeLink, usePagination } from '../ui.js';
import { channelPath, number, planPath, time } from '../presentation.js';
import type { ChannelSampleRow } from './channels-sample.js';
import './overview.css';
import './discover.css';
import './channels.css';

const NOT_CONNECTED = '更新策略尚未接入';
const fmt = (n: number) => n.toLocaleString('zh-CN');
const short = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const subscribers = (n: number | null) => n === null ? '—' : n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万` : fmt(n);
const freshnessMeta = { ok: { label: '正常', tone: 'green' }, overdue: { label: '逾期', tone: 'red' }, paused: { label: '已暂停', tone: 'slate' } } as const;

function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="kv-row"><dt>{label}</dt><dd>{children}</dd></div>;
const Avatar = ({ title, color = '#3f7fe0', big = false }: { title: string; color?: string; big?: boolean }) => <span className={`avatar-dot ${big ? 'big' : ''}`} style={{ background: color }}>{title.slice(0, 1)}</span>;

/** Real detail: current About facts and latest plan of the selected channel. */
function RealDetail({ id }: { id: string }) {
  const { api } = useAuth();
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
      </> : <PolicyPlaceholder/>}
    </div>
    <footer className="detail-actions"><Link className="button small" to={channelPath(id)}>查看完整数据</Link><button className="button small" disabled title={NOT_CONNECTED}>立即更新</button></footer>
  </section>;
}
function PolicyPlaceholder({ sample }: { sample?: typeof import('./channels-sample.js')['channelsSample']['detail'] }) {
  return <>{(sample?.policies ?? [{ domain: '频道资料' }, { domain: '视频与评论' }, { domain: 'Agent 画像' }]).map(p => <div key={p.domain} className="policy-row"><b>{p.domain}</b><span>{'every' in p ? `${p.every} · 下次 ${p.next}` : '—'}</span><em className={sample ? 'on' : ''}>{sample ? '启用' : '未接入'}</em></div>)}
    {!sample && <p className="detail-note">更新周期与调度（Clock）尚未接入，接入后在此按频道配置资料、视频与 Agent 的更新频率。</p>}</>;
}
function SampleDetail({ row, detail }: { row?: ChannelSampleRow; detail: typeof import('./channels-sample.js')['channelsSample']['detail'] }) {
  const [tab, setTab] = useState<'info' | 'policy'>('info');
  if (!row) return <section className="panel channel-detail"><Empty title="选择频道查看详情"/></section>;
  return <section className="panel channel-detail">
    <header className="detail-head"><Avatar title={row.title} color={row.color} big/><div><b>{row.title}</b><small>{row.handle}</small></div></header>
    <div className="detail-tabs" role="tablist"><button role="tab" aria-selected={tab === 'info'} className={tab === 'info' ? 'on' : ''} onClick={() => setTab('info')}>基本信息</button><button role="tab" aria-selected={tab === 'policy'} className={tab === 'policy' ? 'on' : ''} onClick={() => setTab('policy')}>更新策略</button></div>
    <div className="detail-body">{tab === 'info' ? <>
      <dl><Row label="频道 ID"><span className="mono">{row.id}</span></Row><Row label="国家 / 分类">{row.country} / {row.category}</Row><Row label="注册日期">{detail.joined}</Row><Row label="订阅数">{row.subscribers}</Row><Row label="总播放量">{detail.views}</Row><Row label="已入库视频">{fmt(row.videos)} 个</Row></dl>
      <h3>当前状态</h3>
      <dl><Row label="更新状态"><span className={`status-chip ${freshnessMeta[row.freshness].tone}`}><i/>{freshnessMeta[row.freshness].label}</span></Row><Row label="最近计划"><PlanBadge status={row.plan}/></Row><Row label="Agent 画像">{row.agent}</Row><Row label="最后更新">{detail.lastRun}</Row><Row label="连续成功 / 失败">{detail.okStreak} 次 / {detail.failStreak} 次</Row></dl>
    </> : <PolicyPlaceholder sample={detail}/>}</div>
    <footer className="detail-actions"><button className="button small" disabled>暂停更新</button><button className="button small" disabled>修改策略</button></footer>
  </section>;
}

export default function Channels() {
  const { api } = useAuth(); const paging = usePagination();
  const resource = useResource(`channels:${paging.cursor}`, signal => api.channels(paging.cursor, 20, signal));
  const completeness = useResource('channels-completeness', signal => api.completeness(signal), true, 15_000);
  const [sampleOn, setSampleOn] = useState(false);
  const [sample, setSample] = useState<typeof import('./channels-sample.js')['channelsSample']>();
  const [selected, setSelected] = useState<string>();
  // The sample module loads only when asked for, so it never ships with the default view.
  useEffect(() => {
    if (!sampleOn) { setSample(undefined); setSelected(undefined); return; }
    let live = true;
    void import('./channels-sample.js').then(module => { if (live) { setSample(module.channelsSample); setSelected(module.channelsSample.rows[0]!.id); } });
    return () => { live = false; };
  }, [sampleOn]);
  const realFirst = resource.data?.items[0]?.channel_id;
  const current = selected ?? (sample ? undefined : realFirst);
  const c = completeness.data, k = sample?.kpis;
  return <div className="dashboard discover channels-page">
    <header className="dashboard-heading">
      <div><h1>频道管理</h1><p>已纳管的 YouTube 频道：采集状态、数据完整性与更新计划</p>
        {sample ? <span className="data-freshness failing"><i/>示例数据</span> : completeness.updatedAt ? <span className="data-freshness"><i/>数据已同步 · {short(new Date(completeness.updatedAt).toISOString())}</span> : null}</div>
      <div className="dashboard-period"><label className="sample-switch" htmlFor="channels-sample"><input id="channels-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label>
        <button className="button small" disabled title="频道导入尚未接入"><Download size={13}/>导入频道</button><button className="button small primary" disabled title="添加频道尚未接入"><Plus size={13}/>新增频道</button></div>
    </header>
    {sample && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据（频道均为虚构），用于预览生产规模下的页面效果。关闭开关即显示真实频道。</div>}

    <div className="discover-kpis">
      <Kpi label="纳管频道" tone="blue" icon={<Tv size={22}/>} value={k ? fmt(k.total) : c && fmt(c.total_channels)} foot={k ? '全部工作空间' : c?.latest_channel_update_at ? `最近入库 ${short(c.latest_channel_update_at)}` : '—'}/>
      <Kpi label="数据完整" tone="green" icon={<CircleCheck size={22}/>} value={k ? fmt(k.complete) : c && fmt(c.complete)} foot={k ? `部分可用 ${fmt(k.partial)} · 待补全 ${fmt(k.missing)}` : c ? `部分可用 ${c.partial} · 待补全 ${c.missing}` : '—'}/>
      <Kpi label="逾期未更新" tone="red" icon={<TriangleAlert size={22}/>} value={k && fmt(k.overdue)} foot={k ? '超过更新周期' : NOT_CONNECTED}/>
      <Kpi label="已暂停" tone="amber" icon={<CirclePause size={22}/>} value={k && fmt(k.paused)} foot={k ? '手动暂停更新' : NOT_CONNECTED}/>
    </div>

    <div className="discover-row row-channels">
      <section className="panel channels-list">
        <div className="status-tabs" role="tablist">{([['all', '全部'], ['ok', '正常'], ['overdue', '逾期'], ['paused', '已暂停']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={key === 'all'} className={key === 'all' ? 'on' : ''} disabled={key !== 'all'} title={key === 'all' ? undefined : NOT_CONNECTED}>{label}<span>{sample ? fmt(sample.tabs[key]) : key === 'all' && c ? c.total_channels : '—'}</span></button>)}</div>
        <div className="list-tools channel-filters"><label className="list-search" htmlFor="channel-search"><Search size={13}/><input id="channel-search" placeholder="搜索频道名称 / 频道 ID" disabled/></label>
          {['国家 / 地区', '业务分类', '更新状态', 'Agent 状态'].map(label => <select key={label} aria-label={label} disabled><option>{label}</option></select>)}</div>
        {sample ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>国家 / 地区</th><th>业务分类</th><th className="num">订阅数</th><th className="num">已入库视频</th><th>上次更新</th><th>下次更新</th><th>状态</th><th>最近计划</th><th>操作</th></tr></thead>
          <tbody>{sample.rows.map(r => <tr key={r.id} className={r.id === current ? 'selected' : ''} onClick={() => setSelected(r.id)} aria-selected={r.id === current}>
            <td><div className="channel-cell"><Avatar title={r.title} color={r.color}/><div><b>{r.title}</b><small>{r.handle}</small></div></div></td><td>{r.country}</td><td><span className="tag-chip">{r.category}</span></td>
            <td className="num">{r.subscribers}</td><td className="num">{fmt(r.videos)}</td><td>{r.lastUpdate}</td><td>{r.nextUpdate}</td>
            <td><span className={`status-chip ${freshnessMeta[r.freshness].tone}`}><i/>{freshnessMeta[r.freshness].label}</span></td><td><PlanBadge status={r.plan}/></td><td className="row-actions"><span>详情</span><MoreHorizontal size={14}/></td>
          </tr>)}</tbody></table></div>
          : <ResourceView resource={resource}>{page => <>{page.items.length ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>国家 / 地区</th><th className="num">订阅数</th><th className="num">已入库视频</th><th>最近入库</th><th>下次更新</th><th>最近计划</th><th>操作</th></tr></thead>
            <tbody>{page.items.map((ch: ChannelListItem) => <tr key={ch.channel_id} className={ch.channel_id === current ? 'selected' : ''} onClick={() => setSelected(ch.channel_id)} aria-selected={ch.channel_id === current}>
              <td><div className="channel-cell"><Avatar title={ch.title ?? ch.channel_id}/><div><b>{ch.title ?? '基础资料待入库'}</b><small className="mono">{ch.channel_id}</small></div></div></td>
              <td>{ch.country ?? <span className="text-muted">尚未提供</span>}</td><td className="num">{subscribers(ch.subscriber_count)}</td><td className="num">{ch.stored_videos}</td><td>{short(ch.updated_at)}</td>
              <td className="text-muted" title={NOT_CONNECTED}>—</td><td><PlanBadge status={ch.latest_plan_status}/></td><td className="row-actions"><Link to={channelPath(ch.channel_id)} onClick={event => event.stopPropagation()}>详情</Link></td>
            </tr>)}</tbody></table></div> : <Empty title="尚无频道记录">样本计划创建后，可在这里查看频道。</Empty>}<Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/></>}</ResourceView>}
      </section>
      {sample ? <SampleDetail row={sample.rows.find(r => r.id === current)} detail={sample.detail}/> : current ? <RealDetail key={current} id={current}/> : <section className="panel channel-detail"><Empty title="选择频道查看详情">{resource.loading ? '正在查询…' : '暂无频道'}</Empty></section>}
    </div>
    <footer className="dashboard-foot"><span>频道数据以已入库事实为准；“下次更新 / 逾期 / 暂停”依赖更新策略，尚未接入。</span><span>“预览示例数据”仅用于查看页面设计</span></footer>
  </div>;
}
