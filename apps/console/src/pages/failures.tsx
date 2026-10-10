import {useState,useRef} from 'react';
import {Link} from 'react-router';
import type {Failure,FailureCommand} from '@crawlsystem/contracts/analytics';
import {useAuth} from '../auth.js';
import {useResource} from '../resource.js';
import {ApiFailure} from '../api.js';
import {Badge,Empty,ErrorBox,Fields,PageHeading,Panel,Pagination,ResourceView,usePagination} from '../ui.js';
import {planPath,channelPath,time,number} from '../presentation.js';
import './analytics.css';
const states={OPEN:'待处理',RETRYING:'重试中',RESOLVED:'已恢复',IGNORED:'已忽略'} as const;
function Detail({id,onChanged}:{id:string;onChanged:()=>void}) {
  const {api,session}=useAuth(),detail=useResource(`failure:${id}`,signal=>api.failure(id,signal)),evidence=useResource(`failure-evidence:${id}`,signal=>api.failureEvidence(id,signal));
  const [action,setAction]=useState<FailureCommand['action']>('retry'),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<ApiFailure>();
  const command=useRef<{key:string;id:string}|undefined>(undefined);
  async function submit(f:Failure) {
    const key=`${f.failure_id}:${f.version}:${action}:${reason.trim()}`;
    if(command.current?.key!==key)command.current={key,id:crypto.randomUUID()};
    setBusy(true);setError(undefined);
    try {await api.failureCommand(f.failure_id,{command_id:command.current.id,expected_version:f.version,action,reason:reason.trim()});setReason('');command.current=undefined;detail.refresh();onChanged();}
    catch(e){setError(e instanceof ApiFailure?e:new ApiFailure('操作失败'));}finally{setBusy(false);}
  }
  return <Panel title="失败详情"><ResourceView resource={detail}>{f=><>
    <Fields rows={[
      ['阶段 / 原因',`${f.stage} · ${f.code}`],['状态',states[f.state]],['首次发生',time(f.first_at)],['最近发生',time(f.last_at)],
      ['发生次数 / 尝试',`${f.occurrences} / ${f.attempts}`],['重试时间',f.retry_at?time(f.retry_at):'—'],['恢复时间',f.resolved_at?time(f.resolved_at):'—'],
      ['计划',f.plan_id?<Link to={planPath(f.plan_id)}>查看原计划</Link>:'—'],['重试计划',f.retry_plan_id?<Link to={planPath(f.retry_plan_id)}>查看重试计划</Link>:'—'],
      ['频道',f.channel_id?<Link to={channelPath(f.channel_id)}>{f.channel_id}</Link>:'—'],['执行代次 / 单元',`${f.execution_epoch??'—'} · ${f.step||'—'} / ${f.unit_id||'—'}`],
      ['处理备注',f.reason??'—'],['处理人',f.decided_by??'—'],['证据',({PENDING:'正在保留',SAVED:'已保留 90 天',MISSING:'原对象已不存在',NONE:'仅失败元数据'})[f.evidence_state]],
    ]}/>
    {session?.role==='operator' && f.state==='OPEN' && <form className="failure-action" onSubmit={e=>{e.preventDefault();void submit(f);}}>
      <label>处理方式<select aria-label="处理方式" value={action} onChange={e=>setAction(e.target.value as FailureCommand['action'])}><option value="retry" disabled={!f.retryable}>重试</option><option value="ignore">忽略</option></select></label>
      <label>处理原因<input aria-label="处理原因" value={reason} onChange={e=>setReason(e.target.value)} minLength={3} maxLength={300} required placeholder="说明重试或忽略的原因"/></label>
      <button className="button primary" disabled={busy||reason.trim().length<3||action==='retry'&&!f.retryable}>{busy?'正在提交…':'提交处理'}</button>
      {f.retry_blocked_reason && <p className="fine-print">{f.retry_blocked_reason}</p>}
      {error && <ErrorBox error={error} refresh={()=>detail.refresh()}/>}
    </form>}
    <ResourceView resource={evidence}>{e=><div className="evidence-preview"><p>{e.note}</p>{e.available && <><p><code>{e.sha256}</code> · {number(e.bytes)} 字节</p><div className="table-scroll"><table><thead><tr><th>响应地址</th><th>状态</th><th>大小</th></tr></thead><tbody>{e.responses.map((r,i)=><tr key={i}><td>{r.method} {r.endpoint}</td><td>{r.status}</td><td>{number(r.bytes)} 字节</td></tr>)}</tbody></table></div></>}</div>}</ResourceView>
  </>}</ResourceView></Panel>;
}
export default function Failures() {
  const {api}=useAuth(),paging=usePagination(),state=paging.params.get('state')??'',selected=paging.params.get('failure');
  const resource=useResource(`failures:${paging.cursor}:${state}`,signal=>api.failures(paging.cursor,state,signal));
  function filter(value:string){const p=new URLSearchParams(paging.params);p.delete('cursor');p.delete('failure');if(value)p.set('state',value);else p.delete('state');paging.setParams(p);}
  return <><PageHeading title="失败处理" description="查看采集、解析和入库失败，保留证据并跟踪重试结果。"><Link className="button" to="/errors">错误与追踪</Link></PageHeading>
    <div className="analytics-filters"><label>处理状态<select aria-label="处理状态" value={state} onChange={e=>filter(e.target.value)}><option value="">全部</option>{Object.entries(states).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
    <Panel title="失败记录"><ResourceView resource={resource}>{page=><>{page.items.length?<div className="table-scroll"><table><thead><tr><th>阶段 / 原因</th><th>状态</th><th>次数 / 尝试</th><th>首次 / 最近发生</th><th>对象</th><th>处理</th></tr></thead><tbody>{page.items.map(f=><tr key={f.failure_id} className={selected===f.failure_id?'highlight-row':''}><td>{f.stage}<small>{f.code}</small></td><td><Badge tone={f.state==='OPEN'?'red':f.state==='RESOLVED'?'green':'neutral'}>{states[f.state]}</Badge></td><td>{f.occurrences} / {f.attempts}</td><td>{time(f.first_at)}<small>{time(f.last_at)}</small></td><td>{f.channel_id??f.run_id??'无有效对象引用'}<small>{f.step} / {f.unit_id}</small></td><td><button className="text-button" onClick={()=>{const p=new URLSearchParams(paging.params);p.set('failure',f.failure_id);paging.setParams(p);}}>查看并处理</button></td></tr>)}</tbody></table></div>:<Empty title="当前范围内没有失败记录"/>}<Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/></>}</ResourceView></Panel>
    {selected && <Detail key={selected} id={selected} onChanged={resource.refresh}/>}</>;
}
