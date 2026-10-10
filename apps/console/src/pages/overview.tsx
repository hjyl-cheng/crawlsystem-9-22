import {useState} from 'react';
import { Link } from 'react-router';
import { Activity, ArrowRight, CalendarDays, ChevronDown, CircleHelp, Cylinder, HardDrive, RefreshCw, Server } from 'lucide-react';
import type { Completeness, Page, Plan, PlanDetail, Worker,OverviewResources } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource, type Resource } from '../resource.js';
import { Badge, Empty, ErrorBox, Panel, PlanBadge, ResourceView } from '../ui.js';
import { channelPath, errorCodeLabels, isTerminal, planPath, shortId, time } from '../presentation.js';
import Pipeline,{type PipelineResources} from '../components/pipeline.js';
import {OverviewTrends as Trends} from './analytics.js';
import './overview.css';

// Overview data changes on the scale of plan runs; poll less often than detail pages.
const OVERVIEW_INTERVAL_MS = 15_000;
const compactTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const clockTime = (value: number) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
function More({ to, children = '查看全部' }: { to: string; children?: string }) { return <Link className="dashboard-more" to={to}>{children}<ArrowRight size={12}/></Link>; }
function Refresh({ resource }: { resource: Resource<unknown> }) {
  return <button className="dashboard-refresh" aria-label="刷新链路" disabled={resource.refreshing} onClick={resource.refresh} title={resource.updatedAt ? `最近查询 ${time(resource.updatedAt)}` : '刷新链路'}><RefreshCw size={12}/></button>;
}

function PipelinePanel({ detail, resource, completeness, pipeline,loading = false }: { detail?: PlanDetail; resource?: Resource<PlanDetail>; completeness: Resource<Completeness>;pipeline:PipelineResources; loading?: boolean }) {
  return <>
    <div className="chain-heading"><div><h2>采集链路实时状态</h2>{detail ? <><span className="chain-scope">最近 Plan</span><PlanBadge status={detail.plan.status}/></> : <Badge>{loading ? '正在查询…' : '等待计划数据'}</Badge>}</div><div className="chain-actions">{resource && <Refresh resource={resource}/>}<More to={detail ? planPath(detail.plan.plan_id) : '/plans'}>查看链路详情</More></div></div>
    <Pipeline detail={detail} completeness={completeness} resources={pipeline}/>
    <div className="chain-foot"><span><i/>队列为实时状态 · 今日搜索按 UTC</span><span className="mobile-chain-hint">左右滑动查看完整链路 →</span>{detail ? <Link to={planPath(detail.plan.plan_id)}>最近 Plan：{shortId(detail.plan.plan_id)} · 真实频道</Link> : <span>{loading ? '正在查询最近计划…' : '还没有真实频道计划，创建后可查看领域结果与回执'}</span>}</div>
  </>;
}
function LatestPipeline({ id, completeness,pipeline }: { id: string; completeness: Resource<Completeness>;pipeline:PipelineResources }) {
  const { api } = useAuth();
  const resource = useResource(`overview-plan:${id}`, signal => api.plan(id, signal), detail => !isTerminal(detail.plan)||detail.plan.publication_status==='PENDING', OVERVIEW_INTERVAL_MS);
  return <>{resource.error && <ErrorBox error={resource.error} refresh={resource.refresh}/>}<PipelinePanel detail={resource.data} resource={resource} completeness={completeness} pipeline={pipeline} loading={resource.loading}/></>;
}
/** The chain's structure does not depend on data, so it renders at once and fills in. */
function ChainSection({ plans, completeness,pipeline }: { plans: Resource<Page<Plan>>; completeness: Resource<Completeness>;pipeline:PipelineResources }) {
  const latest = plans.data?.items[0]?.plan_id;
  if (latest) return <LatestPipeline id={latest} completeness={completeness} pipeline={pipeline}/>;
  return <>{plans.error && <ErrorBox error={plans.error} refresh={plans.refresh}/>}<PipelinePanel loading={plans.loading} completeness={completeness} pipeline={pipeline}/></>;
}

