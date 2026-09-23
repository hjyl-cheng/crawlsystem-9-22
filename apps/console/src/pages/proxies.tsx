import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Download, Globe, Layers, MoreHorizontal, Plus, Radar, Search, ShieldCheck, Snowflake, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty } from '../ui.js';
import Donut from '../components/donut.js';
import LineChart from '../components/line-chart.js';
import type { IpState, ProxiesView } from './proxies-sample.js';
import './overview.css';
import './discover.css';
import './proxies.css';

const NOT_CONNECTED = '代理资源尚未接入';
// Same five states as the overview's IP panel.
const stateMeta: Record<IpState, { label: string; tone: string; color: string }> = {
  healthy: { label: '正常', tone: 'green', color: '#11c38c' }, degraded: { label: '降级', tone: 'amber', color: '#ffad21' }, cooldown: { label: '冷却中', tone: 'blue', color: '#3d88ff' },
  failed: { label: '异常', tone: 'red', color: '#ff6868' }, disabled: { label: '已停用', tone: 'slate', color: '#8398b4' },
};
const tabs = ['IP 列表', 'IP 分组', '服务商', '服务器绑定'] as const;
const fmt = (n: number) => n.toLocaleString('zh-CN');

function Card({ title, subtitle, extra, className = '', children }: { title: string; subtitle?: string; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{extra}</div>{children}</section>;
}
const Unavailable = ({ children = '查看全部' }: { children?: string }) => <span className="dashboard-unavailable" title={NOT_CONNECTED}>{children}<ArrowRight size={12}/></span>;
function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}

