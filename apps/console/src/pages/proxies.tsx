import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Download, Globe, Layers, MoreHorizontal, Plus, Radar, Search, ShieldCheck, Snowflake, Trash2, TriangleAlert, Upload } from 'lucide-react';
import type { ProxyImport, ProxyOverview } from '@crawlsystem/contracts';
import { ApiFailure } from '../api.js';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty, ErrorBox } from '../ui.js';
import Donut from '../components/donut.js';
import LineChart from '../components/line-chart.js';
import type { IpState, ProxiesView } from './proxies-sample.js';
import './overview.css';
import './discover.css';
import './proxies.css';

const NOT_CONNECTED = '该功能尚未接入';
// Same five states as the overview's IP panel.
const stateMeta: Record<IpState, { label: string; tone: string; color: string }> = {
  healthy: { label: '正常', tone: 'green', color: '#11c38c' }, degraded: { label: '降级', tone: 'amber', color: '#ffad21' }, cooldown: { label: '冷却中', tone: 'blue', color: '#3d88ff' },
  failed: { label: '异常', tone: 'red', color: '#ff6868' }, disabled: { label: '已停用', tone: 'slate', color: '#8398b4' },
  // Proxy Control states beyond the design: not bound to a server yet, or no fresh report from its server.
  unassigned: { label: '未绑定', tone: 'slate', color: '#b6c2d3' }, unknown: { label: '未上报', tone: 'slate', color: '#cfd8e4' },
};
const palette = ['#11c38c', '#277cf7', '#c05cf0', '#ffad21', '#21b9e0', '#ff6868', '#8398b4'];
const rate = (requests: number, failures: number) => requests ? `${((1 - failures / requests) * 100).toFixed(1)}%` : '—';
const ago = (at: string) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000)); return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`; };
/** Real inventory into the page's view model. Figures are today's (UTC) node-reported counters. */
function fromOverview(o: ProxyOverview): ProxiesView {
  const total = o.items.length, healthy = o.by_state.healthy;
  return { kpis: { total, totalDelta: '', providers: o.providers.length, groups: o.groups.length, healthy, healthyRate: total ? `${(healthy / total * 100).toFixed(1)}%` : '—',
      cooldown: o.by_state.cooldown, failed: o.by_state.failed, requests: fmt(o.requests_today), requestsDelta: '' },
    ips: o.items.map(p => ({ id: p.proxy_id, ip: p.host, port: p.port, region: p.country_code ?? '—', provider: p.provider, group: p.group, state: p.state,
      success: rate(p.requests_today, p.failures_today), latency: p.latency_ms === null ? '—' : `${p.latency_ms} ms`, requests: p.requests_today,
      checked: p.observed_at ? ago(p.observed_at) : '—', node: p.server_id ?? '—', server: p.server_id, enabled: p.enabled, version: p.version })),
    states: (Object.keys(stateMeta) as IpState[]).map(state => ({ state, count: o.by_state[state] })),
    providers: o.providers.map(p => ({ name: p.name, count: p.count })),
    groups: o.groups.map((g, i) => ({ name: g.name, count: g.count, color: palette[i % palette.length]! })),
    providerStats: o.providers.map(p => ({ name: p.name, ips: p.count, availability: rate(p.requests_today, p.failures_today), requests: fmt(p.requests_today) })),
    trend: o.availability_7d.filter(d => d.requests > 0).map(d => ({ day: d.day.slice(5), value: Math.round((1 - d.failures / d.requests) * 1000) / 10 })) };
}
/** One endpoint per line: scheme://[user:password@]host:port. Passwords stay in this form and the request body only. */
export function parseProxyLines(text: string, common: Omit<ProxyImport['entries'][number], 'protocol' | 'host' | 'port' | 'username' | 'password'>): ProxyImport['entries'] {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
    let url: URL;
    try { url = new URL(line); } catch { throw new Error(`第 ${index + 1} 行不是有效地址`); }
    const protocol = url.protocol.replace(':', '');
    if (!['http', 'https', 'socks5'].includes(protocol) || !url.port) throw new Error(`第 ${index + 1} 行需要 http/https/socks5 协议和端口`);
    return { ...common, protocol: protocol as 'http', host: url.hostname, port: Number(url.port),
      username: url.username ? decodeURIComponent(url.username) : null, password: url.password ? decodeURIComponent(url.password) : null };
  });
}
function ImportPanel({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const { api } = useAuth();
  const [text, setText] = useState(''), [provider, setProvider] = useState(''), [group, setGroup] = useState(''), [country, setCountry] = useState(''), [concurrency, setConcurrency] = useState(2), [kind, setKind] = useState<'static' | 'rotating'>('static');
  const [busy, setBusy] = useState(false), [error, setError] = useState<ApiFailure>(), [result, setResult] = useState<string>();
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined); setResult(undefined);
    let entries: ProxyImport['entries'];
    try { entries = parseProxyLines(text, { provider: provider.trim(), group: group.trim(), country_code: country.trim().toUpperCase() || null, kind, max_concurrency: concurrency }); }
    catch (cause) { setError(new ApiFailure((cause as Error).message, 400, 'INVALID_REQUEST')); return; }
    if (!entries.length) { setError(new ApiFailure('请至少填写一行代理地址', 400, 'INVALID_REQUEST')); return; }
    setBusy(true);
    try { const r = await api.importProxies({ entries }); setText(''); setResult(`已导入：新增 ${r.created} 个，更新 ${r.updated} 个。新 IP 需绑定服务器后才会被使用。`); onDone(); }
    catch (cause) { setError(cause instanceof ApiFailure ? cause : new ApiFailure('导入失败，请核对后重试')); }
    finally { setBusy(false); }
  }
  return <section className="panel proxy-import"><div className="panel-heading"><div><h2>导入代理 IP</h2><p>每行一个：协议://用户名:密码@地址:端口。密码只加密保存在后端，页面不会再显示。</p></div><button className="button small" onClick={onClose}>关闭</button></div>
    <form onSubmit={submit}><textarea aria-label="代理地址列表" rows={5} value={text} onChange={e => setText(e.target.value)} placeholder={'http://user:pass@198.51.100.10:8080\nsocks5://user:pass@203.0.113.5:1080'} disabled={busy}/>
      <div className="proxy-import-fields">
        <label>服务商<input aria-label="服务商" required value={provider} onChange={e => setProvider(e.target.value)} disabled={busy}/></label>
        <label>分组<input aria-label="分组" required value={group} onChange={e => setGroup(e.target.value)} disabled={busy}/></label>
        <label>国家代码<input aria-label="国家代码" maxLength={2} placeholder="US" value={country} onChange={e => setCountry(e.target.value)} disabled={busy}/></label>
        <label>类型<select aria-label="类型" value={kind} onChange={e => setKind(e.target.value as 'static')} disabled={busy}><option value="static">固定出口</option><option value="rotating">轮换端点</option></select></label>
        <label>单 IP 并发<input aria-label="单 IP 并发" type="number" min={1} max={64} value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} disabled={busy}/></label>
      </div>
      {error && <ErrorBox error={error}/>}{result && <div className="notice" role="status">{result}</div>}
      <button className="button primary" disabled={busy}><Upload size={14}/>{busy ? '正在导入…' : '导入'}</button></form></section>;
}
function RowActions({ ip, servers, onDone }: { ip: ProxiesView['ips'][number]; servers: string[]; onDone: () => void }) {
  const { api } = useAuth();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  async function update(change: { enabled?: boolean; server_id?: string | null }) {
    setBusy(true); setError(undefined);
    try { await api.updateProxy(ip.id!, { expected_version: ip.version!, ...change }); onDone(); }
    catch (cause) { setError(cause instanceof ApiFailure ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  }
  return <span className="proxy-actions"><select aria-label={`绑定服务器 ${ip.ip}:${ip.port}`} value={ip.server ?? ''} disabled={busy} onChange={e => void update({ server_id: e.target.value || null })}>
      <option value="">未绑定</option>{[...new Set([...servers, ...(ip.server ? [ip.server] : [])])].sort().map(s => <option key={s} value={s}>{s}</option>)}</select>
    <button className="text-button" disabled={busy} onClick={() => void update({ enabled: !ip.enabled })}>{ip.enabled ? '停用' : '启用'}</button>{error && <small className="text-red" role="alert">{error}</small>}</span>;
}
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
  const { api, session } = useAuth();
  const operator = session.role === 'operator';
  const overview = useResource('proxies', signal => api.proxies(signal), true, 15_000);
  const [importing, setImporting] = useState(false), [query, setQuery] = useState(''), [stateFilter, setStateFilter] = useState('');
  // Real fact today: registered Workers report their proxy status (fixture runs use none).
  const workers = useResource('proxies-workers', signal => api.workers('0', 20, signal), true, 15_000);
  const unconfigured = workers.data?.items.filter(w => w.proxy_status === 'NOT_CONFIGURED').length;
  const [sampleOn, setSampleOn] = useState(false);
  const [sample, setData] = useState<ProxiesView>();
  const real = useMemo(() => overview.data && fromOverview(overview.data), [overview.data]);
  const data = sample ?? real;
  // Candidate servers for binding: nodes that already run Workers, plus current bindings.
  const servers = [...new Set(workers.data?.items.map(w => w.server_id) ?? [])];
  const ips = data?.ips.filter(ip => (!stateFilter || ip.state === stateFilter) && (!query || `${ip.ip} ${ip.group} ${ip.provider}`.toLowerCase().includes(query.trim().toLowerCase())));
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
        {sample ? <span className="data-freshness failing"><i/>示例数据</span> : overview.data ? <span className="data-freshness" title="代理库存与节点上报的当前状态"><i/>代理库存已同步 · {fmt(overview.data.items.length)} 个 IP{unconfigured ? ` · ${unconfigured} 个 Worker 尚未使用代理` : ''}</span> : null}
      </div>
      <div className="dashboard-period"><label className="sample-switch" htmlFor="proxies-sample"><input id="proxies-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label>
        <button className="button small primary" disabled={!operator || !!sample} title={operator ? undefined : '只读身份不能导入'} onClick={() => setImporting(true)}><Plus size={13}/>添加 IP</button></div>
    </header>
    {overview.error && !sample && <ErrorBox error={overview.error}/>}
    {importing && operator && !sample && <ImportPanel onDone={overview.refresh} onClose={() => setImporting(false)}/>}
    {sample && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据：服务商为匿名，IP 取自文档示例地址段，不指向真实主机。代理凭据不在控制台展示。</div>}

    <div className="discover-kpis">
      <Kpi label="IP 总数" tone="blue" icon={<Globe size={22}/>} value={k && fmt(k.total)} foot={k ? `${k.providers} 家服务商 · ${k.groups} 个分组` : NOT_CONNECTED}/>
      <Kpi label="正常可用" tone="green" icon={<ShieldCheck size={22}/>} value={k && fmt(k.healthy)} foot={k ? `可用率 ${k.healthyRate}` : NOT_CONNECTED}/>
      <Kpi label="冷却 / 异常" tone="red" icon={<Snowflake size={22}/>} value={k && `${fmt(k.cooldown)} / ${fmt(k.failed)}`} foot={k ? '限流后冷却，到期自动恢复' : NOT_CONNECTED}/>
      <Kpi label="今日请求量" tone="blue" icon={<Layers size={22}/>} value={k?.requests} foot={k ? `较昨日 ${k.requestsDelta}` : NOT_CONNECTED}/>
    </div>

    <div className="discover-row row-ips">
      <section className="panel ip-list">
        <div className="status-tabs" role="tablist">{tabs.map((t, i) => <button key={t} role="tab" aria-selected={i === 0} className={i === 0 ? 'on' : ''} disabled={i !== 0} title={i === 0 ? undefined : NOT_CONNECTED}>{t}</button>)}</div>
        <div className="list-tools ip-filters"><label className="list-search" htmlFor="ip-search"><Search size={13}/><input id="ip-search" placeholder="搜索 IP、分组、服务商…" value={query} onChange={e => setQuery(e.target.value)} disabled={!data}/></label>
          <select aria-label="全部状态" value={stateFilter} onChange={e => setStateFilter(e.target.value)} disabled={!data}><option value="">全部状态</option>{(Object.keys(stateMeta) as IpState[]).map(s => <option key={s} value={s}>{stateMeta[s].label}</option>)}</select></div>
        {data && data.ips.length ? <div className="table-scroll"><table><thead><tr><th>IP 地址</th><th className="num">端口</th><th>地区</th><th>服务商</th><th>分组</th><th>状态</th><th className="num">成功率</th><th className="num">响应时间</th><th className="num">今日请求</th><th>绑定节点</th><th>最后检测</th><th>操作</th></tr></thead>
          <tbody>{ips!.map(ip => { const m = stateMeta[ip.state]; return <tr key={ip.id ?? `${ip.ip}:${ip.port}`}><td className="mono query-term">{ip.ip}</td><td className="num">{ip.port}</td><td>{ip.region}</td><td>{ip.provider}</td><td><span className="keyword-chip">{ip.group}</span></td>
            <td><span className={`status-chip ${m.tone}`}><i/>{m.label}</span></td><td className={`num ${ip.state === 'failed' ? 'text-red' : ''}`}>{ip.success}</td><td className="num">{ip.latency}</td><td className="num">{ip.requests ? fmt(ip.requests) : '—'}</td><td className="mono">{ip.node}</td><td>{ip.checked}</td><td className="row-actions">{ip.id && operator ? <RowActions ip={ip} servers={servers} onDone={overview.refresh}/> : <><span title={NOT_CONNECTED}>检测</span><MoreHorizontal size={14}/></>}</td></tr>; })}</tbody></table></div>
          : <Empty title="尚无代理 IP">{operator ? '点击“添加 IP”导入代理。导入后绑定到服务器，由该节点的本地代理管理按并发与冷却使用。' : '尚未导入代理。'}</Empty>}
        <footer className="pager">{data ? <span>共 {fmt(data.kpis.total)} 条{sample ? '（示例）' : ips && ips.length !== data.ips.length ? `，筛选后 ${fmt(ips.length)} 条` : ''}</span> : <span>—</span>}</footer>
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
        <div className="quick-actions">{([['批量检测', <Radar size={18}/>], ['清理异常 IP', <Trash2 size={18}/>], ['导入 IP', <Upload size={18}/>], ['导出列表', <Download size={18}/>]] as const).map(([label, icon]) => label === '导入 IP'
          ? <button key={label} className="quick-action" disabled={!operator || !!sample} onClick={() => setImporting(true)}>{icon}<span>{label}</span></button>
          : <button key={label} className="quick-action" disabled title={NOT_CONNECTED}>{icon}<span>{label}</span></button>)}</div>
      </Card>
    </div>
    <footer className="dashboard-foot"><span>代理资源由中心统一分组与分配，节点本地执行；冷却中的 IP 到期自动恢复，不计为异常。</span><span>“预览示例数据”仅用于查看页面设计</span></footer>
  </div>;
}
