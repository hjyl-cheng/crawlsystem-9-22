import {useState} from 'react';
import {Link} from 'react-router';
import type {Analytics,FieldStatus} from '@crawlsystem/contracts/analytics';
import type {StorageCapacity} from '../../../../packages/contracts/src/storage-capacity.ts';
import {useAuth} from '../auth.js';
import {useResource} from '../resource.js';
import {Badge,Empty,Fields,PageHeading,Panel,ResourceView} from '../ui.js';
import {number,time,failureCodeLabels} from '../presentation.js';
import './analytics.css';
const domainLabels:Record<string,string>={ABOUT:'频道资料',VIDEO:'视频',AGENT:'画像',SAMPLING:'统计重采样',TARGETS:'视频目录'};
const statusLabels:Record<string,string>={APPLIED:'已入库',PARTIAL:'部分字段待解析',UNAVAILABLE:'视频不可访问'};
const bytes=(n:number|null)=>n===null?'—':`${(n/1024/1024).toFixed(2)} MiB`;
const capacityBytes=(n:number|null)=>n===null?'未知':n>=1024**3?`${(n/1024**3).toFixed(2)} GiB`:`${(n/1024**2).toFixed(2)} MiB`;
const capacityStates={ok:'容量正常',warning:'容量预警',critical:'容量严重',unknown:'用量未知'};
function ObjectCapacity({data}:{data:StorageCapacity}){
  return <>{!data.available&&<div className="notice warning">部分容量指标暂不可用或扫描数据已过期，请核对监控；未知用量不会计为 0。</div>}
    <div className="storage-buckets">{data.buckets.map(b=><section key={b.bucket} className={'storage-bucket '+b.state} aria-label={b.label+'容量'}>
      <header><h3>{b.label}</h3><Badge tone={b.state==='critical'?'red':b.state==='warning'?'amber':b.state==='ok'?'green':'neutral'}>{capacityStates[b.state]}</Badge></header>
      <small>{b.bucket}</small><strong>{capacityBytes(b.used_bytes)} <span>/ {capacityBytes(b.quota_bytes)}</span></strong>
      {b.used_percent===null?<p>等待有效用量指标</p>:<><progress max="100" value={Math.min(100,b.used_percent)} aria-label={b.label+'配额使用率'}/><p>已用 {b.used_percent.toFixed(1)}% · 配额剩余 {capacityBytes(b.remaining_bytes)}</p></>}
      <p>对象数 {b.objects===null?'未知':number(b.objects)} · {b.bucket==='crawl-raw'?'成功完成并入库后保留 1 天；处理中、待重试及失败原件受保护':`保留规则 ${b.retention_days} 天`}</p>
    </section>)}</div>
    <p className="fine-print inset">磁盘可用 {capacityBytes(data.disk.free_bytes)} / 总容量 {capacityBytes(data.disk.total_bytes)}，与同节点其他服务共享；桶配额剩余不等于独占磁盘余量。</p>
    <p className="fine-print inset">容量预警 {data.warning_percent}% · 严重告警 {data.critical_percent}% · {data.sampled_at?'指标采样 '+time(data.sampled_at):'尚无有效采样'} · {data.scan_age_seconds===null?'扫描时间未知':`扫描数据距今约 ${Math.ceil(data.scan_age_seconds/60)} 分钟`}。原始响应按任务状态分批清理，解析结果与失败证据由生命周期清理；容量统计稍有延迟。</p>
  </>;
}
export function TrendChart({data}:{data:Analytics}) {
  const max=Math.max(1,...data.trend.map(d=>d.videos+d.about+d.agent));
  return data.trend.length?<div className="analytics-trend" role="img" aria-label="每日采集趋势">{data.trend.map(d=><div className="trend-day" key={d.at} title={`${d.at.slice(0,10)}：视频 ${d.videos}、资料 ${d.about}、画像 ${d.agent}；完成 ${d.completed}、失败 ${d.failed}`}><strong>{number(d.collected)}</strong><div className="trend-track"><div className="trend-bar" style={{height:`${Math.max(2,(d.videos+d.about+d.agent)/max*100)}%`}}><i style={{flex:d.videos||0,background:'var(--blue,#3b82f6)'}}/><i style={{flex:d.about||0,background:'#22c55e'}}/><i style={{flex:d.agent||0,background:'#a855f7'}}/></div></div><small>{d.at.slice(5,10)}</small></div>)}</div>:<Empty title="这段时间没有采集事件"/>;
}
export function OverviewTrends({days=7}:{days?:number}) {
  const {api}=useAuth(),r=useResource(`overview-analytics:${days}`,signal=>api.analytics(days,signal),true,30000);
  return <Panel title={`采集趋势 · ${days===1?'今天（UTC）':`近${days}天`}`} className="trend-panel" extra={<Link to="/analytics">查看统计 →</Link>}><ResourceView resource={r} showMeta={false}>{d=><TrendChart data={d}/>}</ResourceView></Panel>;
}
const fieldLabels:Record<FieldStatus['fields'][number]['field'],string>={view_count:'播放数',like_count:'点赞数',comment_count:'评论数',duration_seconds:'时长',content_type:'内容类型'};
// Column order: resolved outcomes first, then what is still missing.
const fieldColumns:[string,string,(s:string)=>boolean][]=[['准确',"已从页面读到准确值",s=>s==='exact'],['估算','页面只给出缩写值（如 1.2K）',s=>s==='estimated'],
  ['按规则为零','空列表、预告或页面无计数时按旧规则记为 0',s=>s.startsWith('zero_from_')],['已关闭','频道关闭了点赞或评论',s=>s==='disabled'],
  ['不公开','页面不提供该值（如直播中）',s=>s==='unavailable'],['未解析','尚未拿到，等待重采或回填',s=>s==='unresolved']];