function NodeTable({ workers,resources }: { workers: Worker[];resources?:OverviewResources }) {
  const memory=(used:number,total:number)=>`${(used/1024**3).toFixed(1)} / ${(total/1024**3).toFixed(1)} GiB`;
  return <div className="table-scroll"><table><thead><tr><th>节点</th><th>状态</th><th>Worker</th><th>容量</th><th>节点 CPU</th><th>节点内存</th><th>分配 IP</th></tr></thead><tbody>{workers.map(worker=>{
    const node=resources?.monitoring.nodes.find(n=>n.server_id===worker.server_id),assigned=resources?.proxies.assignments.filter(n=>n.server_id.replace(/^crawl-/,'')===worker.server_id.replace(/^crawl-/,'')).reduce((a,b)=>a+b.assigned,0);
    return <tr key={worker.worker_id}>
    <td><Link to={`/workers?highlight=${encodeURIComponent(worker.worker_id)}`} className="node-name" title={worker.server_id}><Server size={13}/>{worker.server_id}</Link></td>
    <td><Badge tone={worker.stale ? 'red' : 'green'}><i className="status-dot"/>{worker.stale ? '失联' : '在线'}</Badge></td>
    <td><span className="truncate" title={worker.worker_id}>{worker.worker_id}</span></td>
    <td>{worker.capacity}</td><td title={node?.sampled_at?`节点近 2 分钟平均 · 采样 ${time(node.sampled_at)}`:'暂无新鲜监控采样'}>{node?.cpu_percent===null||node?.cpu_percent===undefined?'—':`${node.cpu_percent.toFixed(1)}%`}</td><td title="节点总内存减去可用内存，非单个 Worker 用量">{node?.memory_used_bytes===null||node?.memory_used_bytes===undefined||node.memory_total_bytes===null?'—':memory(node.memory_used_bytes,node.memory_total_bytes)}</td><td>{assigned===undefined?'—':assigned}</td>
  </tr>;})}</tbody></table></div>;
}
function IpUsage({resources}:{resources:Resource<OverviewResources>}) {
  return <Panel title="IP 使用情况" extra={<More to="/proxies">查看 IP 详情</More>} className="ip-panel">
    <ResourceView resource={resources} showMeta={false}>{r=>{
      const s=r.proxies.by_state,groups=[['健康',s.healthy,'#00bb88'],['试用 / 未知',s.trial+s.unknown,'#8fa3c0'],['降级',s.degraded,'#f4a524'],['冷却中',s.cooldown,'#377cfa'],['失败',s.failed,'#e66767'],['未分配',s.unassigned,'#a885db'],['已停用',s.disabled,'#c5d1e0']] as const;let cursor=0;
      const stops=groups.map(([,n,color])=>{const start=cursor;cursor+=r.proxies.total?n/r.proxies.total*100:0;return `${color} ${start}% ${cursor}%`;});
      return <div className="ip-usage"><div className="ip-donut" role="img" aria-label={`IP 库存 ${r.proxies.total}，健康 ${s.healthy}`} style={{background:r.proxies.total?`conic-gradient(${stops.join(',')})`:'#e9eff7'}}><div><strong>{r.proxies.total.toLocaleString('zh-CN')}</strong><span>IP 库存总数</span></div></div><div className="ip-legend">{groups.map(([label,n,color])=><div key={label}><i style={{background:color}}/><span>{label}</span><strong>{n.toLocaleString('zh-CN')}</strong></div>)}</div></div>;
    }}</ResourceView>
  </Panel>;
}
function CapacityRisk() {
  const {api}=useAuth(),r=useResource('overview-storage',signal=>api.storage(signal),true,30000);
  return <Panel title="存储与归档" extra={<More to="/storage" children="查看详情"/>} className="capacity-panel"><ResourceView resource={r} showMeta={false}>{s=><div className="capacity-items">
    <div><span><Cylinder size={12}/>PostgreSQL</span><strong>{(s.postgres_bytes/1024/1024).toFixed(1)} MiB</strong><small>数据库大小</small></div>
    <div><span><Cylinder size={12}/>ClickHouse</span><strong>{s.clickhouse.bytes===null?'—':`${(s.clickhouse.bytes/1024/1024).toFixed(1)} MiB`}</strong><small>{s.clickhouse.available?'正常':'暂时不可用'}</small></div>
    <div><span>待归档事件</span><strong>{s.outbox.unarchived}</strong><small>等待统计入库</small></div>
    <div><span>待处理失败</span><strong>{s.failures.open}</strong><small>重试中 {s.failures.retrying}</small></div>
  </div>}</ResourceView></Panel>;
}

