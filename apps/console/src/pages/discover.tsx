import { useState, type ReactNode } from 'react';
import { CircleCheck, CirclePlay, OctagonX, Plus, RefreshCw, Search, Snowflake, Zap } from 'lucide-react';
import { BUSINESS_CATEGORIES, type BusinessCategory, type QueryBinding } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { ApiFailure } from '../api.js';
import { useResource } from '../resource.js';
import { Empty, ErrorBox, Modal, ResourceView } from '../ui.js';
import { categoryLabels, time } from '../presentation.js';
import './overview.css';
import './discover.css';

const stateMeta: Record<QueryBinding['state'], { label: string; tone: string }> = {
  BOOTSTRAP: { label: '待首次搜索', tone: 'blue' }, ACTIVE: { label: '活跃', tone: 'green' }, COOLDOWN: { label: '冷却中', tone: 'amber' }, DORMANT: { label: '休眠', tone: 'slate' }, DISABLED: { label: '已停用', tone: 'red' },
};
const sourceLabels: Record<QueryBinding['sources'][number]['type'], string> = {
  SEED_KEYWORD: '种子词', AUTO_TAG: '自动标签', VIDEO_TITLE: '视频标题', VIDEO_DESCRIPTION: '视频描述', CHANNEL_ABOUT: '频道简介', RELATED_QUERY: '相关搜索', MANUAL: '人工添加',
};
const cadenceText = (b: QueryBinding) => b.state === 'BOOTSTRAP' ? '首次搜“今年”' : (b.cadence_override ?? b.cadence) === 'WEEK' ? '每周' : (b.cadence_override ?? b.cadence) === 'MONTH' ? '每月' : '—';
const fmt = (n?: number) => n === undefined ? '—' : n.toLocaleString('zh-CN');
/** The latest search of a query, in words. */
function lastRunText(run: QueryBinding['last_run']): string {
  if (!run) return '还没搜过';
  if (run.state === 'SUCCEEDED') return `新频道 ${run.new_channels ?? 0}，合格 ${run.qualified_new ?? 0}`;
  return { PENDING: '失败，等待重试', RUNNING: '正在搜索', FAILED: '多次失败，明天再试', CANCELLED: '已取消' }[run.state];
}

