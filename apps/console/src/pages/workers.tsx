import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Activity, Bot, Cpu, FileText, MoreHorizontal, Pause, Search, Server, TriangleAlert, Unplug } from 'lucide-react';
import type { Worker } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty, Pagination, ResourceView, usePagination } from '../ui.js';
import { planPath, shortId, time } from '../presentation.js';
import LineChart from '../components/line-chart.js';
import type { SampleWorker } from './workers-sample.js';
import './overview.css';
import './discover.css';
import './workers.css';

const NO_METRICS = '资源指标尚未接入（Prometheus）';
const OK = '#277cf7', FAIL = '#e0524a';
// Validated for colour-vision deficiency: blue / dark orange / green.
const RESOURCE_SERIES = [{ key: 'cpu', label: 'CPU', color: '#277cf7' }, { key: 'mem', label: '内存', color: '#c96a12' }, { key: 'disk', label: '磁盘', color: '#0f9f75' }];
const sampleState = { running: { label: '运行中', tone: 'green' }, idle: { label: '空闲', tone: 'blue' }, stale: { label: '心跳失联', tone: 'red' }, paused: { label: '暂停接单', tone: 'slate' } } as const;

function Card({ title, subtitle, extra, className = '', children }: { title: string; subtitle?: string; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{extra}</div>{children}</section>;
}
function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="kv-row"><dt>{label}</dt><dd>{children}</dd></div>;
const Meter = ({ value }: { value: number }) => <span className="meter"><span><i className={value >= 80 ? 'hot' : ''} style={{ width: `${value}%` }}/></span>{value}%</span>;

/** Servers as registered by Workers' heartbeats; resource figures need Prometheus. */
function serversOf(workers: Worker[]) {
  const map = new Map<string, { name: string; workers: number; online: number; running: number }>();
  for (const w of workers) {
    const s = map.get(w.server_id) ?? { name: w.server_id, workers: 0, online: 0, running: 0 };
    s.workers++; if (!w.stale) s.online++; s.running += w.running_plan_ids.length; map.set(w.server_id, s);
  }
  return [...map.values()];
}

function RealDetail({ worker }: { worker?: Worker }) {
  if (!worker) return <section className="panel worker-detail"><Empty title="选择 Worker 查看详情">暂无已登记的 Worker</Empty></section>;
  return <section className="panel worker-detail">
    <header className="detail-head"><span className={`live-dot ${worker.stale ? 'off' : ''}`}/><div><b className="mono">{worker.worker_id}</b><small>{worker.stale ? '失联' : '在线'} · 最后心跳 {time(worker.last_heartbeat_at)}</small></div></header>
    <div className="detail-tabs" role="tablist"><button role="tab" aria-selected="true" className="on">基本信息</button><button role="tab" aria-selected="false" disabled title={NO_METRICS}>资源监控</button><button role="tab" aria-selected="false" disabled title="日志请在运维工具查看">日志</button></div>
    <div className="detail-body">
      <dl><Row label="所属服务器"><span className="mono">{worker.server_id}</span></Row><Row label="版本"><span className="mono">{worker.build_version}</span></Row><Row label="并发容量">{worker.capacity}</Row>
        <Row label="接单">{worker.accepting_work ? '接单中' : '已暂停'}</Row><Row label="在线">{worker.stale ? '失联（服务端判定）' : '在线'}</Row><Row label="代理">未配置</Row><Row label="CPU / 内存">—</Row></dl>
      <h3>运行中的计划</h3>
      {worker.running_plan_ids.length ? <ul className="plan-links">{worker.running_plan_ids.map(id => <li key={id}><Link to={planPath(id)} className="mono">{shortId(id)}</Link></li>)}</ul> : <p className="detail-note">当前没有上报的运行计划。</p>}
    </div>
    <footer className="detail-actions"><button className="button small" disabled title="接单控制尚未接入"><Pause size={13}/>暂停接单</button><button className="button small" disabled title="排空尚未接入"><Unplug size={13}/>排空</button></footer>
  </section>;
}
function SampleDetail({ w }: { w?: SampleWorker }) {
  if (!w) return <section className="panel worker-detail"><Empty title="选择 Worker 查看详情"/></section>;
  const s = sampleState[w.state];
  return <section className="panel worker-detail">
    <header className="detail-head"><span className={`live-dot ${w.state === 'stale' ? 'off' : ''}`}/><div><b className="mono">{w.id}</b><small>{s.label === '心跳失联' ? '失联' : s.label} · 已运行 {w.uptime}</small></div></header>
    <div className="detail-tabs" role="tablist"><button role="tab" aria-selected="true" className="on">基本信息</button><button role="tab" aria-selected="false" disabled>资源监控</button><button role="tab" aria-selected="false" disabled>日志</button></div>
    <div className="detail-body">
      <dl><Row label="Worker 类型">{w.type}</Row><Row label="所属服务器"><span className="mono">{w.server}</span></Row><Row label="内网 IP"><span className="mono">{w.ip}</span></Row><Row label="版本"><span className="mono">{w.version}</span></Row><Row label="并发容量">{w.capacity}</Row><Row label="当前任务">{w.task ?? '—'}</Row><Row label="CPU"><Meter value={w.cpu}/></Row><Row label="内存"><Meter value={w.mem}/></Row></dl>
    </div>
    <footer className="detail-actions"><button className="button small" disabled><Pause size={13}/>暂停接单</button><button className="button small" disabled><Unplug size={13}/>排空</button><button className="button small" disabled><FileText size={13}/>查看日志</button></footer>
  </section>;
}

export default function Workers() {
  const { api } = useAuth(); const paging = usePagination();
  const highlight = paging.params.get('highlight');
  const resource = useResource(`workers:${paging.cursor}`, signal => api.workers(paging.cursor, 20, signal));
  const [sampleOn, setSampleOn] = useState(false);
  const [sample, setSample] = useState<typeof import('./workers-sample.js')['workersSample']>();
  const [selected, setSelected] = useState<string>();
  // The sample module loads only when asked for, so it never ships with the default view.
  useEffect(() => {
    if (!sampleOn) { setSample(undefined); setSelected(undefined); return; }
    let live = true;
    void import('./workers-sample.js').then(module => { if (live) { setSample(module.workersSample); setSelected(module.workersSample.workers[0]!.id); } });
    return () => { live = false; };
  }, [sampleOn]);
  const real = resource.data?.items ?? [];
  const servers = serversOf(real);
  const current = selected ?? (sample ? undefined : highlight ?? real[0]?.worker_id);
  const k = sample?.kpis;
  const running = real.reduce((sum, w) => sum + w.running_plan_ids.length, 0);
  return <div className="dashboard discover workers-page">
    <header className="dashboard-heading">
      <div><h1>Worker 管理</h1><p>采集 Worker 与所在服务器：心跳、接单、运行任务与资源负载</p>{sample ? <span className="data-freshness failing"><i/>示例数据</span> : resource.updatedAt ? <span className="data-freshness"><i/>心跳已同步 · {time(resource.updatedAt)}</span> : null}</div>
      <div className="dashboard-period"><label className="sample-switch" htmlFor="workers-sample"><input id="workers-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label></div>
    </header>
    {sample && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据（含资源指标），用于预览生产规模下的页面效果。关闭开关即显示真实 Worker 心跳。</div>}

    <div className="discover-kpis">
      <Kpi label="服务器" tone="blue" icon={<Server size={22}/>} value={k ? k.servers : resource.data ? servers.length : undefined} foot={k ? `在线 ${k.serversOnline} · 离线 ${k.servers - k.serversOnline}` : resource.data ? `在线 ${servers.filter(s => s.online > 0).length} · 按 Worker 登记` : '—'}/>
      <Kpi label="Worker" tone="green" icon={<Bot size={22}/>} value={k ? k.workers : resource.data ? real.length : undefined} foot={k ? `接单中 ${k.accepting} · 失联 ${k.stale}` : resource.data ? `接单中 ${real.filter(w => w.accepting_work && !w.stale).length} · 失联 ${real.filter(w => w.stale).length}` : '—'}/>
      <Kpi label="运行中任务" tone="blue" icon={<Activity size={22}/>} value={k ? k.running : resource.data ? running : undefined} foot={k ? '按 Worker 上报' : '按 Worker 心跳上报的计划数'}/>
      <Kpi label="资源使用率" tone="amber" icon={<Cpu size={22}/>} value={k ? `${k.cpu}% / ${k.mem}%` : undefined} foot={k ? 'CPU / 内存（全部服务器平均）' : NO_METRICS}/>
    </div>

    <div className="discover-row row-workers">
      <section className="panel worker-list">
        <div className="status-tabs" role="tablist"><button role="tab" aria-selected="true" className="on">Worker<span>{sample ? sample.tabs.workers : resource.data ? real.length : '—'}</span></button><button role="tab" aria-selected="false" disabled title="服务器列表见下方">服务器<span>{sample ? sample.tabs.servers : resource.data ? servers.length : '—'}</span></button><button role="tab" aria-selected="false" disabled title="运行任务请在采集任务页查看">运行任务<span>{sample ? sample.tabs.tasks : resource.data ? running : '—'}</span></button></div>
        <div className="list-tools worker-filters"><label className="list-search" htmlFor="worker-search"><Search size={13}/><input id="worker-search" placeholder="搜索 Worker / 服务器…" disabled/></label>{['全部状态', '全部服务器', '全部类型'].map(label => <select key={label} aria-label={label} disabled><option>{label}</option></select>)}</div>
        {sample ? <div className="table-scroll"><table><thead><tr><th>Worker</th><th>类型</th><th>状态</th><th>服务器</th><th>内网 IP</th><th>当前任务</th><th>运行时长</th><th>CPU</th><th>内存</th><th>操作</th></tr></thead>
          <tbody>{sample.workers.map(w => { const s = sampleState[w.state]; return <tr key={w.id} className={w.id === current ? 'selected' : ''} onClick={() => setSelected(w.id)} aria-selected={w.id === current}>
            <td className="mono query-term">{w.id}</td><td><span className="tag-chip">{w.type}</span></td><td><span className={`status-chip ${s.tone}`}><i/>{s.label}</span></td><td className="mono">{w.server}</td><td className="mono">{w.ip}</td><td>{w.task ?? '—'}</td><td>{w.uptime}</td><td><Meter value={w.cpu}/></td><td><Meter value={w.mem}/></td><td className="row-actions"><MoreHorizontal size={14}/></td>
          </tr>; })}</tbody></table></div>
          : <ResourceView resource={resource}>{page => <>{highlight && !page.items.some(w => w.worker_id === highlight) && <div className="notice">当前页未包含 Worker <code>{highlight}</code>，可继续翻页查看。</div>}
            {page.items.length ? <div className="table-scroll"><table><thead><tr><th>Worker</th><th>心跳</th><th>接单</th><th>服务器</th><th>版本</th><th className="num">容量</th><th className="num">运行计划</th><th>最后心跳</th><th>代理</th><th>CPU / 内存</th></tr></thead>
              <tbody>{page.items.map(w => <tr key={w.worker_id} className={`${w.worker_id === current ? 'selected' : ''} ${w.worker_id === highlight ? 'highlight-row' : ''}`} onClick={() => setSelected(w.worker_id)} aria-selected={w.worker_id === current}>
                <td className="mono query-term">{w.worker_id}</td><td><span className={`status-chip ${w.stale ? 'red' : 'green'}`}><i/>{w.stale ? '心跳失联' : '心跳正常'}</span></td><td>{w.accepting_work ? '上报接单中' : '上报停止接单'}</td>
                <td className="mono">{w.server_id}</td><td className="mono">{w.build_version}</td><td className="num">{w.capacity}</td><td className="num">{w.running_plan_ids.length}</td><td>{time(w.last_heartbeat_at)}</td>
                <td><span className="cell-title">未配置</span><small className="cell-sub">固定样本不使用代理</small></td><td className="text-muted" title={NO_METRICS}>—</td>
              </tr>)}</tbody></table></div> : <Empty title="尚无登记的 Worker">等待执行节点注册并上报心跳。</Empty>}
            <Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/></>}</ResourceView>}
      </section>
      {sample ? <SampleDetail w={sample.workers.find(w => w.id === current)}/> : <RealDetail worker={real.find(w => w.worker_id === current)}/>}
    </div>

    <div className="discover-row row-servers">
      <Card title="服务器" subtitle={sample ? undefined : '按 Worker 心跳登记的服务器'} className="span-2">
        {sample ? <div className="table-scroll"><table><thead><tr><th>服务器</th><th>地区</th><th>IP</th><th>状态</th><th>CPU</th><th>内存</th><th>磁盘</th><th>网络</th><th className="num">Worker</th></tr></thead><tbody>{sample.servers.map(s => <tr key={s.name}><td className="mono query-term">{s.name}</td><td>{s.region}</td><td className="mono">{s.ip}</td><td><span className={`status-chip ${s.online ? 'green' : 'red'}`}><i/>{s.online ? '在线' : '离线'}</span></td><td>{s.online ? <Meter value={s.cpu}/> : '—'}</td><td>{s.online ? <Meter value={s.mem}/> : '—'}</td><td>{s.online ? <Meter value={s.disk}/> : '—'}</td><td>{s.net}</td><td className="num">{s.workers}</td></tr>)}</tbody></table></div>
          : servers.length ? <div className="table-scroll"><table><thead><tr><th>服务器</th><th className="num">Worker</th><th className="num">在线</th><th className="num">运行计划</th><th>CPU / 内存 / 磁盘</th></tr></thead><tbody>{servers.map(s => <tr key={s.name}><td className="mono query-term">{s.name}</td><td className="num">{s.workers}</td><td className={`num ${s.online < s.workers ? 'text-red' : 'text-green'}`}>{s.online}</td><td className="num">{s.running}</td><td className="text-muted" title={NO_METRICS}>—</td></tr>)}</tbody></table></div>
          : <Empty title="暂无服务器">{resource.loading ? '正在查询…' : '等待 Worker 登记'}</Empty>}
      </Card>
      <Card title="任务执行趋势" subtitle="近 24 小时，每小时完成的任务" extra={sample && <div className="chart-legend"><span><i style={{ background: OK }}/>成功</span><span><i style={{ background: FAIL }}/>失败</span></div>}>
        <LineChart points={sample?.tasks.map(t => ({ x: t.x, values: { ok: t.ok, failed: t.failed } }))} series={[{ key: 'ok', label: '成功', color: OK, area: true }, { key: 'failed', label: '失败', color: FAIL }]} max={sample ? 400 : undefined} empty="任务趋势尚未接入" label="近 24 小时每小时完成的任务"/>
      </Card>
      <Card title="资源使用率" subtitle="全部服务器平均" extra={sample && <div className="chart-legend">{RESOURCE_SERIES.map(s => <span key={s.key}><i style={{ background: s.color }}/>{s.label}</span>)}</div>}>
        <LineChart points={sample?.resources.map(r => ({ x: r.x, values: { cpu: r.cpu, mem: r.mem, disk: r.disk } }))} series={RESOURCE_SERIES} max={100} format={v => `${v}%`} empty={NO_METRICS} label="全部服务器平均资源使用率"/>
      </Card>
    </div>
    <footer className="dashboard-foot"><span>Worker 状态以心跳为准，失联由服务端判定；重启、下线等部署操作请在运维工具中进行。</span><span>“预览示例数据”仅用于查看页面设计</span></footer>
  </div>;
}
