import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, CalendarDays, ChevronDown, CircleCheck, CircleX, Clock3, Download, FileText, ListChecks, MoreHorizontal, Plus, Search, TriangleAlert, Upload } from 'lucide-react';
import { Empty } from '../ui.js';
import type { CandidateStatus, CandidatesView } from './candidates-sample.js';
import './overview.css';
import './discover.css';
import './candidates.css';

const NOT_CONNECTED = '候选频道尚未接入';
const kpis: { label: string; tone: string; icon: ReactNode }[] = [
  { label: '候选频道总数', tone: 'blue', icon: <ListChecks size={22}/> },
  { label: '待审核', tone: 'amber', icon: <Clock3 size={22}/> },
  { label: '已通过（等待采集）', tone: 'green', icon: <CircleCheck size={22}/> },
  { label: '已拒绝', tone: 'red', icon: <CircleX size={22}/> },
];
const statusMeta: Record<CandidateStatus, { label: string; tone: string }> = {
  pending: { label: '待审核', tone: 'amber' }, approved: { label: '已通过', tone: 'green' }, rejected: { label: '已拒绝', tone: 'red' },
};
const fmt = (n: number) => n.toLocaleString('zh-CN');

function Bars({ series, tone }: { series: number[]; tone: string }) {
  const max = Math.max(...series);
  return <svg className={`kpi-bars ${tone}`} viewBox={`0 0 ${series.length * 8} 40`} aria-hidden="true">
    {series.map((v, i) => <rect key={i} x={i * 8 + 1} y={40 - v / max * 38} width="5" height={v / max * 38} rx="1" opacity={0.45 + 0.55 * (i + 1) / series.length}/>)}
  </svg>;
}
const Select = ({ label, id }: { label: string; id: string }) => <label className="filter-field" htmlFor={id}><span>{label}</span><select id={id} disabled><option>全部</option></select></label>;

