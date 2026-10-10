import {useState} from 'react';
import {Link} from 'react-router';
import type {Analytics} from '@crawlsystem/contracts/analytics';
import {useAuth} from '../auth.js';
import {useResource} from '../resource.js';
import {Empty,Fields,PageHeading,Panel,ResourceView} from '../ui.js';
import {number,time} from '../presentation.js';
import './analytics.css';
const domainLabels:Record<string,string>={ABOUT:'频道资料',VIDEO:'视频',AGENT:'画像',SAMPLING:'统计重采样',TARGETS:'视频目录'};
const statusLabels:Record<string,string>={APPLIED:'已入库',PARTIAL:'部分字段待解析',UNAVAILABLE:'视频不可访问'};
const bytes=(n:number|null)=>n===null?'—':`${(n/1024/1024).toFixed(2)} MiB`;
export function TrendChart({data}:{data:Analytics}) {
  const max=Math.max(1,...data.trend.map(d=>d.videos+d.about+d.agent));
  return data.trend.length?<div className="analytics-trend" role="img" aria-label="每日采集趋势">{data.trend.map(d=><div className="trend-day" key={d.at} title={`${d.at.slice(0,10)}：视频 ${d.videos}、资料 ${d.about}、画像 ${d.agent}；完成 ${d.completed}、失败 ${d.failed}`}><strong>{number(d.collected)}</strong><div className="trend-bar" style={{height:`${Math.max(3,(d.videos+d.about+d.agent)/max*150)}px`}}><i style={{flex:d.videos||0,background:'var(--blue,#3b82f6)'}}/><i style={{flex:d.about||0,background:'#22c55e'}}/><i style={{flex:d.agent||0,background:'#a855f7'}}/></div><small>{d.at.slice(5,10)}</small></div>)}</div>:<Empty title="这段时间没有采集事件"/>;
}
export function OverviewTrends({days=7}:{days?:number}) {
  const {api}=useAuth(),r=useResource(`overview-analytics:${days}`,signal=>api.analytics(days,signal),true,30000);
  return <Panel title={`采集趋势 · ${days===1?'今天（UTC）':`近${days}天`}`} className="trend-panel" extra={<Link to="/analytics">查看统计 →</Link>}><ResourceView resource={r} showMeta={false}>{d=><TrendChart data={d}/>}</ResourceView></Panel>;
}
export default function AnalyticsPage({quality=false}:{quality?:boolean}) {
  const {api}=useAuth(),[days,setDays]=useState(7),resource=useResource(`analytics:${days}`,signal=>api.analytics(days,signal));
  return <><PageHeading title={quality?'质量分析':'采集统计'} description={quality?'跟踪可访问性和字段完整度，未知字段保留其真实状态。':'查看已入库采集量、计划结果和每日趋势。'}/>
    <div className="analytics-filters"><label>统计时间<select aria-label="统计时间" value={days} onChange={e=>setDays(Number(e.target.value))}><option value="1">今天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="180">最近 180 天</option></select></label><Link to={quality?'/analytics':'/quality'}>{quality?'采集统计':'质量分析'} →</Link></div>
    <ResourceView resource={resource}>{d=><><div className="analytics-kpis">{[['视频入库',d.totals.videos],['资料入库',d.totals.about],['画像入库',d.totals.agent],['完成 / 失败计划',`${d.totals.completed} / ${d.totals.failed}`]].map(([label,value])=><section className="panel" key={label}><small>{label}</small><strong>{typeof value==='number'?number(value):value}</strong></section>)}</div>
      {!quality && <Panel title="每日采集趋势"><TrendChart data={d}/><p className="fine-print inset">蓝色：视频 · 绿色：频道资料 · 紫色：画像</p></Panel>}
      <Panel title="字段完整度与采集结果">{d.quality.length?<div className="table-scroll"><table><thead><tr><th>领域</th><th>结果</th><th>观察数</th><th>未解析字段 / 指标总数</th><th>字段完整率</th></tr></thead><tbody>{d.quality.map(row=><tr key={row.domain+row.status}><td>{domainLabels[row.domain]??row.domain}</td><td>{statusLabels[row.status]??row.status}</td><td>{number(row.count)}</td><td>{number(row.missing)} / {number(row.total)}</td><td>{row.total?`${((row.total-row.missing)/row.total*100).toFixed(1)}%`:'—'}</td></tr>)}</tbody></table></div>:<Empty title="尚无质量观察"/>}<p className="fine-print inset">质量观察包含上线时的存量快照；存量视频 {number(d.baseline)} 条单独记录，不计入新采集量。无法访问的视频单独列出。</p></Panel>
      <Panel title="失败原因">{d.failures.length?<div className="table-scroll"><table><thead><tr><th>原因</th><th>记录数</th></tr></thead><tbody>{d.failures.map(f=><tr key={f.code}><td>{f.code}</td><td>{number(f.count)}</td></tr>)}</tbody></table></div>:<Empty title="统计范围内没有失败"/>}<p className="inset"><Link to="/failures">进入失败处理 →</Link></p></Panel>
      <p className="fine-print">统计来源：ClickHouse · 更新于 {time(d.observed_at)} · 原始采集 {bytes(d.totals.raw_bytes)}</p></>}</ResourceView></>;
}
export function StoragePage() {
  const {api}=useAuth(),r=useResource('storage',signal=>api.storage(signal));
  return <><PageHeading title="存储与流水线" description="查看持久队列、统计入库和数据保留状态。"/><ResourceView resource={r}>{s=><>
    <Panel title="入库与恢复"><Fields rows={[
      ['PostgreSQL 数据库大小',bytes(s.postgres_bytes)],['等待发布的统计事件',number(s.outbox.pending)],['等待归档的统计事件',number(s.outbox.unarchived)],['最早待归档事件',s.outbox.oldest_pending_at?time(s.outbox.oldest_pending_at):'无'],
      ['ClickHouse',s.clickhouse.available?'正常':'暂时不可用，事件仍保留'],['ClickHouse 存储',bytes(s.clickhouse.bytes)],['事件明细',number(s.clickhouse.events)],['最近统计事件',s.clickhouse.last_event_at??'—'],
      ['待处理 / 重试中失败',`${s.failures.open} / ${s.failures.retrying}`],['等待保留证据',number(s.failures.evidence_pending)],['等待 / 失败重放',`${s.replays.pending} / ${s.replays.failed}`],
    ]}/><p className="inset"><Link to="/failures">查看失败处理 →</Link></p></Panel>
    <Panel title="数据保留"><Fields rows={[
      ['PG 历史详情',`${s.retention.pg_days} 天；归档后压缩，保留恢复与幂等身份`],['ClickHouse 事件明细',`${s.retention.events_days} 天`],['小时 / 日汇总','长期保留'],['失败证据',`${s.retention.evidence_days} 天`],['运行日志',`${s.retention.loki_days} 天`],
      ['最近清理',s.maintenance.last_at?time(s.maintenance.last_at):'尚未运行'],['最近清理数量',s.maintenance.result?Object.entries(s.maintenance.result).map(([k,v])=>`${k}: ${v}`).join(' · '):'—'],
    ]}/></Panel><p className="fine-print">当前频道、视频和评论对象引用持续保留。只有已归档且不再影响执行、恢复的历史详情才参与清理。</p>
  </>}</ResourceView></>;
}
