import { Link } from 'react-router';
import { Activity, ArrowRight, CalendarDays, ChevronDown, CircleHelp, Cylinder, HardDrive, RefreshCw, Server } from 'lucide-react';
import type { Completeness, Page, Plan, PlanDetail, Worker } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource, type Resource } from '../resource.js';
import { Badge, Empty, ErrorBox, Panel, PlanBadge, ResourceView } from '../ui.js';
import { channelPath, errorCodeLabels, isTerminal, planPath, shortId, time } from '../presentation.js';
import Pipeline from '../components/pipeline.js';
import './overview.css';

// Overview data changes on the scale of plan runs; poll less often than detail pages.
const OVERVIEW_INTERVAL_MS = 15_000;
const compactTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const clockTime = (value: number) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
function More({ to, children = '查看全部' }: { to: string; children?: string }) { return <Link className="dashboard-more" to={to}>{children}<ArrowRight size={12}/></Link>; }
function Refresh({ resource }: { resource: Resource<unknown> }) {
  return <button className="dashboard-refresh" aria-label="刷新链路" disabled={resource.refreshing} onClick={resource.refresh} title={resource.updatedAt ? `最近查询 ${time(resource.updatedAt)}` : '刷新链路'}><RefreshCw size={12}/></button>;
}

function PipelinePanel({ detail, resource, completeness, loading = false }: { detail?: PlanDetail; resource?: Resource<PlanDetail>; completeness: Resource<Completeness>; loading?: boolean }) {
  return <>
    <div className="chain-heading"><div><h2>采集链路实时状态</h2>{detail ? <><span className="chain-scope">最近 Plan</span><PlanBadge status={detail.plan.status}/></> : <Badge>{loading ? '正在查询…' : '等待计划数据'}</Badge>}</div><div className="chain-actions">{resource && <Refresh resource={resource}/>}<More to={detail ? planPath(detail.plan.plan_id) : '/plans'}>查看链路详情</More></div></div>
    <Pipeline detail={detail} completeness={completeness}/>
    <div className="chain-foot"><span><i/>实线为样本已接入路径，虚线为待接入环节</span><span className="mobile-chain-hint">左右滑动查看完整链路 →</span>{detail ? <Link to={planPath(detail.plan.plan_id)}>最近 Plan：{shortId(detail.plan.plan_id)} · 固定样本</Link> : <span>{loading ? '正在查询最近计划…' : '还没有样本计划，创建后可查看领域结果与回执'}</span>}</div>
  </>;
}
function LatestPipeline({ id, completeness }: { id: string; completeness: Resource<Completeness> }) {
  const { api } = useAuth();
  const resource = useResource(`overview-plan:${id}`, signal => api.plan(id, signal), detail => !isTerminal(detail.plan), OVERVIEW_INTERVAL_MS);
  return <>{resource.error && <ErrorBox error={resource.error} refresh={resource.refresh}/>}<PipelinePanel detail={resource.data} resource={resource} completeness={completeness} loading={resource.loading}/></>;
}
/** The chain's structure does not depend on data, so it renders at once and fills in. */
function ChainSection({ plans, completeness }: { plans: Resource<Page<Plan>>; completeness: Resource<Completeness> }) {
  const latest = plans.data?.items[0]?.plan_id;
  if (latest) return <LatestPipeline id={latest} completeness={completeness}/>;
  return <>{plans.error && <ErrorBox error={plans.error} refresh={plans.refresh}/>}<PipelinePanel loading={plans.loading} completeness={completeness}/></>;
}