export default function Overview() {
  const { api } = useAuth();
  const [days,setDays]=useState(7);
  const plans = useResource('overview-plans', signal => api.plans('0', undefined, 5, signal), true, OVERVIEW_INTERVAL_MS);
  const channels = useResource('overview-channels', signal => api.channels('0', 5, signal), true, OVERVIEW_INTERVAL_MS);
  const workers = useResource('overview-workers', signal => api.workers('0', 5, signal), true, OVERVIEW_INTERVAL_MS);
  const errors = useResource('overview-errors', signal => api.errors('0', 5, signal), true, OVERVIEW_INTERVAL_MS);
  const completeness = useResource('overview-completeness', signal => api.completeness(signal), true, OVERVIEW_INTERVAL_MS);
  const pipeline:PipelineResources={
    queries:useResource('overview-queries',s=>api.querySummary(s),true,OVERVIEW_INTERVAL_MS),
    candidates:useResource('overview-candidates',s=>api.candidateSummary(s),true,OVERVIEW_INTERVAL_MS),
    imports:useResource('overview-imports',s=>api.channelImports(s),true,OVERVIEW_INTERVAL_MS),
    updates:useResource('overview-updates',s=>api.updatesSummary(s),true,OVERVIEW_INTERVAL_MS),
    agent:useResource('overview-agent',s=>api.agentSummary(s),true,OVERVIEW_INTERVAL_MS),
    dataApi:useResource('overview-data-api',s=>api.dataApiSummary(s),true,OVERVIEW_INTERVAL_MS),
    delivery:useResource('overview-delivery',s=>api.deliverySummary(s),true,OVERVIEW_INTERVAL_MS),
  };
  const resources=useResource('overview-resources',s=>api.overviewResources(s),true,30000);
  const planFor = (id: string): Plan | undefined => plans.data?.items.find(plan => plan.plan_id === id);
  const snapshots = [plans, channels, workers, errors, completeness,resources,...Object.values(pipeline)];
  const updatedAt = Math.max(0, ...snapshots.map(resource => resource.updatedAt ?? 0));
  const failing = snapshots.some(resource => resource.error);
  return <div className="dashboard">
    <header className="dashboard-heading">
      <div><h1>采集链路总览</h1><p>从发现到交付，全链路状态与业务追踪</p>
        {updatedAt > 0 && <span className={`data-freshness ${failing ? 'failing' : ''}`} title={failing ? '部分查询失败，显示的是最近一次成功结果' : '队列每 15 秒、资源与趋势每 30 秒查询'}><i/>{failing ? '部分数据查询失败' : snapshots.some(r=>r.loading)?'正在同步数据':'数据已同步'} · {clockTime(updatedAt)}</span>}
      </div>
      <div className="dashboard-period" role="group" aria-label="趋势统计范围" title="时间范围仅影响历史趋势；日界线为 UTC，队列仍为实时状态"><div>{[[1,'今天（UTC）'],[7,'近7天'],[30,'近30天']].map(([n,label])=><button key={n} aria-pressed={days===n} onClick={()=>setDays(Number(n))}>{label}</button>)}</div><button className="dashboard-refresh" aria-label="刷新实时状态" disabled={snapshots.some(r=>r.refreshing)} onClick={()=>snapshots.forEach(r=>r.refresh())}><RefreshCw size={13}/></button></div>
    </header>
    <section className="chain-panel" id="pipeline" aria-label="采集链路实时状态"><ChainSection plans={plans} completeness={completeness} pipeline={pipeline}/></section>
    <div className="dashboard-row">
      <Panel title="采集节点状态" extra={<More to="/workers">查看全部节点</More>} className="nodes-panel"><ResourceView resource={workers} showMeta={false}>{page => page.items.length ? <><NodeTable workers={page.items} resources={resources.data}/><div className="dashboard-panel-note">CPU / 内存为所在节点 · IP 为启用分配数{resources.error||resources.data?.monitoring.available===false?' · 监控暂不可用':''}</div></> : <Empty title="尚无登记的 Worker">等待采集节点注册并上报心跳。</Empty>}</ResourceView></Panel>
      <IpUsage resources={resources}/>
      <Panel title="Worker 运行状态" extra={<More to="/workers"/>} className="runtime-panel"><ResourceView resource={workers} showMeta={false}>{page => page.items.length ? <><div className="table-scroll"><table><thead><tr><th>Worker / 版本</th><th>上报计划</th><th>接单</th><th>心跳</th></tr></thead><tbody>{page.items.map(worker => <tr key={worker.worker_id}><td><Link className="truncate" to={`/workers?highlight=${encodeURIComponent(worker.worker_id)}`} title={worker.worker_id}>{worker.worker_id}</Link><small className="truncate" title={worker.build_version}>{worker.build_version}</small></td><td>{worker.running_plan_ids.length}</td><td className={worker.accepting_work ? 'text-green' : 'text-muted'}>{worker.accepting_work ? '接单中' : '停止'}</td><td className={worker.stale ? 'text-red' : 'text-green'}>{worker.stale ? '失联' : '正常'}</td></tr>)}</tbody></table></div><div className="dashboard-panel-note">状态来自最后心跳上报，失联以服务端判定为准</div></> : <Empty title="暂无 Worker 运行记录"/>}</ResourceView></Panel>
    </div>
    <div className="dashboard-row">
      <Panel title="关键错误与 Bug 线索" extra={<More to="/errors"/>} className="bugs-panel"><ResourceView resource={errors} showMeta={false}>{page => page.items.length ? <div className="table-scroll"><table><thead><tr><th>时间</th><th>阶段</th><th>错误类型</th><th>定位线索</th></tr></thead><tbody>{page.items.map(event => <tr key={event.event_id}><td>{compactTime(event.created_at)}</td><td><span className="truncate" title={`${event.phase} · ${event.worker_id}`}>{event.phase}</span></td><td><span className="error-event-tag" title={`${event.error_code ?? event.kind} · ${event.message}`}>{event.error_code ? errorCodeLabels[event.error_code] : event.kind === 'FAILED' ? '执行失败' : '执行错误'}</span></td><td><Link to={`/errors?event=${encodeURIComponent(event.event_id)}`}>查看关联</Link></td></tr>)}</tbody></table></div> : <Empty title="查询范围内暂无错误事件"/>}</ResourceView></Panel>
      <div id="trends"><Trends days={days}/></div>
      <div className="stacked-panels">
        <CapacityRisk/>
        <Panel title="最近采集的频道" extra={<More to="/channels"/>} className="recent-panel"><ResourceView resource={channels} showMeta={false}>{page => page.items.length ? <div className="table-scroll"><table><thead><tr><th>频道名称</th><th>最近计划</th><th>更新时间</th></tr></thead><tbody>{page.items.map(channel => <tr key={channel.channel_id}><td><Link className="truncate" to={channelPath(channel.channel_id)} title={channel.channel_id}>{channel.title ?? '基础资料待入库'}</Link>{channel.source_mode === 'fixture' && <> <span className="fixture-tag">样本</span></>}</td><td>{planFor(channel.latest_plan_id) ? <PlanBadge status={planFor(channel.latest_plan_id)!.status}/> : <span className="text-muted">待查询</span>}</td><td>{compactTime(channel.updated_at)}</td></tr>)}</tbody></table></div> : <Empty title="尚无频道记录"/>}</ResourceView></Panel>
      </div>
    </div>
    <footer className="dashboard-foot"><span><CircleHelp size={12}/>采集统计只含真实频道 · 列表最多 5 条，汇总覆盖整个工作区 · “—”表示暂无采样</span><span>PG 当前状态 · ClickHouse 历史趋势 · Prometheus 节点资源</span></footer>
  </div>;
}
