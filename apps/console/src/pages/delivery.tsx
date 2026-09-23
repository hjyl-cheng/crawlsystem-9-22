import { useEffect, useState, type ReactNode } from 'react';
import { CircleCheck, CircleX, FileText, MoreHorizontal, Plus, RotateCw, Search, Send, Settings, Timer, TriangleAlert } from 'lucide-react';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty } from '../ui.js';
import type { DeliveryRow, DeliveryStatus, DeliveryView } from './delivery-sample.js';
import './overview.css';
import './discover.css';
import './delivery.css';

const NOT_ENABLED = '发布交付未启用';
// SENT is not DELIVERED: only the consumer's receipt makes a delivery complete.
const statusMeta: Record<DeliveryStatus, { label: string; tone: string }> = {
  not_ready: { label: '未达发布条件', tone: 'slate' }, ready: { label: '待发布', tone: 'amber' }, sent: { label: '已发送待确认', tone: 'blue' },
  delivered: { label: '已交付', tone: 'green' }, failed: { label: '交付失败', tone: 'red' },
};
const tabs: ('all' | DeliveryStatus)[] = ['all', 'ready', 'sent', 'delivered', 'failed', 'not_ready'];

function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="kv-row"><dt>{label}</dt><dd>{children}</dd></div>;

function Detail({ row, view }: { row?: DeliveryRow; view?: DeliveryView }) {
  if (!row || !view) return <section className="panel delivery-detail"><Empty title="选择交付查看详情">{view ? '点击左侧任意一行' : NOT_ENABLED}</Empty></section>;
  const meta = statusMeta[row.status];
  return <section className="panel delivery-detail">
    <header className="detail-head"><span className="avatar-dot big" style={{ background: row.color }}>{row.channel[0]}</span><div><b>{row.channel}</b><small>{row.handle} · 数据版本 r{row.revision}</small></div></header>
    <div className="detail-tabs" role="tablist"><button role="tab" aria-selected="true" className="on">交付详情</button><button role="tab" aria-selected="false" disabled title={NOT_ENABLED}>交付记录</button></div>
    <div className="detail-body">
      <dl><Row label="交付编号"><span className="mono">{row.id}</span></Row><Row label="交付目标">{row.target}</Row><Row label="发送通道"><span className="mono">{row.topic}</span></Row>
        <Row label="状态"><span className={`status-chip ${meta.tone}`}><i/>{meta.label}</span></Row><Row label="数据版本">r{row.revision} · 采集完成 {row.collectedAt}</Row><Row label="业务回执">{row.receipt} · {row.receiptDetail}</Row></dl>
      <h3>近 7 天交付</h3>
      <div className="week-stats">{[['发送', view.week.sent], ['业务接受', view.week.accepted], ['失败', view.week.failed], ['接受率', view.week.rate]].map(([label, value]) => <div key={label}><b>{value}</b><small>{label}</small></div>)}</div>
      <h3>交付日志</h3>
      {row.status === 'delivered' ? <ol className="delivery-log">{view.log.map(step => <li key={step.step} className={step.done ? 'done' : ''}><i/><div><b>{step.step}</b><small>{step.at}{step.note ? ` · ${step.note}` : ''}</small></div></li>)}</ol>
        : <p className="detail-note">{row.status === 'not_ready' ? `未达发布条件：${row.receiptDetail}。必需数据齐全后才会生成可发布版本。` : row.status === 'failed' ? `业务方拒绝了版本 r${row.revision}：${row.receiptDetail}。` : row.status === 'sent' ? `已发送至 ${row.topic}，等待 ${row.target} 回执；回执到达前不计为已交付。` : '版本已满足发布条件，等待发送。'}</p>}
    </div>
    <footer className="detail-actions"><button className="button small" disabled title={NOT_ENABLED}><RotateCw size={13}/>重新发送</button><button className="button small" disabled title={NOT_ENABLED}><FileText size={13}/>查看回执</button></footer>
  </section>;
}

