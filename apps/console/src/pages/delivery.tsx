import {useState,useRef} from 'react';
import {Link} from 'react-router';
import type {DeliveryRecord} from '../../../../packages/contracts/src/delivery.ts';
import {useAuth} from '../auth.js';
import {useResource} from '../resource.js';
import {ApiFailure} from '../api.js';
import {Badge,Empty,ErrorBox,Fields,PageHeading,Panel,Pagination,ResourceView,usePagination} from '../ui.js';
import {channelPath,planPath,time,number} from '../presentation.js';
import './analytics.css';
const states={PENDING:'待业务确认',DELIVERED:'已交付',FAILED:'交付失败',NOT_READY:'未达发布条件',UNCHANGED:'资料无变化'} as const;
const reasons:Record<string,string>={required_data_not_finalized:'频道资料、视频或画像尚未完整定稿',plan_not_completed:'采集计划尚未完成',source_observation_not_finalized:'当前资料包含尚未完成或失败采集的数据，等待完整采集恢复',initial_window_scope_incomplete:'缺少完整的首次视频窗口采集',waiting_gap:'等待前一个数据版本'};
function Detail({id,onChanged}:{id:string;onChanged:()=>void}) {
 const {api,session}=useAuth(),resource=useResource(`delivery:${id}`,signal=>api.delivery(id,signal),true,15000);
 const [reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<ApiFailure>(),command=useRef<{key:string;id:string}|undefined>(undefined);
 async function retry(row:DeliveryRecord){const key=row.delivery_id+':'+reason.trim();if(command.current?.key!==key)command.current={key,id:crypto.randomUUID()};setBusy(true);setError(undefined);try{await api.retryDelivery(row.delivery_id,{command_id:command.current.id,reason:reason.trim()});setReason('');command.current=undefined;resource.refresh();onChanged();}catch(e){setError(e instanceof ApiFailure?e:new ApiFailure('重发失败'));}finally{setBusy(false);}}
 return <Panel title="交付详情"><ResourceView resource={resource}>{r=><>
  <Fields rows={[
   ['频道',<Link to={channelPath(r.channel_id)}>{r.title??r.channel_id}</Link>],['数据版本',`r${r.revision}`],['状态',states[r.status]],['交付目标',r.target],['定稿时间',time(r.created_at)],['业务回执时间',time(r.received_at)],['交付内容',r.domains.map(d=>({channel:'频道资料',video:'视频资料',agent:'Agent 画像'}[d])).join('、')||'无变更'],['原因',r.error_code?(reasons[r.error_code]??r.error_code):'—'],['采集计划',r.plan_id?<Link to={planPath(r.plan_id)}>查看计划</Link>:'首次导入或下线'],['业务批次',typeof r.receipt?.business_batch_id==='string'?r.receipt.business_batch_id:'—'],['发送次数',String(r.attempts)]
  ]}/>
  {session.role==='operator'&&['PENDING','FAILED'].includes(r.status)&&<form onSubmit={e=>{e.preventDefault();void retry(r);}}><label>重发原因<input aria-label="重发原因" minLength={3} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} required/></label><button className="button" disabled={busy||reason.trim().length<3}>{busy?'正在提交…':'重发原版本'}</button></form>}
  {error&&<ErrorBox error={error}/>}</>}</ResourceView></Panel>;
}
export default function Delivery() {
 const {api}=useAuth(),paging=usePagination(),status=paging.params.get('status')??'',search=paging.params.get('search')??'',selected=paging.params.get('delivery')??'';
 const summary=useResource('delivery-summary',signal=>api.deliverySummary(signal),true,15000),resource=useResource(`deliveries:${paging.cursor}:${status}:${search}`,signal=>api.deliveries(signal,status,search,paging.cursor),true,15000);
 function filter(key:string,value:string){const p=new URLSearchParams(paging.params);p.delete('cursor');if(value)p.set(key,value);else p.delete(key);paging.setParams(p);}
 return <><PageHeading title="发布交付" description="将定稿的频道资料、视频与画像交付给业务系统，以业务表入库后的回执确认完成。"/>
 <Panel title="交付概况"><ResourceView resource={summary}>{s=><Fields rows={[
  ['交付目标',s.target??'尚未配置'],['自动交付',s.enabled?'已启用':'未启用'],['待业务确认',number(s.pending)],['今日已交付',number(s.delivered_today)],['已交付总数',number(s.delivered)],['交付失败',number(s.failed)],['未达发布条件',number(s.not_ready)],['资料无变化',number(s.unchanged)]
 ]}/>}</ResourceView></Panel>
 <div className="analytics-filters"><label>交付状态<select aria-label="交付状态" value={status} onChange={e=>filter('status',e.target.value)}><option value="">全部</option>{Object.entries(states).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><label>搜索频道<input aria-label="搜索频道" value={search} maxLength={160} onChange={e=>filter('search',e.target.value)}/></label></div>
 <Panel title="交付记录"><ResourceView resource={resource}>{p=><>{p.items.length?<div className="table-scroll"><table><thead><tr><th>频道</th><th>版本</th><th>状态</th><th>定稿时间</th><th>业务回执</th><th>操作</th></tr></thead><tbody>{p.items.map(r=><tr key={r.delivery_id} className={selected===r.delivery_id?'highlight-row':''}><td><Link to={channelPath(r.channel_id)}>{r.title??r.channel_id}</Link><small>{r.channel_id}</small></td><td>r{r.revision}</td><td><Badge tone={r.status==='DELIVERED'?'green':r.status==='FAILED'?'red':'neutral'}>{states[r.status]}</Badge></td><td>{time(r.created_at)}</td><td>{time(r.received_at)}<small>{r.error_code?(reasons[r.error_code]??r.error_code):r.status==='DELIVERED'?'业务表入库完成':'—'}</small></td><td><button className="text-button" onClick={()=>filter('delivery',r.delivery_id)}>查看</button></td></tr>)}</tbody></table></div>:<Empty title="当前范围内没有交付记录"/>}<Pagination cursor={paging.cursor} next={p.next_cursor} count={p.items.length} go={paging.go}/></>}</ResourceView></Panel>
 {selected&&<Detail key={selected} id={selected} onChanged={()=>{resource.refresh();summary.refresh();}}/>}</>;
}
