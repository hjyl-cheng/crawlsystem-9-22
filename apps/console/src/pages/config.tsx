import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, CircleCheck, Clock, Link2, MoreHorizontal, Plus, RotateCcw, Search, Send, Settings2, TriangleAlert, Upload } from 'lucide-react';
import { Empty } from '../ui.js';
import type { ConfigItem, ConfigState, ConfigView, Risk } from './config-sample.js';
import './overview.css';
import './discover.css';
import './config.css';

const NOT_CONNECTED = '配置中心尚未接入';
const stateMeta: Record<ConfigState, { label: string; tone: string }> = {
  active: { label: '已生效', tone: 'green' }, pending: { label: '待发布', tone: 'amber' }, draft: { label: '草稿', tone: 'blue' }, disabled: { label: '已停用', tone: 'slate' },
};
const riskMeta: Record<Risk, { label: string; tone: string }> = { low: { label: '低', tone: 'green' }, medium: { label: '中', tone: 'amber' }, high: { label: '高', tone: 'red' } };
const resultMeta = { published: { label: '发布成功', tone: 'green' }, pending: { label: '待发布', tone: 'amber' }, draft: { label: '保存草稿', tone: 'blue' } } as const;
const fmt = (n: number) => n.toLocaleString('zh-CN');
const pct = (part: number, total: number) => `${(part / total * 100).toFixed(1)}%`;

