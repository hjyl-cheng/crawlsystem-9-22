import {useEffect,useState,useRef,type ReactNode,type FormEvent} from 'react';
import {Link} from 'react-router';
import {Activity,Bot,Cpu,Pause,Play,Search,Server,Unplug} from 'lucide-react';
import type {Worker} from '@crawlsystem/contracts';
import type {WorkerMetrics,WorkerControl,WorkerCommand} from '../../../../packages/contracts/src/workers.ts';
import {useAuth} from '../auth.js';
import {useResource} from '../resource.js';
import {Empty,Pagination,ResourceView,usePagination} from '../ui.js';
import {planPath,shortId,time} from '../presentation.js';
import LineChart from '../components/line-chart.js';
import './overview.css';import './discover.css';import './workers.css';

const states:Record<WorkerControl['status'],string>={UNSUPPORTED:'需要升级',OFFLINE:'失联',PENDING:'等待 Worker 确认',RUNNING:'接单中',PAUSED:'已暂停接单',DRAINING:'排空中',DRAINED:'已排空'};
const status=(w:Worker)=>w.control?states[w.control.status]:w.stale?'失联':w.accepting_work?'接单中':'停止接单';
const pct=(v:number|null|undefined)=>v==null?'—':v.toFixed(1)+'%';
const mib=(v:number|null|undefined)=>v==null?'—':(v/1048576).toFixed(0)+' MiB';
const cores=(v:number|null|undefined)=>v==null?'—':v.toFixed(2)+' 核';
const memoryPct=(m?:{memory_used_bytes:number|null;memory_total_bytes:number|null})=>m?.memory_used_bytes!=null&&m.memory_total_bytes?m.memory_used_bytes/m.memory_total_bytes*100:null;
const hour=(at:string)=>new Date(at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
function Card({title,subtitle,className='',children}:{title:string;subtitle?:string;className?:string;children:ReactNode}){return <section className={'panel discover-card '+className}><div className="panel-heading"><div><h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div></div>{children}</section>;}
function Kpi({label,icon,value,foot}:{label:string;icon:ReactNode;value:ReactNode;foot:ReactNode}){return <section className="panel discover-kpi tone-blue"><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong><span className="kpi-foot">{foot}</span></div></section>;}
const Row=({label,children}:{label:string;children:ReactNode})=><div className="kv-row"><dt>{label}</dt><dd>{children}</dd></div>;

function Detail({worker,metrics,refresh}:{worker?:Worker;metrics?:WorkerMetrics;refresh:()=>void}){
 const {api,session}=useAuth(),[action,setAction]=useState<'pause'|'drain'|'resume'>(),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [submittedVersion,setSubmittedVersion]=useState<number>();
 const pending=useRef<{action:string;command:WorkerCommand}|undefined>(undefined);
 useEffect(()=>{setAction(undefined);setReason('');setNotice('');},[worker?.worker_id]);
 if(!worker)return <section className="panel worker-detail"><Empty title="选择 Worker 查看详情">等待执行节点登记。</Empty></section>;
 const control=worker.control,enabled=session.role==='operator'&&!worker.stale&&control&&control.status!=='UNSUPPORTED';
 const plans=control?.active_plan_ids??worker.running_plan_ids,queries=control?.active_query_run_ids??worker.running_query_run_ids??[];
 const labels={pause:'暂停接单',drain:'排空',resume:'恢复接单'};
 async function submit(event:FormEvent){event.preventDefault();if(!action||!control||!worker||busy)return;setBusy(true);setNotice('');
  const command=pending.current?.action===action&&pending.current.command.reason===reason.trim()?pending.current.command:{command_id:crypto.randomUUID(),expected_version:control.version,reason:reason.trim()};pending.current={action,command};
  try{const response=await api.workerCommand(worker.worker_id,action,command);setSubmittedVersion(response.control?.version);pending.current=undefined;setNotice('命令已保存，等待 Worker 心跳确认。');setAction(undefined);setReason('');refresh();}
  catch(e){if((e as {status?:number}).status===409)pending.current=undefined;setNotice(e instanceof Error?e.message:'命令未确认，请刷新状态后重试。');refresh();}finally{setBusy(false);}
 }
 return <section className="panel worker-detail">
  <header className="detail-head"><span className={'live-dot '+(worker.stale?'off':'')}/><div><b className="mono">{worker.worker_id}</b><small>{status(worker)} · {time(worker.last_heartbeat_at)}</small></div></header>
  <div className="detail-body"><dl>
   <Row label="服务器"><span className="mono">{worker.server_id}</span></Row><Row label="版本"><span className="mono worker-build">{worker.build_version}</span></Row><Row label="并发容量">{worker.capacity}</Row>
   <Row label="接单状态">{status(worker)}</Row><Row label="控制版本">{control?`v${control.version} · 已确认 v${control.applied_version}`:'尚未上报'}</Row>
   {control?.reason&&<Row label="变更原因">{control.reason}</Row>}
   <Row label="服务器 CPU">{pct(metrics?.node.cpu_percent)}</Row><Row label="服务器内存">{pct(memoryPct(metrics?.node))}</Row>
   <Row label="Worker CPU">{cores(metrics?.process?.cpu_cores)}</Row><Row label="Worker 内存">{mib(metrics?.process?.rss_bytes)}</Row>
  </dl><p className="detail-note">服务器指标来自 Prometheus；Worker CPU 是进程使用的核数，内存是常驻内存，不含浏览器网关。</p>
  {worker.collector&&<><h3>网页采集</h3><dl><Row label="指纹网关">{worker.collector.gateway==='ready'?'正常':'不可用'} · {worker.collector.browser}</Row><Row label="近一小时">{worker.collector.requests_last_hour} 请求 · {worker.collector.blocked_last_hour} 被拦</Row><Row label="代理出口">租用 {worker.collector.active_leases} · 巴西 {worker.collector.compliant_leases}</Row><Row label="语言 / 地区">{worker.collector.language} / {worker.collector.country}</Row><Row label="时区">{worker.collector.timezone}</Row><Row label="最近档案">{worker.collector.last_profile?.profile_id??'尚未采集'}</Row></dl></>}
  <h3>已接入的计划 · {plans.length}</h3>{plans.length?<ul className="plan-links">{plans.map(id=><li key={id}><Link className="mono" to={planPath(id)}>{shortId(id)}</Link></li>)}</ul>:<p className="detail-note">没有未完成的已分配计划。</p>}
  <h3>执行中的搜索 · {queries.length}</h3>{queries.length?<ul className="plan-links">{queries.map(id=><li className="mono" key={id}>{shortId(id)}</li>)}</ul>:<p className="detail-note">没有正在执行的搜索。</p>}
  {!!control?.legacy_pending&&<p className="notice">仍有 {control.legacy_pending} 个旧队列计划待确认归属，排空会等待其结束。</p>}
  {notice&&<p role="status" className="notice">{notice==='命令已保存，等待 Worker 心跳确认。'&&submittedVersion&&control&&control.applied_version>=submittedVersion?`控制版本 v${control.applied_version} 已确认 · ${status(worker)}`:notice}</p>}
  {action&&<form onSubmit={submit} className="worker-command"><b>{labels[action]}</b><p>{action==='resume'?'重新允许分配计划和领取搜索任务。':'停止新增计划和搜索；已接入的任务继续完成。'}{action==='drain'?'所有已接入任务结束后显示“已排空”。':''}</p><label htmlFor="worker-reason">操作原因</label><textarea id="worker-reason" value={reason} onChange={e=>setReason(e.target.value)} minLength={3} maxLength={500} required disabled={busy}/><div><button className="button small" type="submit" disabled={busy||reason.trim().length<3}>{busy?'提交中…':'确认'+labels[action]}</button><button className="button small" type="button" disabled={busy} onClick={()=>setAction(undefined)}>取消</button></div></form>}
  </div><footer className="detail-actions"><button className="button small" disabled={!enabled||busy||control?.desired==='PAUSED'} onClick={()=>setAction('pause')}><Pause size={13}/>暂停接单</button><button className="button small" disabled={!enabled||busy||control?.desired==='DRAINING'} onClick={()=>setAction('drain')}><Unplug size={13}/>排空</button><button className="button small" disabled={!enabled||busy||control?.desired==='RUNNING'} onClick={()=>setAction('resume')}><Play size={13}/>恢复接单</button></footer>
 </section>;
}

export default function Workers(){
 const {api}=useAuth(),paging=usePagination(),[selected,setSelected]=useState<string>(),[search,setSearch]=useState(''),[filter,setFilter]=useState('all'),[nodeFilter,setNodeFilter]=useState('all');
 const resource=useResource('workers:'+paging.cursor,signal=>api.workers(paging.cursor,20,signal));
 const real=resource.data?.items??[],current=selected??paging.params.get('highlight')??real[0]?.worker_id;
 const metrics=useResource('worker-metrics:'+current,signal=>current?api.workerMetrics(current,signal):Promise.resolve(undefined),true,15000);
 const nodes=useResource('worker-nodes',signal=>api.overviewResources(signal),true,15000);
 const serverIds=[...new Set(real.map(w=>w.server_id))],filtered=real.filter(w=>(w.worker_id+' '+w.server_id).toLowerCase().includes(search.toLowerCase())&&(nodeFilter==='all'||nodeFilter===w.server_id)&&(filter==='all'||filter==='online'&&!w.stale||filter==='offline'&&w.stale||filter==='paused'&&w.control?.desired!==undefined&&w.control.desired!=='RUNNING'));
 const busy=real.reduce((n,w)=>n+(w.control?.active_plan_ids??w.running_plan_ids).length+(w.control?.active_query_run_ids??w.running_query_run_ids??[]).length,0),m=metrics.data;
 const tasks=m?.tasks.map(t=>({x:hour(t.at),values:{plans:t.plans_completed,failed:t.plans_failed,queries:t.queries_completed,query_failed:t.queries_failed}}));
 const cpu=m?.resources.length?m.resources.map(p=>({x:hour(p.at),values:{cpu:p.cpu_cores}})):undefined;
 const mem=m?.resources.length?m.resources.map(p=>({x:hour(p.at),values:{mem:p.rss_bytes===null?null:p.rss_bytes/1048576}})):undefined;
 const refresh=()=>{resource.refresh();metrics.refresh();};
 return <div className="dashboard discover workers-page">
  <header className="dashboard-heading"><div><h1>Worker 管理</h1><p>接单控制、完整任务排空与真实资源指标</p>{resource.updatedAt&&<span className="data-freshness"><i/>心跳已同步 · {time(resource.updatedAt)}</span>}</div><button className="button small" onClick={refresh}>刷新 Worker</button></header>
  <div className="discover-kpis"><Kpi label="服务器" icon={<Server size={22}/>} value={serverIds.length} foot="按本页 Worker 登记"/><Kpi label="Worker" icon={<Bot size={22}/>} value={real.length} foot={`接单 ${real.filter(w=>w.control?.status==='RUNNING'&&!w.stale).length} · 失联 ${real.filter(w=>w.stale).length}`}/><Kpi label="未完成任务" icon={<Activity size={22}/>} value={busy} foot="已分配计划 + 执行中搜索"/><Kpi label="所选节点 CPU" icon={<Cpu size={22}/>} value={pct(m?.node.cpu_percent)} foot={m?.monitoring_available?`${m.server_id} · 内存 ${pct(memoryPct(m.node))}`:'等待服务器监控样本'}/></div>
  <div className="discover-row row-workers"><section className="panel worker-list"><div className="panel-heading"><h2>Worker</h2><small>筛选当前页</small></div>
   <div className="list-tools worker-filters"><label className="list-search" htmlFor="worker-search"><Search size={13}/><input id="worker-search" placeholder="搜索 Worker / 服务器…" value={search} onChange={e=>setSearch(e.target.value)}/></label><select aria-label="Worker 状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部状态</option><option value="online">在线</option><option value="offline">失联</option><option value="paused">已停止新增</option></select><select aria-label="Worker 服务器" value={nodeFilter} onChange={e=>setNodeFilter(e.target.value)}><option value="all">全部服务器</option>{serverIds.map(s=><option key={s} value={s}>{s}</option>)}</select></div>
   <ResourceView resource={resource}>{page=><>{filtered.length?<div className="table-scroll"><table><thead><tr><th>Worker</th><th>状态</th><th>服务器</th><th className="num">容量</th><th className="num">计划 / 搜索</th><th>最后心跳</th><th>Worker CPU / 内存</th></tr></thead><tbody>{filtered.map(w=><tr key={w.worker_id} className={w.worker_id===current?'selected':''} aria-selected={w.worker_id===current}><td><button className="worker-select mono" onClick={()=>setSelected(w.worker_id)}>{w.worker_id}</button></td><td><span className={'status-chip '+(w.stale?'red':w.control?.status==='RUNNING'?'green':'amber')}>{status(w)}</span></td><td className="mono">{w.server_id}</td><td className="num">{w.capacity}</td><td className="num">{(w.control?.active_plan_ids??w.running_plan_ids).length} / {(w.control?.active_query_run_ids??w.running_query_run_ids??[]).length}</td><td>{time(w.last_heartbeat_at)}</td><td>{cores(w.stale?null:w.process?.cpu_cores)} / {mib(w.stale?null:w.process?.rss_bytes)}</td></tr>)}</tbody></table></div>:<Empty title="没有匹配的 Worker">等待节点登记，或调整筛选条件。</Empty>}<Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/></>}</ResourceView>
   </section><Detail key={current} worker={real.find(w=>w.worker_id===current)} metrics={m} refresh={refresh}/></div>
  <div className="discover-row row-servers"><Card title="服务器资源" subtitle="Prometheus 节点指标 · 当前页登记的服务器" className="span-2">{serverIds.length?<div className="table-scroll"><table><thead><tr><th>服务器</th><th>在线 Worker</th><th>CPU</th><th>内存</th></tr></thead><tbody>{serverIds.map(s=>{const n=nodes.data?.monitoring.nodes.find(n=>n.server_id===s);return <tr key={s}><td className="mono">{s}</td><td>{real.filter(w=>w.server_id===s&&!w.stale).length}</td><td>{pct(n?.cpu_percent)}</td><td>{pct(memoryPct(n))}</td></tr>;})}</tbody></table></div>:<Empty title="暂无服务器">等待 Worker 登记。</Empty>}</Card>
   <Card title="任务执行趋势" subtitle={`${current??'所选 Worker'} · 近 24 小时终态任务`}><LineChart points={tasks} series={[{key:'plans',label:'计划成功',color:'#277cf7'},{key:'failed',label:'计划失败',color:'#c96a12'},{key:'queries',label:'搜索成功',color:'#0f9f75'},{key:'query_failed',label:'搜索失败',color:'#9738bd'}]} max={Math.max(1,...(tasks?.flatMap(t=>Object.values(t.values))??[]))*1.15} empty={metrics.error?'趋势读取失败，请刷新':'等待任务趋势'} label="所选 Worker 近 24 小时任务趋势"/></Card>
   <Card title="Worker 资源趋势" subtitle="近 24 小时 · 每 5 分钟平均" className="process-trends"><small>CPU 使用核数</small><LineChart points={cpu} series={[{key:'cpu',label:'CPU 核数',color:'#277cf7'}]} max={Math.max(1,...(cpu?.map(p=>p.values.cpu??0)??[]))*1.15} format={v=>v.toFixed(2)} empty="等待 Worker 进程样本" label="Worker 进程 CPU 核数趋势"/><small>常驻内存 MiB</small><LineChart points={mem} series={[{key:'mem',label:'常驻内存',color:'#c96a12'}]} max={Math.max(1,...(mem?.map(p=>p.values.mem??0)??[]))*1.15} format={v=>v.toFixed(0)} empty="等待 Worker 进程样本" label="Worker 进程常驻内存趋势"/></Card>
  </div><footer className="dashboard-foot"><span>暂停与排空停止新增任务，已接入任务继续完成。状态以服务端任务记录和 Worker 确认为准。</span><span>{metrics.error?'资源读取失败，请刷新':m?'资源采样 '+time(m.sampled_at):'等待采样'}</span></footer>
 </div>;
}
