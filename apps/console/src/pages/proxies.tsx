import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Download, Globe, Layers, MoreHorizontal, Plus, Radar, RefreshCw, Rss, Search, ShieldCheck, Snowflake, Trash2, Upload } from 'lucide-react';
import type { ProxyImport, ProxyOverview, ProxyRetireReason, ProxySourceView, ProxyState } from '@crawlsystem/contracts';
import { ApiFailure } from '../api.js';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty, ErrorBox, Modal } from '../ui.js';
import Donut from '../components/donut.js';
import LineChart from '../components/line-chart.js';
import './overview.css';
import './discover.css';
import './proxies.css';

const NOT_CONNECTED = '该功能尚未接入';
type IpState = ProxyState;
interface ProxiesView {
  kpis: { total: number; providers: number; groups: number; healthy: number; healthyRate: string; cooldown: number; failed: number; requests: string };
  ips: { id: string; ip: string; port: number; region: string; regionTone: string; regionHint: string; country: string | null; provider: string; group: string; state: IpState; success: string; latency: string; requests: number; checked: string; node: string; server: string | null; enabled: boolean; version: number; retired: ProxyRetireReason | null; insecure: boolean }[];
  states: { state: IpState; count: number }[];
  providers: { name: string; count: number }[];
  groups: { name: string; count: number; color: string }[];
  providerStats: { name: string; ips: number; availability: string; requests: string }[];
  countries: { code: string | null; label: string; count: number }[];
  trend: { day: string; value: number }[];
}
// Same five states as the overview's IP panel.
const stateMeta: Record<IpState, { label: string; tone: string; color: string }> = {
  healthy: { label: '正常', tone: 'green', color: '#11c38c' }, trial: { label: '试用中', tone: 'blue', color: '#21b9e0' }, degraded: { label: '降级', tone: 'amber', color: '#ffad21' }, cooldown: { label: '冷却中', tone: 'blue', color: '#3d88ff' },
  failed: { label: '异常', tone: 'red', color: '#ff6868' }, disabled: { label: '已停用', tone: 'slate', color: '#8398b4' },
  // Proxy Control states beyond the design: not bound to a server yet, or no fresh report from its server.
  unassigned: { label: '未绑定', tone: 'slate', color: '#b6c2d3' }, unknown: { label: '未上报', tone: 'slate', color: '#cfd8e4' },
};
const retiredNote: Record<ProxyRetireReason, string> = { unhealthy: '在绑定的服务器上反复失败，已自动下线；来自订阅的代理 24 小时后可重新试用', source_missing: '订阅列表中已不再出现，重新出现时自动恢复' };
const palette = ['#11c38c', '#277cf7', '#c05cf0', '#ffad21', '#21b9e0', '#ff6868', '#8398b4'];
const rate = (requests: number, failures: number) => requests ? `${((1 - failures / requests) * 100).toFixed(1)}%` : '—';
const ago = (at: string) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000)); return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`; };
/** Real inventory into the page's view model. Figures are today's (UTC) node-reported counters. */
function fromOverview(o: ProxyOverview): ProxiesView {
  const total = o.items_total, healthy = o.by_state.healthy;
  return { kpis: { total, providers: o.providers.length, groups: o.groups.length, healthy, healthyRate: total ? `${(healthy / total * 100).toFixed(1)}%` : '—',
      cooldown: o.by_state.cooldown, failed: o.by_state.failed, requests: fmt(o.requests_today) },
    ips: o.items.map(p => ({ id: p.proxy_id, ip: p.host, port: p.port, ...exitRegion(p), country: p.exit_country, provider: p.provider, group: p.group, state: p.state,
      success: rate(p.requests_today, p.failures_today), latency: p.latency_ms === null ? '—' : `${p.latency_ms} ms`, requests: p.requests_today,
      checked: p.observed_at ? ago(p.observed_at) : '—', node: p.server_id ?? '—', server: p.server_id, enabled: p.enabled, version: p.version, retired: p.retire_reason, insecure: p.tls_insecure })),
    states: (Object.keys(stateMeta) as IpState[]).map(state => ({ state, count: o.by_state[state] })),
    providers: o.providers.map(p => ({ name: p.name, count: p.count })),
    groups: o.groups.map((g, i) => ({ name: g.name, count: g.count, color: palette[i % palette.length]! })),
    providerStats: o.providers.map(p => ({ name: p.name, ips: p.count, availability: rate(p.requests_today, p.failures_today), requests: fmt(p.requests_today) })),
    trend: o.availability_7d.filter(d => d.requests > 0).map(d => ({ day: d.day.slice(5), value: Math.round((1 - d.failures / d.requests) * 1000) / 10 })),
    countries: o.exit_countries.map(c => ({ code: c.country, label: c.country ? countryName(c.country) : '未测出', count: c.count })) };
}
const regionNames = (() => { try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }); } catch { return null; } })();
/** "巴西" for BR; the code itself when the browser has no name for it. */
export const countryName = (code: string) => { try { return regionNames?.of(code) ?? code; } catch { return code; } };
const exitErrors: Record<string, string> = { timeout: '超时', network: '网络错误', unrecognised_response: 'YouTube 返回无法识别', proxy_proxy_unreachable: '代理连不上',
  proxy_proxy_refused: '代理拒绝连接', proxy_proxy_auth: '代理认证失败', proxy_timeout: '代理超时', proxy_protocol: '代理协议错误' };
/** The exit country YouTube detected through the proxy (checked after import, rechecked weekly); the declared one only as a hint. */
function exitRegion(p: ProxyOverview['items'][number]) {
  const declared = p.country_code && p.country_code !== p.exit_country ? `；导入时申报 ${p.country_code}` : '';
  if (p.exit_check === 'ok') return { region: `${countryName(p.exit_country!)} ${p.exit_country}`, regionTone: '',
    regionHint: `YouTube 识别的出口国家；出口 IP ${p.exit_ip ?? '未知'}${p.exit_checked_at ? `，${ago(p.exit_checked_at)}检测` : ''}${declared}` };
  if (p.exit_check === 'pending') return { region: '检测中', regionTone: 'muted', regionHint: `导入后自动检测出口国家${declared}` };
  return { region: '检测失败', regionTone: 'text-red', regionHint: `${exitErrors[p.exit_check_error ?? ''] ?? p.exit_check_error ?? '检测失败'}，稍后自动重试${declared}` };
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
function ImportForm({ onDone }: { onDone: () => void }) {
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
  return <form className="proxy-import" onSubmit={submit}><textarea aria-label="代理地址列表" rows={6} value={text} onChange={e => setText(e.target.value)} placeholder={'http://user:pass@198.51.100.10:8080\nsocks5://user:pass@203.0.113.5:1080'} disabled={busy}/>
      <div className="proxy-import-fields">
        <label>服务商<input aria-label="服务商" required value={provider} onChange={e => setProvider(e.target.value)} disabled={busy}/></label>
        <label>分组<input aria-label="分组" required value={group} onChange={e => setGroup(e.target.value)} disabled={busy}/></label>
        <label>申报国家（可不填，导入后自动检测出口国家）<input aria-label="国家代码" maxLength={2} placeholder="可不填" value={country} onChange={e => setCountry(e.target.value)} disabled={busy}/></label>
        <label>类型<select aria-label="类型" value={kind} onChange={e => setKind(e.target.value as 'static')} disabled={busy}><option value="static">固定出口</option><option value="rotating">轮换端点</option></select></label>
        <label>单 IP 并发<input aria-label="单 IP 并发" type="number" min={1} max={64} value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} disabled={busy}/></label>
      </div>
      {error && <ErrorBox error={error}/>}{result && <div className="notice" role="status">{result}</div>}
      <div className="dialog-actions"><button className="button primary" disabled={busy}><Upload size={14}/>{busy ? '正在导入…' : '导入'}</button></div></form>;
}
function SourceForm({ servers, onDone }: { servers: string[]; onDone: () => void }) {
  const { api } = useAuth();
  const [form, setForm] = useState({ name: '', url: '', protocol: 'socks5' as 'http' | 'https' | 'socks5', provider: '', group: '', country: '', interval: 60, misses: 3, concurrency: 2 });
  const [chosen, setChosen] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<ApiFailure>(), [done, setDone] = useState<string>();
  const [insecure, setInsecure] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: ['interval', 'misses', 'concurrency'].includes(key) ? Number(e.target.value) : e.target.value });
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    try {
      const source = await api.createProxySource({ name: form.name.trim(), url: form.url.trim(), protocol: form.protocol, provider: form.provider.trim(), group: form.group.trim(),
        country_code: form.country.trim().toUpperCase() || null, interval_minutes: form.interval, retire_after_misses: form.misses, max_concurrency: form.concurrency, server_ids: chosen, allow_insecure_tls: insecure });
      setDone(`已添加“${source.name}”，后台将在 1 分钟内首次拉取。`); onDone();
    } catch (cause) { setError(cause instanceof ApiFailure ? cause : new ApiFailure('添加失败，请核对后重试')); }
    finally { setBusy(false); }
  }
  return <form className="proxy-import" onSubmit={submit}>
    <div className="proxy-import-fields two">
      <label>名称<input aria-label="来源名称" required value={form.name} onChange={set('name')} disabled={busy}/></label>
      <label>列表地址（HTTPS）<input aria-label="来源地址" required type="url" placeholder="https://…/socks5.txt 或 Clash 订阅" value={form.url} onChange={set('url')} disabled={busy}/></label>
    </div>
    <small className="cell-note">支持每行一个代理的列表，或 Clash 订阅（只取其中不带账号密码的 http / https / socks5 节点）。</small>
    <div className="proxy-import-fields">
      <label>默认协议<select aria-label="默认协议" value={form.protocol} onChange={set('protocol')} disabled={busy}><option value="socks5">socks5</option><option value="http">http</option><option value="https">https</option></select></label>
      <label>服务商<input aria-label="来源服务商" required value={form.provider} onChange={set('provider')} disabled={busy}/></label>
      <label>分组<input aria-label="来源分组" required value={form.group} onChange={set('group')} disabled={busy}/></label>
      <label>申报国家（可不填，自动检测）<input aria-label="来源国家代码" maxLength={2} value={form.country} onChange={set('country')} disabled={busy}/></label>
      <label>单 IP 并发<input aria-label="来源单 IP 并发" type="number" min={1} max={64} value={form.concurrency} onChange={set('concurrency')} disabled={busy}/></label>
      <label>刷新间隔（分钟）<input aria-label="刷新间隔" type="number" min={10} max={1440} value={form.interval} onChange={set('interval')} disabled={busy}/></label>
      <label>连续缺失几次后退役<input aria-label="退役阈值" type="number" min={1} max={20} value={form.misses} onChange={set('misses')} disabled={busy}/></label>
    </div>
    <fieldset className="server-choice" disabled={busy}><legend>新 IP 自动平均分配到（不选则保持未绑定）</legend>
      {servers.length ? servers.map(server => <label key={server} className="checkbox-row"><input type="checkbox" checked={chosen.includes(server)} onChange={e => setChosen(e.target.checked ? [...chosen, server] : chosen.filter(s => s !== server))}/>{server}</label>) : <small>尚无运行 Worker 的服务器</small>}</fieldset>
    <label className="checkbox-row"><input type="checkbox" aria-label="允许跳过代理证书检查" checked={insecure} onChange={e => setInsecure(e.target.checked)} disabled={busy}/>允许跳过代理证书检查（仅限列表标记了 skip-cert-verify、且不带账号密码的 HTTPS 代理；到 YouTube 的加密照常校验）</label>
    {error && <ErrorBox error={error}/>}{done && <div className="notice" role="status">{done}</div>}
    <div className="dialog-actions"><button className="button primary" disabled={busy}><Rss size={14}/>{busy ? '正在添加…' : '添加来源'}</button></div></form>;
}
const sourceStatus = { ok: ['green', '正常'], not_modified: ['blue', '未变化'], error: ['red', '失败'] } as const;
function SourcesTable({ sources, operator, onDone }: { sources: ProxySourceView[]; operator: boolean; onDone: () => void }) {
  const { api } = useAuth();
  const [busy, setBusy] = useState<string>(), [error, setError] = useState<string>();
  async function update(source: ProxySourceView, change: { enabled?: boolean; refresh_now?: true }) {
    setBusy(source.source_id); setError(undefined);
    try { await api.updateProxySource(source.source_id, { expected_version: source.version, ...change }); onDone(); }
    catch (cause) { setError(cause instanceof ApiFailure ? cause.message : '操作失败'); }
    finally { setBusy(undefined); }
  }
  if (!sources.length) return <Empty title="尚无订阅来源">{operator ? '点击“添加来源”订阅一个代理列表链接；后台按间隔自动刷新，新 IP 入库、消失的 IP 自动退役。' : '尚未配置订阅来源。'}</Empty>;
  return <div className="table-scroll">{error && <div className="notice warning" role="alert">{error}</div>}<table><thead><tr><th>来源</th><th>协议 / 分组</th><th>刷新</th><th>最近拉取</th><th className="num">列表条数</th><th className="num">在用 / 退役</th><th>分配到</th><th>操作</th></tr></thead>
    <tbody>{sources.map(source => { const status = source.last_status ? sourceStatus[source.last_status] : undefined; return <tr key={source.source_id}>
      <td><b>{source.name}</b>{!source.enabled && <span className="status-chip slate"><i/>已停用</span>}<small className="cell-note mono" title={source.url}>{source.url.length > 56 ? `${source.url.slice(0, 56)}…` : source.url}</small></td>
      <td>{source.protocol} · <span className="keyword-chip">{source.group}</span></td><td>每 {source.interval_minutes} 分钟</td>
      <td>{status ? <span className={`status-chip ${status[0]}`} title={source.last_error ?? undefined}><i/>{status[1]}</span> : <span className="muted">等待首次拉取</span>}{source.last_fetched_at && <small className="cell-note">{ago(source.last_fetched_at)}{source.last_status === 'ok' ? ` · 新增 ${source.last_added ?? 0} · 退役 ${source.last_retired ?? 0}` : ''}{source.last_error ? ` · ${source.last_error}` : ''}</small>}</td>
      <td className="num">{source.last_count ?? '—'}</td><td className="num">{fmt(source.active_proxies)} / {fmt(source.retired_proxies)}</td><td className="mono">{source.server_ids.join('、') || '—'}</td>
      <td className="row-actions">{operator ? <span className="proxy-actions"><button className="text-button" disabled={busy === source.source_id || !source.enabled} onClick={() => void update(source, { refresh_now: true })}><RefreshCw size={12}/>立即刷新</button>
        <button className="text-button" disabled={busy === source.source_id} onClick={() => void update(source, { enabled: !source.enabled })}>{source.enabled ? '停用' : '启用'}</button></span> : '—'}</td></tr>; })}</tbody></table></div>;
}
function RowActions({ ip, servers, onDone }: { ip: ProxiesView['ips'][number]; servers: string[]; onDone: () => void }) {
  const { api } = useAuth();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  async function remove() {
    setBusy(true); setError(undefined);
    try { await api.deleteProxy(ip.id, ip.version); onDone(); }
    catch (cause) { setError(cause instanceof ApiFailure ? cause.message : '删除失败'); }
    finally { setBusy(false); }
  }
  async function update(change: { enabled?: boolean; server_id?: string | null }) {
    setBusy(true); setError(undefined);
    try { await api.updateProxy(ip.id, { expected_version: ip.version, ...change }); onDone(); }
    catch (cause) { setError(cause instanceof ApiFailure ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  }
  return <span className="proxy-actions"><select aria-label={`绑定服务器 ${ip.ip}:${ip.port}`} value={ip.server ?? ''} disabled={busy} onChange={e => void update({ server_id: e.target.value || null })}>
      <option value="">未绑定</option>{[...new Set([...servers, ...(ip.server ? [ip.server] : [])])].sort().map(s => <option key={s} value={s}>{s}</option>)}</select>
    <button className="text-button" disabled={busy} onClick={() => void update({ enabled: !ip.enabled })}>{ip.enabled ? '停用' : '启用'}</button>
    {!ip.enabled && <button className="text-button text-red" disabled={busy} onClick={() => void remove()}>删除</button>}{error && <small className="text-red" role="alert">{error}</small>}</span>;
}
const tabs = [['ips', 'IP 列表'], ['sources', '订阅来源'], ['groups', 'IP 分组'], ['providers', '服务商']] as const;
type Tab = typeof tabs[number][0];
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
  const [importing, setImporting] = useState(false), [addingSource, setAddingSource] = useState(false), [tab, setTab] = useState<Tab>('ips'), [query, setQuery] = useState(''), [stateFilter, setStateFilter] = useState(''), [countryFilter, setCountryFilter] = useState('');
  const sources = useResource('proxy-sources', signal => api.proxySources(signal), true, 30_000);
  // Real fact today: registered Workers report their proxy status (fixture runs use none).
  const workers = useResource('proxies-workers', signal => api.workers('0', 20, signal), true, 15_000);
  const unconfigured = workers.data?.items.filter(w => w.proxy_status === 'NOT_CONFIGURED').length;
  const data = useMemo(() => overview.data && fromOverview(overview.data), [overview.data]);
  // Candidate servers for binding: nodes that already run Workers, plus current bindings.
  const servers = [...new Set(workers.data?.items.map(w => w.server_id) ?? [])];
  const ips = data?.ips.filter(ip => (!stateFilter || ip.state === stateFilter) && (!countryFilter || (countryFilter === 'none' ? ip.country === null : ip.country === countryFilter)) && (!query || `${ip.ip} ${ip.group} ${ip.provider}`.toLowerCase().includes(query.trim().toLowerCase())));
  const k = data?.kpis;
  const stateTotal = data?.states.reduce((s, x) => s + x.count, 0) ?? 0, providerMax = Math.max(1, ...(data?.providers.map(p => p.count) ?? [1]));
  const providerTotal = data?.providers.reduce((s, p) => s + p.count, 0) ?? 0, groupTotal = data?.groups.reduce((s, g) => s + g.count, 0) ?? 0;
  return <div className="dashboard discover proxies-page">
    <header className="dashboard-heading">
      <div><h1>IP 资源管理</h1><p>统一管理代理 IP、分组、服务商与服务器绑定，监控可用性与冷却</p>
        {overview.data ? <span className="data-freshness" title="代理库存与节点上报的当前状态"><i/>代理库存已同步 · {fmt(overview.data.items.length)} 个 IP{unconfigured ? ` · ${unconfigured} 个 Worker 尚未使用代理` : ''}</span> : null}
      </div>
      <div className="dashboard-period"><button className="button small primary" disabled={!operator} title={operator ? undefined : '只读身份不能导入'} onClick={() => setImporting(true)}><Plus size={13}/>添加 IP</button></div>
    </header>
    {overview.error && <ErrorBox error={overview.error}/>}
    <Modal wide open={addingSource && operator} onOpenChange={setAddingSource} title="添加订阅来源" description="填写一个返回代理列表的 HTTPS 链接（每行 host:port 或 协议://[用户:密码@]host:port）。后台按间隔自动刷新；只允许公网地址。"><SourceForm servers={servers} onDone={() => { sources.refresh(); overview.refresh(); }}/></Modal>
    <Modal wide open={importing && operator} onOpenChange={setImporting} title="导入代理 IP" description="每行一个：协议://用户名:密码@地址:端口。密码只加密保存在后端，页面不会再显示；导入后绑定到服务器才会被使用。"><ImportForm onDone={overview.refresh}/></Modal>

    <div className="discover-kpis">
      <Kpi label="IP 总数" tone="blue" icon={<Globe size={22}/>} value={k && fmt(k.total)} foot={k ? `${k.providers} 家服务商 · ${k.groups} 个分组` : '—'}/>
      <Kpi label="正常可用" tone="green" icon={<ShieldCheck size={22}/>} value={k && fmt(k.healthy)} foot={k ? `可用率 ${k.healthyRate}` : '—'}/>
      <Kpi label="冷却 / 异常" tone="red" icon={<Snowflake size={22}/>} value={k && `${fmt(k.cooldown)} / ${fmt(k.failed)}`} foot={k ? '限流后冷却，到期自动恢复' : '—'}/>
      <Kpi label="今日请求量" tone="blue" icon={<Layers size={22}/>} value={k?.requests} foot={k ? '今日（UTC）节点上报' : '—'}/>
    </div>

    <div className="discover-row row-ips">
      <section className="panel ip-list">
        <div className="status-tabs" role="tablist">{tabs.map(([key, label]) => { const live = key === 'ips' || key === 'sources'; return <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} disabled={!live} title={live ? undefined : NOT_CONNECTED} onClick={() => setTab(key)}>{label}{key === 'sources' && sources.data ? <span>{sources.data.items.length}</span> : null}</button>; })}
          {tab === 'sources' && <button className="button small primary tab-action" disabled={!operator} onClick={() => setAddingSource(true)}><Rss size={13}/>添加来源</button>}</div>
        {tab === 'sources' ? <SourcesTable sources={sources.data?.items ?? []} operator={operator} onDone={() => { sources.refresh(); overview.refresh(); }}/> : <>
        <div className="list-tools ip-filters"><label className="list-search" htmlFor="ip-search"><Search size={13}/><input id="ip-search" placeholder="搜索 IP、分组、服务商…" value={query} onChange={e => setQuery(e.target.value)} disabled={!data}/></label>
          <select aria-label="全部状态" value={stateFilter} onChange={e => setStateFilter(e.target.value)} disabled={!data}><option value="">全部状态</option>{(Object.keys(stateMeta) as IpState[]).map(s => <option key={s} value={s}>{stateMeta[s].label}</option>)}</select>
          <select aria-label="出口国家" value={countryFilter} onChange={e => setCountryFilter(e.target.value)} disabled={!data}><option value="">全部国家</option>{data?.countries.map(c => <option key={c.code ?? 'none'} value={c.code ?? 'none'}>{c.label}（{fmt(c.count)}）</option>)}</select></div>
        {data && data.ips.length ? <div className="table-scroll"><table><thead><tr><th>IP 地址</th><th className="num">端口</th><th>地区</th><th>服务商</th><th>分组</th><th>状态</th><th className="num">成功率</th><th className="num">响应时间</th><th className="num">今日请求</th><th>绑定节点</th><th>最后检测</th><th>操作</th></tr></thead>
          <tbody>{ips!.map(ip => { const m = stateMeta[ip.state]; return <tr key={ip.id ?? `${ip.ip}:${ip.port}`}><td className="mono query-term">{ip.ip}{ip.insecure && <small className="cell-note" title="该 HTTPS 代理自身的证书未校验；不带凭据，经它到 YouTube 的加密照常校验">证书未校验</small>}</td><td className="num">{ip.port}</td><td className={ip.regionTone} title={ip.regionHint}>{ip.region}</td><td>{ip.provider}</td><td><span className="keyword-chip">{ip.group}</span></td>
            <td>{ip.retired ? <span className="status-chip slate" title={retiredNote[ip.retired]}><i/>{ip.retired === 'unhealthy' ? '已淘汰' : '已退役'}</span> : <span className={`status-chip ${m.tone}`}><i/>{m.label}</span>}</td><td className={`num ${ip.state === 'failed' ? 'text-red' : ''}`}>{ip.success}</td><td className="num">{ip.latency}</td><td className="num">{ip.requests ? fmt(ip.requests) : '—'}</td><td className="mono">{ip.node}</td><td>{ip.checked}</td><td className="row-actions">{operator ? <RowActions ip={ip} servers={servers} onDone={overview.refresh}/> : <><span title={NOT_CONNECTED}>检测</span><MoreHorizontal size={14}/></>}</td></tr>; })}</tbody></table></div>
          : <Empty title="尚无代理 IP">{operator ? '点击“添加 IP”导入代理。导入后绑定到服务器，由该节点的本地代理管理按并发与冷却使用。' : '尚未导入代理。'}</Empty>}
        <footer className="pager">{data ? <span>共 {fmt(data.kpis.total)} 条{data.ips.length < data.kpis.total ? `，列表显示前 ${fmt(data.ips.length)} 条（已退役和未绑定排在最后）` : ''}{ips && ips.length !== data.ips.length ? `，筛选后 ${fmt(ips.length)} 条` : ''}</span> : <span>—</span>}</footer></>}
      </section>
      <div className="side-stack">
        <Card title="状态分布" className="natural">
          {data ? <div className="source-body"><Donut parts={data.states.filter(s => s.count > 0).map(s => ({ label: stateMeta[s.state].label, count: s.count, color: stateMeta[s.state].color }))} caption="IP 总数" label="IP 状态分布"/><div className="legend">{data.states.map(s => <div key={s.state}><i style={{ background: stateMeta[s.state].color }}/><span>{stateMeta[s.state].label}</span><b>{(s.count / stateTotal * 100).toFixed(1)}%</b><small>{fmt(s.count)}</small></div>)}</div></div> : <Empty title="暂无 IP">{NOT_CONNECTED}</Empty>}
        </Card>
        <Card title="出口国家" subtitle="YouTube 识别的代理出口国家，导入后自动检测">
          {data?.countries.length ? <div className="provider-bars">{data.countries.slice(0, 8).map(c => <div key={c.code ?? 'none'}><span>{c.label}</span><div className="dim-bar"><i style={{ width: `${c.count / Math.max(1, ...data.countries.map(x => x.count)) * 100}%` }}/></div><b>{fmt(c.count)}</b><small>{(c.count / Math.max(1, data.kpis.total) * 100).toFixed(1)}%</small></div>)}</div> : <Empty title="暂无代理">导入代理后自动检测出口国家。</Empty>}
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
          ? <button key={label} className="quick-action" disabled={!operator} onClick={() => setImporting(true)}>{icon}<span>{label}</span></button>
          : <button key={label} className="quick-action" disabled title={NOT_CONNECTED}>{icon}<span>{label}</span></button>)}</div>
      </Card>
    </div>
    <footer className="dashboard-foot"><span>代理资源由中心统一分组与分配，节点本地执行；冷却中的 IP 到期自动恢复，不计为异常。</span><span>密码只加密保存在后端，页面不展示</span></footer>
  </div>;
}