function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}
function Card({ title, subtitle, extra, className = '', children }: { title: string; subtitle?: ReactNode; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{extra}</div>{children}</section>;
}

function AddQuery({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const { api } = useAuth();
  const [form, setForm] = useState({ text: '', country: 'BR', language: 'pt', category: 'Music' as BusinessCategory });
  const [busy, setBusy] = useState(false), [error, setError] = useState<ApiFailure>();
  async function submit() {
    setBusy(true); setError(undefined);
    try { await api.createQuery(form); setForm({ ...form, text: '' }); onAdded(); onOpenChange(false); }
    catch (cause) { setError(cause instanceof ApiFailure ? cause : new ApiFailure('添加失败，请重试')); }
    finally { setBusy(false); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="添加搜索词" description="同一个词在同一国家、同一分类下只登记一次；重复添加只会记下新的来源。新词会先搜一次“今年”，再按结果决定每周或每月搜。">
    <form className="fields" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label>搜索词<input aria-label="搜索词" value={form.text} maxLength={200} onChange={e => setForm({ ...form, text: e.target.value })}/></label>
      <label>国家（两位代码）<input aria-label="国家" value={form.country} maxLength={2} onChange={e => setForm({ ...form, country: e.target.value.toUpperCase() })}/></label>
      <label>搜索语言<input aria-label="搜索语言" value={form.language} maxLength={8} onChange={e => setForm({ ...form, language: e.target.value })}/></label>
      <label>业务分类<select aria-label="业务分类" value={form.category} onChange={e => setForm({ ...form, category: e.target.value as BusinessCategory })}>
        {BUSINESS_CATEGORIES.map(c => <option key={c} value={c}>{categoryLabels[c]}</option>)}</select></label>
      {error && <ErrorBox error={error}/>}
      <div className="dialog-actions"><button className="button primary" disabled={busy || !form.text.trim()}>{busy ? '正在添加…' : '添加'}</button></div>
    </form>
  </Modal>;
}

/** Query discovery: query terms bound to a country and a business category, each with its own search clock. */
export default function Discover() {
  const { api, session } = useAuth();
  const operator = session.role === 'operator';
  const [filter, setFilter] = useState<{ state?: QueryBinding['state']; category?: BusinessCategory; country?: string; search?: string }>({});
  const [cursor, setCursor] = useState('0'), [adding, setAdding] = useState(false), [busy, setBusy] = useState<string>(), [error, setError] = useState<ApiFailure>();
  const summary = useResource('query-summary', signal => api.querySummary(signal), true, 30_000);
  const list = useResource(`queries:${cursor}:${JSON.stringify(filter)}`, signal => api.queries(cursor, filter, signal), true, 30_000);
  const s = summary.data;
  const refresh = () => { summary.refresh(); list.refresh(); };
  const set = (next: typeof filter) => { setFilter(next); setCursor('0'); };
  async function command(b: QueryBinding, body: Parameters<typeof api.queryCommand>[1]) {
    setBusy(b.binding_id); setError(undefined);
    try { await api.queryCommand(b.binding_id, body); refresh(); }
    catch (cause) { setError(cause instanceof ApiFailure ? cause : new ApiFailure('操作失败，请刷新后重试')); }
    finally { setBusy(undefined); }
  }
  const ask = (question: string) => { const reason = window.prompt(question)?.trim(); return reason || undefined; };
  const categoryMax = Math.max(1, ...(s?.by_category.map(c => c.bindings) ?? [1]));
  return <div className="dashboard discover">
    <header className="dashboard-heading">
      <div><h1>Query 发现</h1><p>搜索词按“国家 + 业务分类”管理，每个都有自己的搜索时钟：首次搜“今年”，之后每周或每月搜一次</p>
        {s && <span className={`data-freshness ${s.runs.enabled ? '' : 'failing'}`}><i/>{s.runs.enabled ? `自动搜索已开启：今天已搜 ${fmt(s.runs.created_today)} 次（上限 ${fmt(s.runs.daily_run_limit)}），同时最多 ${s.runs.max_active_runs} 个` : '自动搜索已关闭'}</span>}</div>
      <div className="dashboard-period"><button className="button small" onClick={refresh}><RefreshCw size={13}/>刷新</button>
        {operator && <button className="button small primary" onClick={() => setAdding(true)}><Plus size={13}/>添加搜索词</button>}</div>
    </header>
    {summary.error && <ErrorBox error={summary.error}/>} {error && <ErrorBox error={error}/>}
    <AddQuery open={adding} onOpenChange={setAdding} onAdded={refresh}/>

    <div className="discover-kpis">
      <Kpi label="搜索词" tone="blue" icon={<Search size={22}/>} value={fmt(s?.total)} foot={s ? `覆盖 ${s.by_country.length} 个国家 · 已到期待搜 ${fmt(s.due)}` : '—'}/>
      <Kpi label="待首次搜索" tone="blue" icon={<CirclePlay size={22}/>} value={fmt(s?.by_state.BOOTSTRAP)} foot="首次搜“今年”后再定频率"/>
      <Kpi label="活跃" tone="green" icon={<Zap size={22}/>} value={fmt(s?.by_state.ACTIVE)} foot="每周或每月搜一次"/>
      <Kpi label="冷却 / 休眠" tone="amber" icon={<Snowflake size={22}/>} value={s ? `${fmt(s.by_state.COOLDOWN)} / ${fmt(s.by_state.DORMANT)}` : undefined} foot={s ? `已停用 ${fmt(s.by_state.DISABLED)}` : '—'}/>
    </div>

    <section className="panel discover-card run-strip" aria-label="今日搜索">
      <div><small>正在搜索</small><strong>{fmt(s?.runs.running)}</strong></div>
      <div><small>今天完成</small><strong>{fmt(s?.runs.succeeded_today)}</strong></div>
      <div><small>失败待重试</small><strong>{fmt(s?.runs.pending_retry)}</strong></div>
      <div><small>今天放弃</small><strong>{fmt(s?.runs.failed_today)}</strong></div>
      <div><small>今天发现新频道</small><strong>{fmt(s?.runs.new_channels_today)}</strong></div>
      <div><small>其中合格（订阅 ≥1000）</small><strong>{fmt(s?.runs.qualified_today)}</strong></div>
      <div><small>候选频道：合格 / 不合格 / 不可用</small><strong>{s ? `${fmt(s.candidates.qualified)} / ${fmt(s.candidates.unqualified)} / ${fmt(s.candidates.unavailable)}` : '—'}</strong></div>
      <div><small>最近一次完成</small><strong className="small-value">{s?.runs.last_finished_at ? time(s.runs.last_finished_at) : '—'}</strong></div>
    </section>

    <div className="discover-row row-list">
      <Card title="搜索词列表" className="query-list" extra={<div className="list-tools">
        <select aria-label="状态" value={filter.state ?? ''} onChange={e => set({ ...filter, state: (e.target.value || undefined) as QueryBinding['state'] | undefined })}>
          <option value="">全部状态</option>{Object.entries(stateMeta).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <select aria-label="业务分类" value={filter.category ?? ''} onChange={e => set({ ...filter, category: (e.target.value || undefined) as BusinessCategory | undefined })}>
          <option value="">全部分类</option>{BUSINESS_CATEGORIES.map(c => <option key={c} value={c}>{categoryLabels[c]}</option>)}</select>
        <select aria-label="国家" value={filter.country ?? ''} onChange={e => set({ ...filter, country: e.target.value || undefined })}>
          <option value="">全部国家</option>{s?.by_country.map(c => <option key={c.country} value={c.country}>{c.country}</option>)}</select>
        <label className="list-search"><Search size={13}/><input aria-label="搜索搜索词" placeholder="搜索词…" maxLength={200} value={filter.search ?? ''} onChange={e => set({ ...filter, search: e.target.value || undefined })}/></label>
      </div>}>
        <ResourceView resource={list}>{page => <>{page.items.length ? <div className="table-scroll"><table><thead><tr><th>搜索词</th><th>国家 / 语言</th><th>业务分类</th><th>状态</th><th>频率</th><th>下次搜索</th><th>上次搜索结果</th><th>来源</th>{operator && <th>操作</th>}</tr></thead>
          <tbody>{page.items.map(b => { const meta = stateMeta[b.state]; return <tr key={b.binding_id}>
            <td className="query-term">{b.text}</td><td>{b.country} / {b.language}</td><td>{categoryLabels[b.category]}</td>
            <td><span className={`status-chip ${meta.tone}`}><i/>{meta.label}</span></td>
            <td>{cadenceText(b)}{b.cadence_override && <small className="cell-sub">人工指定</small>}</td>
            <td>{b.next_run_at ? time(b.next_run_at) : '—'}</td><td>{lastRunText(b.last_run)}{b.last_success_at && <small className="cell-sub">上次成功 {time(b.last_success_at)}</small>}</td>
            <td title={b.sources.map(x => `${sourceLabels[x.type]}：${x.ref}`).join('\n')}>{[...new Set(b.sources.map(x => sourceLabels[x.type]))].join('、')}{b.source_count > 1 && <small className="cell-sub">共 {b.source_count} 条</small>}</td>
            {operator && <td className="row-actions">
              {b.state === 'DISABLED'
                ? <button className="text-button" disabled={!!busy} onClick={() => void command(b, { action: 'enable', expected_version: b.version })}>启用</button>
                : <button className="text-button" disabled={!!busy} onClick={() => { const reason = ask('停用原因'); if (reason) void command(b, { action: 'disable', reason, expected_version: b.version }); }}>停用</button>}
              <select aria-label={`${b.text} 搜索频率`} value={b.cadence_override ?? 'auto'} disabled={!!busy || b.state === 'DISABLED'} onChange={e => {
                const cadence = e.target.value === 'auto' ? null : e.target.value as 'WEEK' | 'MONTH', reason = ask('调整频率的原因');
                if (reason) void command(b, { action: 'set_cadence', cadence, reason, expected_version: b.version }); }}>
                <option value="auto">自动</option><option value="WEEK">每周</option><option value="MONTH">每月</option></select>
            </td>}
          </tr>; })}</tbody></table></div> : <Empty title="没有符合条件的搜索词">可以调整筛选条件，或添加新的搜索词。</Empty>}
          <footer className="pager"><span>每页最多 20 条</span><button className="button small" disabled={cursor === '0'} onClick={() => setCursor(String(Math.max(0, Number(cursor) - 20)))}>上一页</button><button className="button small" disabled={!page.next_cursor} onClick={() => setCursor(page.next_cursor!)}>下一页</button></footer></>}</ResourceView>
      </Card>
      <Card title="业务分类分布" subtitle="未停用的搜索词">
        {s?.by_category.length ? <div className="reason-bars">{s.by_category.map(c => <div key={c.category}><span>{categoryLabels[c.category]}</span><div className="dim-bar"><i style={{ width: `${(c.bindings / categoryMax) * 100}%` }}/></div><b>{fmt(c.bindings)}</b></div>)}</div>
          : <Empty title="还没有搜索词">添加搜索词后显示各分类的数量。</Empty>}
      </Card>
    </div>
    <footer className="dashboard-foot"><span><CircleCheck size={12}/> 状态：待首次搜索 → 活跃（每周 / 每月）→ 冷却 → 休眠；<OctagonX size={12}/> 人工停用后，新来源不会自动解除停用。</span><span>统计时间：{s ? time(s.observed_at) : '—'}</span></footer>
  </div>;
}