function NodeTable({ workers }: { workers: Worker[] }) {
  return <div className="table-scroll"><table><thead><tr><th>节点</th><th>状态</th><th>Worker</th><th>容量</th><th>CPU</th><th>内存</th><th>IP</th></tr></thead><tbody>{workers.map(worker => <tr key={worker.worker_id}>
    <td><Link to={`/workers?highlight=${encodeURIComponent(worker.worker_id)}`} className="node-name" title={worker.server_id}><Server size={13}/>{worker.server_id}</Link></td>
    <td><Badge tone={worker.stale ? 'red' : 'green'}><i className="status-dot"/>{worker.stale ? '失联' : '在线'}</Badge></td>
    <td><span className="truncate" title={worker.worker_id}>{worker.worker_id}</span></td>
    <td>{worker.capacity}</td><td className="text-muted">—</td><td className="text-muted">—</td><td className="text-muted">—</td>
  </tr>)}</tbody></table></div>;
}
function IpUsage() {
  return <Panel title="IP 使用情况" extra={<More to="/proxies">查看 IP 详情</More>} className="ip-panel">
    <div className="ip-usage"><div className="empty-donut" role="img" aria-label="IP 总量与使用情况尚未接入"><strong>—</strong><span>总 IP 数量</span><small>尚未接入</small></div><div className="ip-legend">{[['正常', 'green'], ['降级', 'amber'], ['冷却中', 'blue'], ['异常', 'red'], ['已停用', 'slate']].map(([label, tone]) => <div key={label}><i className={tone}/><span>{label}</span><strong>—</strong></div>)}</div></div>
  </Panel>;
}
function Trends() {
  return <Panel title="采集趋势" extra={<button className="trend-select" disabled title="趋势统计尚未接入">近7天<ChevronDown size={12}/></button>} className="trend-panel">
    <div className="trend-legend">{[['发现线索', 'blue'], ['全量采集', 'amber'], ['更新采集', 'cyan'], ['成功率', 'green']].map(([label, tone]) => <span key={label}><i className={tone}/>{label}</span>)}</div>
    <div className="trend-placeholder"><div className="trend-grid"/><div><Activity size={22}/><strong>趋势统计尚未接入</strong><span>接入 ClickHouse 后展示真实采集量与成功率</span></div></div>
  </Panel>;
}
function CapacityRisk() {
  const items: [string, typeof Cylinder][] = [['PostgreSQL', Cylinder], ['Kafka', Cylinder], ['ClickHouse', Cylinder], ['磁盘增长', HardDrive], ['备份任务', HardDrive]];
  return <Panel title="容量与增长风险" extra={<span className="dashboard-unavailable" title="监控指标尚未接入控制台 API">查看详情 <ArrowRight size={12}/></span>} className="capacity-panel">
    <div className="capacity-items">{items.map(([label, Icon]) => <div key={label} title="监控指标尚未接入控制台 API"><span><Icon size={12}/>{label}</span><strong>—</strong><small>未接入</small></div>)}</div>
  </Panel>;
}