export default function Delivery() {
  const { api } = useAuth();
  // Real figure today: plans that completed collection, while publication is not enabled in M1.
  const summary = useResource('delivery-plans-summary', signal => api.plansSummary(signal), true, 15_000);
  const [sampleOn, setSampleOn] = useState(false);
  const [data, setData] = useState<DeliveryView>();
  const [tab, setTab] = useState<'all' | DeliveryStatus>('all');
  const [selected, setSelected] = useState<string>();
  // The sample module loads only when asked for, so it never ships with the default view.
  useEffect(() => {
    if (!sampleOn) { setData(undefined); setSelected(undefined); setTab('all'); return; }
    let live = true;
    void import('./delivery-sample.js').then(module => { if (live) { setData(module.deliverySample); setSelected(module.deliverySample.rows[0]!.id); } });
    return () => { live = false; };
  }, [sampleOn]);
  const rows = data?.rows.filter(r => tab === 'all' || r.status === tab) ?? [];
  const row = data?.rows.find(r => r.id === selected);
  const k = data?.kpis;
  return <div className="dashboard discover delivery-page">
    <header className="dashboard-heading">
      <div><h1>发布交付</h1><p>把已采集完成的频道数据版本交付给下游业务系统，以业务方回执确认交付</p>
        {data ? <span className="data-freshness failing"><i/>示例数据</span> : <span className="data-freshness failing" title="来自计划统计：本轮已完成的计划"><i/>{NOT_ENABLED}{summary.data ? ` · ${summary.data.by_status.COMPLETED} 个计划已完成采集` : ''}</span>}
      </div>
      <div className="dashboard-period"><label className="sample-switch" htmlFor="delivery-sample"><input id="delivery-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label>
        <button className="button small" disabled title={NOT_ENABLED}><Settings size={13}/>交付配置</button><button className="button small primary" disabled title={NOT_ENABLED}><Plus size={13}/>新建交付目标</button></div>
    </header>
    {data && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据（频道与业务系统均为虚构），用于预览页面效果。“已发送”在业务方回执前不计为已交付。</div>}

    <div className="discover-kpis">
      <Kpi label="待发布" tone="amber" icon={<Send size={22}/>} value={k?.ready} foot={k ? `较昨日 ${k.readyDelta}` : NOT_ENABLED}/>
      <Kpi label="今日已交付" tone="green" icon={<CircleCheck size={22}/>} value={k?.deliveredToday} foot={k ? `本月累计 ${k.deliveredMonth.toLocaleString('zh-CN')}` : NOT_ENABLED}/>
      <Kpi label="已发送待确认" tone="blue" icon={<Timer size={22}/>} value={k?.sent} foot={k ? `最久等待 ${k.oldestSent}` : NOT_ENABLED}/>
      <Kpi label="交付失败" tone="red" icon={<CircleX size={22}/>} value={k?.failed} foot={k ? `失败率 ${k.failRate}` : NOT_ENABLED}/>
    </div>

    <div className="discover-row row-delivery">
      <section className="panel delivery-list">
        <div className="status-tabs" role="tablist">{tabs.map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} disabled={!data} onClick={() => setTab(t)}>{t === 'all' ? '全部' : statusMeta[t].label}<span>{data ? data.tabs[t] : '—'}</span></button>)}</div>
        <div className="list-tools delivery-filters">
          <label className="list-search" htmlFor="delivery-search"><Search size={13}/><input id="delivery-search" placeholder="搜索频道名称 / 交付编号…" disabled/></label>
          {['交付目标', '交付状态', '业务分类', '国家 / 地区'].map(label => <select key={label} aria-label={label} disabled><option>{label}</option></select>)}
          <button className="button small" disabled>重置</button>
        </div>
        {data ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>数据版本</th><th>交付目标</th><th>状态</th><th>最近发送</th><th>业务回执</th><th>操作</th></tr></thead>
          <tbody>{rows.map(r => { const meta = statusMeta[r.status]; return <tr key={r.id} className={r.id === selected ? 'selected' : ''} onClick={() => setSelected(r.id)} aria-selected={r.id === selected}>
            <td><div className="channel-cell"><span className="avatar-dot" style={{ background: r.color }}>{r.channel[0]}</span><div><b>{r.channel}</b><small className="mono">{r.id}</small></div></div></td>
            <td><b className="cell-title">r{r.revision}</b><small className="cell-sub">采集完成 {r.collectedAt}</small></td>
            <td><b className="cell-title">{r.target}</b><small className="cell-sub mono">{r.topic}</small></td>
            <td><span className={`status-chip ${meta.tone}`}><i/>{meta.label}</span></td><td>{r.lastAt ?? '—'}</td>
            <td><b className={`cell-title ${r.status === 'failed' ? 'text-red' : r.status === 'delivered' ? 'text-green' : ''}`}>{r.receipt}</b><small className="cell-sub">{r.receiptDetail}</small></td>
            <td className="row-actions"><span title={NOT_ENABLED}>{r.status === 'ready' ? '发送' : '查看'}</span><MoreHorizontal size={14}/></td>
          </tr>; })}</tbody></table></div>
          : <Empty title="尚无交付记录">发布交付未启用。已采集完成的频道数据版本会在这里交付给下游业务系统，并以业务回执确认。</Empty>}
        <footer className="pager">{data ? <span>共 {data.tabs.all} 条（示例）</span> : <span>—</span>}</footer>
      </section>
      <Detail row={row} view={data}/>
    </div>
    <footer className="dashboard-foot"><span>交付对象为下游业务系统；“已发送”在业务方回执前不计为已交付。</span><span>“预览示例数据”仅用于查看页面设计</span></footer>
  </div>;
}