function FieldStatusPanel(){
  const {api}=useAuth(),r=useResource('field-status',signal=>api.fieldStatus(signal),true,600000);
  return <Panel title="视频字段解析状态（当前库）"><ResourceView resource={r}>{d=>{
    const fields=Object.keys(fieldLabels) as (keyof typeof fieldLabels)[];
    const cell=(f:string,match:(s:string)=>boolean)=>d.fields.filter(x=>x.field===f&&match(x.status)).reduce((n,x)=>n+x.count,0);
    return <><div className="table-scroll"><table><thead><tr><th>字段</th>{fieldColumns.map(([label,hint])=><th key={label} className="num" title={hint}>{label}</th>)}<th className="num">已解析比例</th></tr></thead>
      <tbody>{fields.map(f=>{const missing=cell(f,s=>s==='unresolved'),all=cell(f,()=>true);return <tr key={f}><td>{fieldLabels[f]}</td>
        {fieldColumns.map(([label,,match])=>{const n=cell(f,match);return <td key={label} className="num" style={label==='未解析'&&n?{color:'var(--warning, #b45309)',fontWeight:600}:undefined}>{n?number(n):'—'}</td>;})}
        <td className="num">{all?`${((all-missing)/all*100).toFixed(1)}%`:'—'}</td></tr>;})}</tbody></table></div>
      <p className="fine-print inset">可访问视频 {number(d.videos)} 个，不可访问 {number(d.unavailable_videos)} 个另计。评论数未解析的视频（90 天内）会在频道下次更新时补采首页评论，每次每频道最多 10 个。每 10 分钟统计一次，更新于 {time(d.observed_at)}。</p></>;
  }}</ResourceView></Panel>;
}
export default function AnalyticsPage({quality=false}:{quality?:boolean}) {
  const {api}=useAuth(),[days,setDays]=useState(7),resource=useResource(`analytics:${days}`,signal=>api.analytics(days,signal));
  return <><PageHeading title={quality?'质量分析':'采集统计'} description={quality?'跟踪可访问性和字段完整度，未知字段保留其真实状态。':'查看已入库采集量、计划结果和每日趋势。'}/>
    <div className="analytics-filters"><label>统计时间<select aria-label="统计时间" value={days} onChange={e=>setDays(Number(e.target.value))}><option value="1">今天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="180">最近 180 天</option></select></label><Link to={quality?'/analytics':'/quality'}>{quality?'采集统计':'质量分析'} →</Link></div>
    {quality && <FieldStatusPanel/>}
    <ResourceView resource={resource}>{d=><>{!quality && <div className="analytics-kpis">{[['视频入库',d.totals.videos],['资料入库',d.totals.about],['画像入库',d.totals.agent],['完成 / 失败计划',`${d.totals.completed} / ${d.totals.failed}`]].map(([label,value])=><section className="panel" key={label}><small>{label}</small><strong>{typeof value==='number'?number(value):value}</strong></section>)}</div>}
      {!quality && <Panel title="每日采集趋势"><TrendChart data={d}/><p className="fine-print inset">蓝色：视频 · 绿色：频道资料 · 紫色：画像</p></Panel>}
      {quality && <Panel title="近期采集结果（按事件）">{d.quality.length?<div className="table-scroll"><table><thead><tr><th>领域</th><th>结果</th><th>观察数</th><th>未解析字段 / 指标总数</th><th>字段完整率</th></tr></thead><tbody>{d.quality.map(row=><tr key={row.domain+row.status}><td>{domainLabels[row.domain]??row.domain}</td><td>{statusLabels[row.status]??row.status}</td><td>{number(row.count)}</td><td>{number(row.missing)} / {number(row.total)}</td><td>{row.total?`${((row.total-row.missing)/row.total*100).toFixed(1)}%`:'—'}</td></tr>)}</tbody></table></div>:<Empty title="尚无质量观察"/>}<p className="fine-print inset">质量观察包含上线时的存量快照；存量视频 {number(d.baseline)} 条单独记录，不计入新采集量。无法访问的视频单独列出。</p></Panel>}
      {!quality && <Panel title="失败原因">{d.failures.length?<div className="table-scroll"><table><thead><tr><th>原因</th><th>记录数</th></tr></thead><tbody>{d.failures.map(f=><tr key={f.code}><td><span title={f.code}>{failureCodeLabels[f.code]??f.code}</span></td><td>{number(f.count)}</td></tr>)}</tbody></table></div>:<Empty title="统计范围内没有失败"/>}<p className="inset"><Link to="/failures">进入失败处理 →</Link></p></Panel>}
      <p className="fine-print">统计来源：ClickHouse · 更新于 {time(d.observed_at)} · 原始采集 {bytes(d.totals.raw_bytes)}</p></>}</ResourceView></>;
}
export function StoragePage() {
  const {api}=useAuth(),r=useResource('storage',signal=>api.storage(signal)),capacity=useResource('storage-capacity',signal=>api.storageCapacity(signal),true,30000),retention=useResource('raw-retention',signal=>api.rawRetention(signal),true,30000);
  return <><PageHeading title="存储与流水线" description="查看对象容量、持久队列、统计入库和数据保留状态。"/>
    <Panel title="MinIO 容量"><ResourceView resource={capacity}>{d=><ObjectCapacity data={d}/>}</ResourceView></Panel>
    <Panel title="原始响应清理"><ResourceView resource={retention}>{d=><><Fields rows={[
      ['清理规则','成功完成且全部入库后保留 24 小时'],['等待 / 清理中',`${number(d.pending)} / ${number(d.leased)}`],
      ['已确认清理对象',number(d.deleted-d.missing)],['已确认删除大小',capacityBytes(d.deleted_bytes)],['原本已不存在',number(d.missing)],
      ['受阻对象',number(d.errors)],['最近清理',d.last_deleted_at?time(d.last_deleted_at):'尚未运行'],
    ]}/><p className="fine-print inset">处理中、待重试、未入库和未保存证据的数据保留。删除前确认解析结果及评论对象存在；失败原件和无法核验归属的对象继续保留。</p></>}</ResourceView></Panel>
    <ResourceView resource={r}>{s=><>
    <Panel title="入库与恢复"><Fields rows={[
      ['PostgreSQL 数据库大小',bytes(s.postgres_bytes)],['等待发布的统计事件',number(s.outbox.pending)],['等待归档的统计事件',number(s.outbox.unarchived)],['最早待归档事件',s.outbox.oldest_pending_at?time(s.outbox.oldest_pending_at):'无'],
      ['ClickHouse',s.clickhouse.available?'正常':'暂时不可用，事件仍保留'],['ClickHouse 存储',bytes(s.clickhouse.bytes)],['事件明细',number(s.clickhouse.events)],['最近统计事件',s.clickhouse.last_event_at?time(/[zZ]|[+-]\d\d:?\d\d$/.test(s.clickhouse.last_event_at)?s.clickhouse.last_event_at:s.clickhouse.last_event_at.replace(' ','T')+'Z'):'—'],
      ['待处理 / 重试中失败',`${s.failures.open} / ${s.failures.retrying}`],['等待保留证据',number(s.failures.evidence_pending)],['等待 / 失败重放',`${s.replays.pending} / ${s.replays.failed}`],
    ]}/><p className="inset"><Link to="/failures">查看失败处理 →</Link></p></Panel>
    <Panel title="数据保留"><Fields rows={[
      ['PG 历史详情',`${s.retention.pg_days} 天；归档后压缩，保留恢复与幂等身份`],['ClickHouse 事件明细',`${s.retention.events_days} 天`],['小时 / 日汇总','长期保留'],['失败证据',`${s.retention.evidence_days} 天`],['运行日志',`${s.retention.loki_days} 天`],
      ['最近清理',s.maintenance.last_at?time(s.maintenance.last_at):'尚未运行'],['最近清理数量',s.maintenance.result?Object.entries(s.maintenance.result).map(([k,v])=>`${({units:'原件',events:'事件',failures:'失败记录'} as Record<string,string>)[k]??k} ${v}`).join(' · '):'—'],
    ]}/></Panel><p className="fine-print">当前频道、视频和评论对象引用持续保留。只有已归档且不再影响执行、恢复的历史详情才参与清理。</p>
  </>}</ResourceView></>;
}