export default function Overview() {
  const { api } = useAuth();
  const plans = useResource('overview-plans', signal => api.plans('0', undefined, 5, signal), true, OVERVIEW_INTERVAL_MS);
  const channels = useResource('overview-channels', signal => api.channels('0', 5, signal), true, OVERVIEW_INTERVAL_MS);
  const workers = useResource('overview-workers', signal => api.workers('0', 5, signal), true, OVERVIEW_INTERVAL_MS);
  const errors = useResource('overview-errors', signal => api.errors('0', 5, signal), true, OVERVIEW_INTERVAL_MS);
  const completeness = useResource('overview-completeness', signal => api.completeness(signal), true, OVERVIEW_INTERVAL_MS);
  const planFor = (id: string): Plan | undefined => plans.data?.items.find(plan => plan.plan_id === id);
  const resources = [plans, channels, workers, errors, completeness];
  const updatedAt = Math.max(0, ...resources.map(resource => resource.updatedAt ?? 0));
  const failing = resources.some(resource => resource.error);
  return <div className="dashboard">
    <header className="dashboard-heading">
      <div><h1>采集链路总览</h1><p>从发现到交付，全链路状态与业务追踪</p>
        {updatedAt > 0 && <span className={`data-freshness ${failing ? 'failing' : ''}`} title={failing ? '部分查询失败，显示的是最近一次成功结果' : '各面板每 15 秒自动查询'}><i/>{failing ? '部分数据查询失败' : '数据已同步'} · {clockTime(updatedAt)}</span>}
      </div>
      <div className="dashboard-period" title="时间范围统计尚未接入"><span className="date-placeholder">时间范围未接入<CalendarDays size={13}/></span><div><button disabled>近24小时</button><button disabled>近7天</button><button disabled>近30天</button></div></div>
    </header>
    <section className="chain-panel" id="pipeline" aria-label="采集链路实时状态"><ChainSection plans={plans} completeness={completeness}/></section>
    <div className="dashboard-row">
      <Panel title="采集节点状态" extra={<More to="/workers">查看全部节点</More>} className="nodes-panel"><ResourceView resource={workers} showMeta={false}>{page => page.items.length ? <><NodeTable workers={page.items}/><div className="dashboard-panel-note">按登记 Worker 展示 · CPU / 内存 / IP 尚未接入</div></> : <Empty title="尚无登记的 Worker">等待采集节点注册并上报心跳。</Empty>}</ResourceView></Panel>
      <IpUsage/>
      <Panel title="Worker 运行状态" extra={<More to="/workers"/>} className="runtime-panel"><ResourceView resource={workers} showMeta={false}>{page => page.items.length ? <><div className="table-scroll"><table><thead><tr><th>Worker / 版本</th><th>上报计划</th><th>接单</th><th>心跳</th></tr></thead><tbody>{page.items.map(worker => <tr key={worker.worker_id}><td><Link className="truncate" to={`/workers?highlight=${encodeURIComponent(worker.worker_id)}`} title={worker.worker_id}>{worker.worker_id}</Link><small className="truncate" title={worker.build_version}>{worker.build_version}</small></td><td>{worker.running_plan_ids.length}</td><td className={worker.accepting_work ? 'text-green' : 'text-muted'}>{worker.accepting_work ? '接单中' : '停止'}</td><td className={worker.stale ? 'text-red' : 'text-green'}>{worker.stale ? '失联' : '正常'}</td></tr>)}</tbody></table></div><div className="dashboard-panel-note">状态来自最后心跳上报，失联以服务端判定为准</div></> : <Empty title="暂无 Worker 运行记录"/>}</ResourceView></Panel>
    </div>
    <div className="dashboard-row">
      <Panel title="关键错误与 Bug 线索" extra={<More to="/errors"/>} className="bugs-panel"><ResourceView resource={errors} showMeta={false}>{page => page.items.length ? <div className="table-scroll"><table><thead><tr><th>时间</th><th>阶段</th><th>错误类型</th><th>定位线索</th></tr></thead><tbody>{page.items.map(event => <tr key={event.event_id}><td>{compactTime(event.created_at)}</td><td><span className="truncate" title={`${event.phase} · ${event.worker_id}`}>{event.phase}</span></td><td><span className="error-event-tag" title={`${event.error_code ?? event.kind} · ${event.message}`}>{event.error_code ? errorCodeLabels[event.error_code] : event.kind === 'FAILED' ? '执行失败' : '执行错误'}</span></td><td><Link to={`/errors?event=${encodeURIComponent(event.event_id)}`}>查看关联</Link></td></tr>)}</tbody></table></div> : <Empty title="查询范围内暂无错误事件"/>}</ResourceView></Panel>
      <div id="trends"><Trends/></div>
      <div className="stacked-panels">
        <CapacityRisk/>
        <Panel title="最近采集的频道" extra={<More to="/channels"/>} className="recent-panel"><ResourceView resource={channels} showMeta={false}>{page => page.items.length ? <div className="table-scroll"><table><thead><tr><th>频道名称</th><th>最近计划</th><th>更新时间</th></tr></thead><tbody>{page.items.map(channel => <tr key={channel.channel_id}><td><Link className="truncate" to={channelPath(channel.channel_id)} title={channel.channel_id}>{channel.title ?? '基础资料待入库'}</Link> <span className="fixture-tag">样本</span></td><td>{planFor(channel.latest_plan_id) ? <PlanBadge status={planFor(channel.latest_plan_id)!.status}/> : <span className="text-muted">待查询</span>}</td><td>{compactTime(channel.updated_at)}</td></tr>)}</tbody></table></div> : <Empty title="尚无频道记录"/>}</ResourceView></Panel>
      </div>
    </div>
    <footer className="dashboard-foot"><span><CircleHelp size={12}/>固定样本联调 · 列表最多查询 5 条，非系统总量；完整性为后端全量统计；“—”表示尚未接入</span><span>来源：持久业务记录 · 时间以浏览器时区显示</span></footer>
  </div>;
}
