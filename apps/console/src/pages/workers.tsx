import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Activity, Bot, Cpu, Pause, Search, Server, Unplug } from 'lucide-react';
import type { Worker } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty, Pagination, ResourceView, usePagination } from '../ui.js';
import { planPath, shortId, time } from '../presentation.js';
import LineChart from '../components/line-chart.js';
import './overview.css';
import './discover.css';
import './workers.css';

const NO_METRICS = '资源指标尚未接入（Prometheus）';
const OK = '#277cf7', FAIL = '#e0524a';
// Validated for colour-vision deficiency: blue / dark orange / green.
const RESOURCE_SERIES = [{ key: 'cpu', label: 'CPU', color: '#277cf7' }, { key: 'mem', label: '内存', color: '#c96a12' }, { key: 'disk', label: '磁盘', color: '#0f9f75' }];

function Card({ title, subtitle, extra, className = '', children }: { title: string; subtitle?: string; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{extra}</div>{children}</section>;
}
function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="kv-row"><dt>{label}</dt><dd>{children}</dd></div>;

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

export default function Workers() {
  const { api } = useAuth(); const paging = usePagination();
  const highlight = paging.params.get('highlight');
  const resource = useResource(`workers:${paging.cursor}`, signal => api.workers(paging.cursor, 20, signal));
  const [selected, setSelected] = useState<string>();
  const real = resource.data?.items ?? [];
  const servers = serversOf(real);
  const current = selected ?? highlight ?? real[0]?.worker_id;
  const running = real.reduce((sum, w) => sum + w.running_plan_ids.length, 0);
  return <div className="dashboard discover workers-page">
    <header className="dashboard-heading">
      <div><h1>Worker 管理</h1><p>采集 Worker 与所在服务器：心跳、接单、运行任务与资源负载</p>{resource.updatedAt ? <span className="data-freshness"><i/>心跳已同步 · {time(resource.updatedAt)}</span> : null}</div>
    </header>

    <div className="discover-kpis">
      <Kpi label="服务器" tone="blue" icon={<Server size={22}/>} value={resource.data ? servers.length : undefined} foot={resource.data ? `在线 ${servers.filter(s => s.online > 0).length} · 按 Worker 登记` : '—'}/>
      <Kpi label="Worker" tone="green" icon={<Bot size={22}/>} value={resource.data ? real.length : undefined} foot={resource.data ? `接单中 ${real.filter(w => w.accepting_work && !w.stale).length} · 失联 ${real.filter(w => w.stale).length}` : '—'}/>
      <Kpi label="运行中任务" tone="blue" icon={<Activity size={22}/>} value={resource.data ? running : undefined} foot="按 Worker 心跳上报的计划数"/>
      <Kpi label="资源使用率" tone="amber" icon={<Cpu size={22}/>} foot={NO_METRICS}/>
    </div>

    <div className="discover-row row-workers">
      <section className="panel worker-list">
        <div className="status-tabs" role="tablist"><button role="tab" aria-selected="true" className="on">Worker<span>{resource.data ? real.length : '—'}</span></button><button role="tab" aria-selected="false" disabled title="服务器列表见下方">服务器<span>{resource.data ? servers.length : '—'}</span></button><button role="tab" aria-selected="false" disabled title="运行任务请在采集任务页查看">运行任务<span>{resource.data ? running : '—'}</span></button></div>
        <div className="list-tools worker-filters"><label className="list-search" htmlFor="worker-search"><Search size={13}/><input id="worker-search" placeholder="搜索 Worker / 服务器…" disabled/></label>{['全部状态', '全部服务器', '全部类型'].map(label => <select key={label} aria-label={label} disabled><option>{label}</option></select>)}</div>
        <ResourceView resource={resource}>{page => <>{highlight && !page.items.some(w => w.worker_id === highlight) && <div className="notice">当前页未包含 Worker <code>{highlight}</code>，可继续翻页查看。</div>}
            {page.items.length ? <div className="table-scroll"><table><thead><tr><th>Worker</th><th>心跳</th><th>接单</th><th>服务器</th><th>版本</th><th className="num">容量</th><th className="num">运行计划</th><th>最后心跳</th><th>代理</th><th>CPU / 内存</th></tr></thead>
              <tbody>{page.items.map(w => <tr key={w.worker_id} className={`${w.worker_id === current ? 'selected' : ''} ${w.worker_id === highlight ? 'highlight-row' : ''}`} onClick={() => setSelected(w.worker_id)} aria-selected={w.worker_id === current}>
                <td className="mono query-term">{w.worker_id}</td><td><span className={`status-chip ${w.stale ? 'red' : 'green'}`}><i/>{w.stale ? '心跳失联' : '心跳正常'}</span></td><td>{w.accepting_work ? '上报接单中' : '上报停止接单'}</td>
                <td className="mono">{w.server_id}</td><td className="mono">{w.build_version}</td><td className="num">{w.capacity}</td><td className="num">{w.running_plan_ids.length}</td><td>{time(w.last_heartbeat_at)}</td>
                <td><span className="cell-title">未配置</span><small className="cell-sub">节点代理管理尚未部署</small></td><td className="text-muted" title={NO_METRICS}>—</td>
              </tr>)}</tbody></table></div> : <Empty title="尚无登记的 Worker">等待执行节点注册并上报心跳。</Empty>}
            <Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/></>}</ResourceView>
      </section>
      {<RealDetail worker={real.find(w => w.worker_id === current)}/>}
    </div>

    <div className="discover-row row-servers">
      <Card title="服务器" subtitle="按 Worker 心跳登记的服务器" className="span-2">
        {servers.length ? <div className="table-scroll"><table><thead><tr><th>服务器</th><th className="num">Worker</th><th className="num">在线</th><th className="num">运行计划</th><th>CPU / 内存 / 磁盘</th></tr></thead><tbody>{servers.map(s => <tr key={s.name}><td className="mono query-term">{s.name}</td><td className="num">{s.workers}</td><td className={`num ${s.online < s.workers ? 'text-red' : 'text-green'}`}>{s.online}</td><td className="num">{s.running}</td><td className="text-muted" title={NO_METRICS}>—</td></tr>)}</tbody></table></div>
          : <Empty title="暂无服务器">{resource.loading ? '正在查询…' : '等待 Worker 登记'}</Empty>}
      </Card>
      <Card title="任务执行趋势" subtitle="近 24 小时，每小时完成的任务" >
        <LineChart points={undefined} series={[{ key: 'ok', label: '成功', color: OK, area: true }, { key: 'failed', label: '失败', color: FAIL }]} empty="任务趋势尚未接入" label="近 24 小时每小时完成的任务"/>
      </Card>
      <Card title="资源使用率" subtitle="全部服务器平均" >
        <LineChart points={undefined} series={RESOURCE_SERIES} max={100} format={v => `${v}%`} empty={NO_METRICS} label="全部服务器平均资源使用率"/>
      </Card>
    </div>
    <footer className="dashboard-foot"><span>Worker 状态以心跳为准，失联由服务端判定；重启、下线等部署操作请在运维工具中进行。</span><span>资源指标接入 Prometheus 后显示</span></footer>
  </div>;
}
