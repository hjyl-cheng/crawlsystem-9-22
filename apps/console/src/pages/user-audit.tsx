import {useState} from 'react';
import type {ConsoleAuditEntry} from '../../../../packages/contracts/src/console-audit.ts';
import {useAuth} from '../auth.js';
import {useResource} from '../resource.js';
import {Empty} from '../ui.js';
const outcomes={PENDING:'结果待确认',SUCCESS:'成功',REJECTED:'已拒绝',FAILED:'失败'};
const kinds={LOGIN:'登录',LOGOUT:'退出',COMMAND:'业务操作',ACCOUNT:'账号维护'};
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{hour12:false});
function action(e:ConsoleAuditEntry){
  if(e.kind==='LOGIN'||e.kind==='LOGOUT')return kinds[e.kind];
  const cli:Record<string,string>={'account.add':'新建账号','account.import':'导入账号','account.set_password':'修改密码','account.disable':'停用账号','account.enable':'启用账号'};
  if(cli[e.action])return cli[e.action];
  const route=e.action.replace(/^\S+ /,'');
  const labels:Record<string,string>={'/v1/config':'发布配置','/v1/plans':'创建采集计划','/v1/plans/:id/cancel':'取消采集计划','/v1/channels/import':'导入频道','/v1/channels/:id/management':'修改频道策略','/v1/channels/:id/clock-override':'修改更新时间','/v1/channels/:id/update':'触发频道更新','/v1/queries':'添加搜索词','/v1/queries/:id':'修改搜索词','/v1/candidates/:id':'处理候选频道','/v1/workers/:id/pause':'暂停 Worker','/v1/workers/:id/drain':'排空 Worker','/v1/workers/:id/resume':'恢复 Worker','/v1/proxies/import':'导入代理','/v1/proxies/:id':'修改代理','/v1/proxies/:id/delete':'删除代理','/v1/deliveries/:id/retry':'重试交付','/v1/failures/:id/commands':'处理失败任务'};
  return labels[route]??e.action;
}
export function AuditHistory({actor,kind,compact=false}:{actor?:string;kind?:string;compact?:boolean}){
  const {api}=useAuth();
  const [event,setEvent]=useState(kind??''),[outcome,setOutcome]=useState(''),[days,setDays]=useState('7'),[cursors,setCursors]=useState<string[]>(['']);
  const cursor=cursors.at(-1)!;
  const key=JSON.stringify({actor,event,outcome,days,cursor});
  const resource=useResource('audit:'+key,signal=>api.consoleAudit({days,...(actor?{actor}:{}),...(event?{kind:event}:{}),...(outcome?{outcome}:{}),...(cursor?{cursor}:{})},signal),true,30_000);
  const reset=()=>setCursors(['']);
  return <div className={`audit-history ${compact?'compact':''}`}>
    {!compact&&<div className="audit-filters">
      <label>记录类型<select aria-label="记录类型" value={event} onChange={e=>{setEvent(e.target.value);reset();}}><option value="">全部记录</option>{Object.entries(kinds).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label>操作结果<select aria-label="操作结果" value={outcome} onChange={e=>{setOutcome(e.target.value);reset();}}><option value="">全部结果</option>{Object.entries(outcomes).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label>时间范围<select aria-label="审计时间范围" value={days} onChange={e=>{setDays(e.target.value);reset();}}><option value="1">近 24 小时</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option></select></label>
      <button className="button small" onClick={resource.refresh}>刷新记录</button>
    </div>}
    {resource.error&&<div role="alert" className="notice warning">{resource.error.message}<button className="link-button" onClick={resource.refresh}>重试</button></div>}
    {resource.data?<>
      <div className="table-scroll"><table><thead><tr><th>时间</th>{!compact&&<th>操作者</th>}<th>操作</th><th>对象</th><th>结果</th></tr></thead>
        <tbody>{resource.data.items.map(e=><tr key={e.audit_id}><td>{time(e.occurred_at)}</td>{!compact&&<td title={e.actor}>{e.username??e.actor}</td>}<td title={e.action}>{action(e)}</td><td className="audit-target" title={e.target??''}>{e.target??'—'}</td><td><span title={`请求 ${e.request_id??'—'}${e.command_id?' · 命令 '+e.command_id:''}`} className={`audit-outcome ${e.outcome.toLowerCase()}`}>{outcomes[e.outcome]}{e.http_status&&e.http_status>=400?' · '+e.http_status:''}</span></td></tr>)}
        {!resource.data.items.length&&<tr><td colSpan={compact?4:5} className="no-match">此范围内暂无记录</td></tr>}</tbody></table></div>
      <div className="audit-pager"><span>自 {time(resource.data.history_since)} 起留存</span><div><button className="button small" disabled={cursors.length===1} onClick={()=>setCursors(v=>v.slice(0,-1))}>上一页</button><span>第 {cursors.length} 页</span><button className="button small" disabled={!resource.data.next_cursor} onClick={()=>setCursors(v=>[...v,resource.data!.next_cursor!])}>下一页</button></div></div>
    </>:!resource.error&&<Empty title="正在读取记录…"/>}
  </div>;
}