export default function Candidates() {
  const [sampleOn, setSampleOn] = useState(false);
  const [data, setData] = useState<CandidatesView>();
  // The sample module loads only when asked for, so it never ships with the default view.
  useEffect(() => {
    if (!sampleOn) { setData(undefined); return; }
    let live = true;
    void import('./candidates-sample.js').then(module => { if (live) setData(module.candidatesSample); });
    return () => { live = false; };
  }, [sampleOn]);
  return <div className="dashboard discover candidates">
    <header className="dashboard-heading">
      <div><h1>候选频道</h1><p>管理 Query 发现的候选频道，支持批量导入、去重、筛选、审核和转入全量采集</p><span className="data-freshness failing"><i/>{data ? '示例数据' : NOT_CONNECTED}</span></div>
      <div className="dashboard-period"><label className="sample-switch" htmlFor="candidates-sample"><input id="candidates-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label></div>
    </header>
    {data && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据（频道均为虚构），用于预览页面效果，不是真实候选。候选频道后端接入后显示真实数据。</div>}

    <div className="discover-kpis">{kpis.map((kpi, i) => { const k = data?.kpis[i]; return <section key={kpi.label} className={`panel discover-kpi tone-${kpi.tone}`}>
      <span className="kpi-icon">{kpi.icon}</span>
      <div><small>{kpi.label}</small><strong>{k ? fmt(k.value) : '—'}</strong>{k ? <em>↑ {k.delta}<span>{k.rate}</span></em> : <span className="kpi-foot"><span>{NOT_CONNECTED}</span></span>}</div>
      {k && <Bars series={k.series} tone={kpi.tone}/>}
    </section>; })}</div>

    <div className="discover-row row-import">
      <section className="panel import-card">
        <div className="panel-heading"><div><h2>批量导入候选频道</h2></div><span className="dashboard-unavailable" title={NOT_CONNECTED}>下载模板<Download size={12}/></span></div>
        <div className="import-body">
          <div className="dropzone" aria-disabled="true" title={NOT_CONNECTED}>
            <Upload size={24}/><b>点击上传文件或拖拽到此处</b><small>支持 CSV、TXT（每行一个频道 URL / ID / 关键词），最大 10MB</small>
            <button className="button small primary" disabled>选择文件</button>
          </div>
          <div className="import-notes"><b>导入说明</b><ul>
            <li>支持 YouTube 频道 URL、频道 ID、关键词或频道名</li><li>系统自动去重：与已纳管频道、候选频道、已采频道对比</li>
            <li>导入后进入“待审核”，可批量编辑分类与来源</li><li>建议使用 UTF-8 编码的 CSV 或 TXT 文件</li>
          </ul></div>
        </div>
      </section>
      <section className="panel imports-card">
        <div className="panel-heading"><div><h2>近期导入记录</h2></div><span className="dashboard-unavailable" title={NOT_CONNECTED}>查看全部<ArrowRight size={12}/></span></div>
        {data ? <div className="import-list">{data.imports.map(r => <div key={r.file}><FileText size={18}/><div><b title={r.file}>{r.file}</b><small>{fmt(r.rows)} 条 <em className="ok">成功 {fmt(r.ok)}</em> <em className="bad">失败 {r.failed}</em></small></div><time>{r.at}<small>{r.by}</small></time></div>)}</div> : <Empty title="暂无导入记录">{NOT_CONNECTED}</Empty>}
      </section>
    </div>

    <section className="panel candidates-list">
      <div className="candidate-filters">
        <label className="list-search wide" htmlFor="candidate-search"><Search size={13}/><input id="candidate-search" placeholder="搜索频道名 / 频道 ID / URL / 关键词…" disabled/></label>
        <Select label="状态" id="f-status"/><Select label="来源类型" id="f-source"/><Select label="发现方式" id="f-method"/><Select label="标签" id="f-tag"/>
        <label className="filter-field" htmlFor="f-time"><span>发现时间</span><span className="date-range" id="f-time" aria-disabled="true">开始日期 → 结束日期<CalendarDays size={13}/></span></label>
        <button className="button small" disabled>重置</button><button className="button small" disabled>更多筛选<ChevronDown size={12}/></button>
      </div>
      <div className="candidate-toolbar">
        <span>已选择 0 项</span>
        {['通过审核', '拒绝', '转入全量采集', '添加标签', '删除'].map(action => <button key={action} className="button small" disabled>{action}</button>)}
        <button className="button small" disabled><Download size={12}/>导出</button>
        <button className="button small primary push" disabled title={NOT_CONNECTED}><Plus size={13}/>导入候选频道</button>
      </div>
      {data ? <div className="table-scroll"><table><thead><tr><th className="check"><input type="checkbox" aria-label="全选" disabled/></th><th>#</th><th>频道信息</th><th>来源类型</th><th>发现方式</th><th>发现关键词</th><th className="num">订阅数</th><th className="num">视频数</th><th>最近视频</th><th>状态</th><th>标签</th><th>发现时间</th><th>操作</th></tr></thead>
        <tbody>{data.rows.map((row, i) => { const meta = statusMeta[row.status]; return <tr key={row.handle}>
          <td className="check"><input type="checkbox" aria-label={`选择 ${row.name}`} disabled/></td><td className="text-muted">{i + 1}</td>
          <td><div className="channel-cell"><span className="avatar-dot" style={{ background: row.color }}>{row.name[0]}</span><div><b>{row.name}</b><small>{row.handle}</small></div></div></td>
          <td>{row.source}</td><td>{row.method}</td><td>{row.keyword ? <span className="keyword-chip">{row.keyword}</span> : <span className="text-muted">—</span>}</td>
          <td className="num">{row.subscribers}</td><td className="num">{fmt(row.videos)}</td><td>{row.latest}</td>
          <td><span className={`status-chip ${meta.tone}`}><i/>{meta.label}</span></td><td><span className="tag-chip">{row.tag}</span></td><td>{row.found}</td>
          <td className="row-actions"><span title={NOT_CONNECTED}>详情</span><MoreHorizontal size={14}/></td>
        </tr>; })}</tbody></table></div> : <Empty title="尚无候选频道">候选频道的导入、去重与审核尚未接入后端。</Empty>}
      <footer className="pager">{data ? <><span>共 {fmt(data.total)} 条（示例）</span><span className="page-size">每页 50 <ChevronDown size={12}/></span><div className="pages">{['‹', '1', '2', '3', '4', '5', '…', '249', '›'].map((p, i) => <button key={i} className={p === '1' ? 'on' : ''} disabled>{p}</button>)}</div></> : <span>—</span>}</footer>
    </section>
    <footer className="dashboard-foot"><span>候选频道为 Discover 阶段模块；接入前各统计显示“—”。“预览示例数据”仅用于查看页面设计。</span><span>审核通过后由计划服务转入全量采集</span></footer>
  </div>;
}