function Card({ title, extra, className = '', children }: { title: string; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2></div>{extra}</div>{children}</section>;
}
function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="kv-row"><dt>{label}</dt><dd>{children}</dd></div>;
const StateChip = ({ state }: { state: ConfigState }) => <span className={`status-chip ${stateMeta[state].tone}`}><i/>{stateMeta[state].label}</span>;
const RiskMark = ({ risk }: { risk: Risk }) => <span className={`risk-mark ${riskMeta[risk].tone}`}><i/>{riskMeta[risk].label}</span>;

function Detail({ item }: { item?: ConfigItem }) {
  if (!item) return <section className="panel config-detail"><div className="panel-heading"><div><h2>配置详情</h2></div></div>
    <div className="detail-body"><Empty title="选择配置项查看详情">目前系统参数写在部署清单和环境变量中，修改后需重新发布服务。配置中心接入后，可在此查看当前值与默认值、编辑并发布，高风险项需二次确认。</Empty></div></section>;
  return <section className="panel config-detail">
    <div className="panel-heading"><div><h2>配置详情</h2></div></div>
    <header className="detail-head"><span className="config-icon"><Settings2 size={18}/></span><div><b>{item.name}</b><small className="mono">{item.key}</small></div><StateChip state={item.state}/></header>
    <div className="detail-body">
      <dl><Row label="分组">{item.group}</Row><Row label="当前值"><span className="mono">{item.value}</span></Row><Row label="默认值"><span className="mono">{item.defaultValue}</span></Row>
        <Row label="风险等级"><RiskMark risk={item.risk}/></Row><Row label="适用范围">{item.scope}</Row><Row label="说明">{item.description}</Row><Row label="最后更新">{item.updated} · {item.operator}</Row></dl>
      <h3>配置值（JSON / 文本）</h3>
      <pre className="config-value"><span>1</span><code>{item.value}</code></pre>
      <h3>变更说明</h3>
      <textarea className="config-note" placeholder="请输入本次变更的说明…" maxLength={200} disabled title={NOT_CONNECTED}/>
    </div>
    <footer className="detail-actions">
      <button className="button small" disabled title={NOT_CONNECTED}><RotateCcw size={13}/>回滚到上个版本</button><button className="button small" disabled title={NOT_CONNECTED}><Link2 size={13}/>查看引用模块</button>
      <button className="button small" disabled title={NOT_CONNECTED}>保存草稿</button><button className="button small primary" disabled title={NOT_CONNECTED}>发布配置</button>
    </footer>
  </section>;
}

export default function Config() {
  const [sampleOn, setSampleOn] = useState(false);
  const [data, setData] = useState<ConfigView>();
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState(''), [group, setGroup] = useState(''), [state, setState] = useState(''), [risk, setRisk] = useState('');
  // The sample module loads only when asked for, so it never ships with the default view.
  useEffect(() => {
    setQuery(''); setGroup(''); setState(''); setRisk('');
    if (!sampleOn) { setData(undefined); setSelected(undefined); return; }
    let live = true;
    void import('./config-sample.js').then(module => { if (live) { setData(module.configSample); setSelected(module.configSample.items[1]!.key); } });
    return () => { live = false; };
  }, [sampleOn]);
  const rows = useMemo(() => data?.items.filter(item => (!query || `${item.name} ${item.key} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()))
    && (!group || item.group === group) && (!state || item.state === state) && (!risk || item.risk === risk)), [data, query, group, state, risk]);
  const k = data?.kpis, checks = data?.checks;
  const reset = () => { setQuery(''); setGroup(''); setState(''); setRisk(''); };
  return <div className="dashboard discover config-page">
    <header className="dashboard-heading">
      <div><h1>配置管理</h1><p>统一管理系统参数、采集策略、代理规则、发布与告警配置</p>
        {data ? <span className="data-freshness failing"><i/>示例数据</span> : <span className="data-freshness failing" title="当前参数由部署清单与环境变量管理"><i/>{NOT_CONNECTED} · 参数目前由部署清单管理</span>}</div>
      <div className="dashboard-period"><label className="sample-switch" htmlFor="config-sample"><input id="config-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label>
        <button className="button small" disabled title={NOT_CONNECTED}><Upload size={13}/>导入配置</button><button className="button small" disabled title={NOT_CONNECTED}><Plus size={13}/>新建配置项</button><button className="button small primary" disabled title={NOT_CONNECTED}><Send size={13}/>发布配置</button></div>
    </header>
    {data && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据：配置项、取值与操作账号均为虚构，不是当前实际部署的参数。</div>}

    <div className="discover-kpis">
      <Kpi label="配置项总数" tone="blue" icon={<Settings2 size={22}/>} value={k && fmt(k.total)} foot={data ? `${data.groups.length} 个分组` : NOT_CONNECTED}/>
      <Kpi label="已生效" tone="green" icon={<CircleCheck size={22}/>} value={k && fmt(k.active)} foot={k ? `占比 ${pct(k.active, k.total)}` : NOT_CONNECTED}/>
      <Kpi label="待发布变更" tone="amber" icon={<Clock size={22}/>} value={k && fmt(k.pending)} foot={k ? `草稿 ${k.draft} · 近 7 天变更 ${k.changes7d} 次` : NOT_CONNECTED}/>
      <Kpi label="高风险配置" tone="red" icon={<TriangleAlert size={22}/>} value={k && fmt(k.high)} foot={k ? `占比 ${pct(k.high, k.total)} · 发布需二次确认` : NOT_CONNECTED}/>
    </div>

    <div className="discover-row config-main">
      <section className="panel config-list">
        <div className="panel-heading"><div><h2>配置项列表{rows && <small className="config-count">共 {rows.length} 条{data ? '（示例）' : ''}</small>}</h2></div>
        <div className="list-tools config-filters">
          <label className="list-search" htmlFor="config-search"><Search size={13}/><input id="config-search" placeholder="搜索配置名称 / 配置键 / 说明…" value={query} onChange={event => setQuery(event.target.value)} disabled={!data}/></label>
          <select aria-label="配置分组" value={group} onChange={event => setGroup(event.target.value)} disabled={!data}><option value="">全部分组</option>{data?.groups.map(g => <option key={g.group}>{g.group}</option>)}</select>
          <select aria-label="状态" value={state} onChange={event => setState(event.target.value)} disabled={!data}><option value="">全部状态</option>{Object.entries(stateMeta).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}</select>
          <select aria-label="风险等级" value={risk} onChange={event => setRisk(event.target.value)} disabled={!data}><option value="">全部风险等级</option>{Object.entries(riskMeta).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}</select>
          <button className="button small" onClick={reset} disabled={!data}>重置</button>
        </div></div>
        {rows ? <div className="table-scroll"><table><thead><tr><th>配置名称</th><th>配置键</th><th>分组</th><th>当前值</th><th>状态</th><th>风险等级</th><th>最后更新</th><th>操作人</th><th>操作</th></tr></thead>
          <tbody>{rows.map(item => <tr key={item.key} className={item.key === selected ? 'selected' : ''} onClick={() => setSelected(item.key)} aria-selected={item.key === selected}>
            <td className="cell-title">{item.name}</td><td className="mono">{item.key}</td><td>{item.group}</td><td className="mono">{item.value}</td><td><StateChip state={item.state}/></td><td><RiskMark risk={item.risk}/></td><td>{item.updated}</td><td>{item.operator}</td><td className="row-actions"><MoreHorizontal size={14}/></td></tr>)}
            {!rows.length && <tr><td colSpan={9} className="config-no-match">没有符合条件的配置项</td></tr>}</tbody></table></div>
          : <Empty title="尚无配置项">{NOT_CONNECTED}。目前系统参数写在部署清单和环境变量中，修改需要重新发布服务；接入后在此统一查看、校验、发布配置，并保留变更记录。</Empty>}
      </section>

      <Detail item={data?.items.find(item => item.key === selected)}/>

      <Card title="配置变更记录" className="config-changes" extra={<span className="dashboard-unavailable" title={NOT_CONNECTED}>查看全部<ArrowRight size={12}/></span>}>
        {data ? <div className="table-scroll"><table><thead><tr><th>时间</th><th>配置项</th><th>变更前</th><th>变更后</th><th>操作人</th><th>结果</th></tr></thead>
          <tbody>{data.changes.map(c => <tr key={`${c.time}-${c.name}`}><td>{c.time}</td><td>{c.name}</td><td className="mono">{c.before}</td><td className="mono">{c.after}</td><td>{c.operator}</td><td><span className={`status-chip ${resultMeta[c.result].tone}`}><i/>{resultMeta[c.result].label}</span></td></tr>)}</tbody></table></div>
          : <Empty title="暂无变更记录">{NOT_CONNECTED}</Empty>}
      </Card>

      <Card title="配置校验与发布检查" className="config-checks">
        <div className="check-body"><div className="check-tiles">
          <div className="green"><CircleCheck size={16}/><span>必填项校验</span><b>{checks ? `${checks.required[0]} / ${checks.required[1]}` : '—'}</b></div>
          <div className="amber"><TriangleAlert size={16}/><span>高风险需二次确认</span><b>{checks ? `${checks.highRisk} 项` : '—'}</b></div>
          <div className="green"><CircleCheck size={16}/><span>引用模块检查</span><b>{checks ? `${checks.references[0]} / ${checks.references[1]}` : '—'}</b></div>
          <div className="blue"><Clock size={16}/><span>待发布项</span><b>{checks ? `${checks.pending} 条` : '—'}</b></div>
        </div>
        <h3 className="check-sub">配置分组统计</h3>
        {data ? <div className="group-counts">{data.groups.map(g => <div key={g.group}><span>{g.group}</span><b>{g.count}</b></div>)}</div> : <p className="check-empty">{NOT_CONNECTED}</p>}</div>
      </Card>
    </div>
    <footer className="dashboard-foot"><span>高风险配置发布前需二次确认；每次发布保留变更前后值，可回滚到上个版本。</span><span>“预览示例数据”仅用于查看页面设计</span></footer>
  </div>;
}