export default function Proxies() {
  const { api } = useAuth();
  // Real fact today: registered Workers report their proxy status (fixture runs use none).
  const workers = useResource('proxies-workers', signal => api.workers('0', 20, signal), true, 15_000);
  const unconfigured = workers.data?.items.filter(w => w.proxy_status === 'NOT_CONFIGURED').length;
  const [sampleOn, setSampleOn] = useState(false);
  const [data, setData] = useState<ProxiesView>();
  // The sample module loads only when asked for, so it never ships with the default view.
  useEffect(() => {
    if (!sampleOn) { setData(undefined); return; }
    let live = true;
    void import('./proxies-sample.js').then(module => { if (live) setData(module.proxiesSample); });
    return () => { live = false; };
  }, [sampleOn]);
  const k = data?.kpis;
  const stateTotal = data?.states.reduce((s, x) => s + x.count, 0) ?? 0, providerMax = Math.max(1, ...(data?.providers.map(p => p.count) ?? [1]));
  const providerTotal = data?.providers.reduce((s, p) => s + p.count, 0) ?? 0, groupTotal = data?.groups.reduce((s, g) => s + g.count, 0) ?? 0;
  return <div className="dashboard discover proxies-page">
    <header className="dashboard-heading">
      <div><h1>IP 资源管理</h1><p>统一管理代理 IP、分组、服务商与服务器绑定，监控可用性与冷却</p>
        {data ? <span className="data-freshness failing"><i/>示例数据</span> : <span className="data-freshness failing" title="来自 Worker 心跳上报的代理状态"><i/>{NOT_CONNECTED}{unconfigured !== undefined ? ` · ${unconfigured} 个 Worker 未配置代理（固定样本不使用代理）` : ''}</span>}
      </div>
      <div className="dashboard-period"><label className="sample-switch" htmlFor="proxies-sample"><input id="proxies-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label>
        <button className="button small" disabled title={NOT_CONNECTED}><Plus size={13}/>新建分组</button><button className="button small primary" disabled title={NOT_CONNECTED}><Plus size={13}/>添加 IP</button></div>
    </header>
    {data && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据：服务商为匿名，IP 取自文档示例地址段，不指向真实主机。代理凭据不在控制台展示。</div>}

    <div className="discover-kpis">
      <Kpi label="IP 总数" tone="blue" icon={<Globe size={22}/>} value={k && fmt(k.total)} foot={k ? `${k.providers} 家服务商 · ${k.groups} 个分组` : NOT_CONNECTED}/>
      <Kpi label="正常可用" tone="green" icon={<ShieldCheck size={22}/>} value={k && fmt(k.healthy)} foot={k ? `可用率 ${k.healthyRate}` : NOT_CONNECTED}/>
      <Kpi label="冷却 / 异常" tone="red" icon={<Snowflake size={22}/>} value={k && `${fmt(k.cooldown)} / ${fmt(k.failed)}`} foot={k ? '限流后冷却，到期自动恢复' : NOT_CONNECTED}/>
      <Kpi label="今日请求量" tone="blue" icon={<Layers size={22}/>} value={k?.requests} foot={k ? `较昨日 ${k.requestsDelta}` : NOT_CONNECTED}/>
    </div>

    <div className="discover-row row-ips">
      <section className="panel ip-list">
        <div className="status-tabs" role="tablist">{tabs.map((t, i) => <button key={t} role="tab" aria-selected={i === 0} className={i === 0 ? 'on' : ''} disabled={i !== 0} title={i === 0 ? undefined : NOT_CONNECTED}>{t}</button>)}</div>
        <div className="list-tools ip-filters"><label className="list-search" htmlFor="ip-search"><Search size={13}/><input id="ip-search" placeholder="搜索 IP、分组、服务商…" disabled/></label>
          {['全部状态', '全部分组', '全部服务商', '全部地区'].map(label => <select key={label} aria-label={label} disabled><option>{label}</option></select>)}</div>
        {data ? <div className="table-scroll"><table><thead><tr><th>IP 地址</th><th className="num">端口</th><th>地区</th><th>服务商</th><th>分组</th><th>状态</th><th className="num">成功率</th><th className="num">响应时间</th><th className="num">今日请求</th><th>绑定节点</th><th>最后检测</th><th>操作</th></tr></thead>
          <tbody>{data.ips.map(ip => { const m = stateMeta[ip.state]; return <tr key={ip.ip}><td className="mono query-term">{ip.ip}</td><td className="num">{ip.port}</td><td>{ip.region}</td><td>{ip.provider}</td><td><span className="keyword-chip">{ip.group}</span></td>
            <td><span className={`status-chip ${m.tone}`}><i/>{m.label}</span></td><td className={`num ${ip.state === 'failed' ? 'text-red' : ''}`}>{ip.success}</td><td className="num">{ip.latency}</td><td className="num">{ip.requests ? fmt(ip.requests) : '—'}</td><td className="mono">{ip.node}</td><td>{ip.checked}</td><td className="row-actions"><span title={NOT_CONNECTED}>检测</span><MoreHorizontal size={14}/></td></tr>; })}</tbody></table></div>
          : <Empty title="尚无代理 IP">代理资源管理尚未接入。当前固定样本联调不使用代理；接入后在此管理 IP、分组、服务商与服务器绑定。</Empty>}
        <footer className="pager">{data ? <span>共 {fmt(data.kpis.total)} 条（示例）</span> : <span>—</span>}</footer>
      </section>
      <div className="side-stack">
        <Card title="状态分布" className="natural">
          {data ? <div className="source-body"><Donut parts={data.states.filter(s => s.count > 0).map(s => ({ label: stateMeta[s.state].label, count: s.count, color: stateMeta[s.state].color }))} caption="IP 总数" label="IP 状态分布"/><div className="legend">{data.states.map(s => <div key={s.state}><i style={{ background: stateMeta[s.state].color }}/><span>{stateMeta[s.state].label}</span><b>{(s.count / stateTotal * 100).toFixed(1)}%</b><small>{fmt(s.count)}</small></div>)}</div></div> : <Empty title="暂无 IP">{NOT_CONNECTED}</Empty>}
        </Card>
        <Card title="服务商分布">
          {data ? <div className="provider-bars">{data.providers.map(p => <div key={p.name}><span>{p.name}</span><div className="dim-bar"><i style={{ width: `${p.count / providerMax * 100}%` }}/></div><b>{fmt(p.count)}</b><small>{(p.count / providerTotal * 100).toFixed(1)}%</small></div>)}</div> : <Empty title="暂无服务商">{NOT_CONNECTED}</Empty>}
        </Card>
      </div>
    </div>

    <div className="discover-row row-ip-overview">
      <Card title="分组概览" subtitle={data ? `共 ${data.kpis.groups} 个分组` : undefined} extra={<Unavailable/>}>
        {data ? <div className="group-list">{data.groups.map(g => <div key={g.name}><i style={{ background: g.color }}/><span>{g.name}</span><b>{fmt(g.count)}</b><small>{(g.count / groupTotal * 100).toFixed(1)}%</small></div>)}</div> : <Empty title="暂无分组">{NOT_CONNECTED}</Empty>}
      </Card>
      <Card title="服务商概览" subtitle={data ? `共 ${data.kpis.providers} 家服务商` : undefined} extra={<Unavailable/>}>
        {data ? <div className="table-scroll"><table><thead><tr><th>服务商</th><th className="num">IP 数</th><th className="num">可用率</th><th className="num">今日请求</th></tr></thead><tbody>{data.providerStats.map(p => <tr key={p.name}><td>{p.name}</td><td className="num">{fmt(p.ips)}</td><td className="num text-green">{p.availability}</td><td className="num">{p.requests}</td></tr>)}</tbody></table></div> : <Empty title="暂无服务商">{NOT_CONNECTED}</Empty>}
      </Card>
      <Card title="近 7 天整体可用率">
        <LineChart points={data?.trend.map(t => ({ x: t.day, values: { rate: t.value } }))} series={[{ key: 'rate', label: '可用率', color: '#277cf7', area: true }]} max={100} format={v => `${v % 1 ? v.toFixed(1) : v}%`} empty="可用率趋势尚未接入" label="近 7 天整体可用率"/>
      </Card>
      <Card title="常用操作">
        <div className="quick-actions">{([['批量检测', <Radar size={18}/>], ['清理异常 IP', <Trash2 size={18}/>], ['导入 IP', <Upload size={18}/>], ['导出列表', <Download size={18}/>]] as const).map(([label, icon]) => <button key={label} className="quick-action" disabled title={NOT_CONNECTED}>{icon}<span>{label}</span></button>)}</div>
      </Card>
    </div>
    <footer className="dashboard-foot"><span>代理资源由中心统一分组与分配，节点本地执行；冷却中的 IP 到期自动恢复，不计为异常。</span><span>“预览示例数据”仅用于查看页面设计</span></footer>
  </div>;
}
