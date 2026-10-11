import {useMemo,useRef,useState} from 'react';
import {CircleCheck,Clock,RefreshCw,RotateCcw,Search,Settings2,TriangleAlert} from 'lucide-react';
import {CONFIG_CATALOG,changedSettings,defaultSettings,settingValue,type ConfigKey,type ConfigValue,type ConfigSnapshot,type ConfigHistoryItem,type ConfigCommand} from '../../../../packages/contracts/src/configuration.ts';
import {useAuth} from '../auth.js';
import {useResource} from '../resource.js';
import {ApiFailure} from '../api.js';
import {Empty,ErrorBox,ResourceView} from '../ui.js';
import './overview.css';
import './discover.css';
import './config.css';

const show=(v:ConfigValue)=>Array.isArray(v)?(v.map(d=>({ABOUT:'频道资料',VIDEO:'视频与评论',AGENT:'Agent 画像'}[d])).join('、')||'无自动更新范围'):typeof v==='boolean'?(v?'开启':'关闭'):v.toLocaleString('zh-CN');
const time=(v:string|null)=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'环境初值';
const names={ABOUT:'频道资料',VIDEO:'视频与评论',AGENT:'Agent 画像'} as const;
function Detail({snapshot,selected,operator,previous,onDone}:{snapshot:ConfigSnapshot;selected:ConfigKey;operator:boolean;previous?:ConfigHistoryItem;onDone:()=>void}){
 const {api}=useAuth(),meta=CONFIG_CATALOG.find(m=>m[0]===selected)!;
 const [base,setBase]=useState(snapshot),[value,setValue]=useState<ConfigValue>(settingValue(snapshot.settings,selected));
 const [reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<ApiFailure>(),[message,setMessage]=useState('');
 const pending=useRef<ConfigCommand|undefined>(undefined);
 const stale=base.version!==snapshot.version,dirty=JSON.stringify(value)!==JSON.stringify(settingValue(base.settings,selected));
 const change=(next:ConfigValue)=>{setValue(next);setConfirmed(false);setMessage('');pending.current=undefined;};
 const reset=()=>{setBase(snapshot);change(settingValue(snapshot.settings,selected));setReason('');setError(undefined);};
 const submit=async()=>{
  try{changedSettings(base.settings,selected,value);}catch{setError(new ApiFailure('取值超出允许范围，或与其他配置冲突；请核对冷却上限和 API 预留。',400,'INVALID_REQUEST'));return;}
  setBusy(true);setError(undefined);setMessage('');
  const command=pending.current??{command_id:crypto.randomUUID(),expected_version:base.version,key:selected,value,reason:reason.trim(),confirm_risk:confirmed};
  pending.current=command;
  try{const next=await api.publishConfig(command);setBase(next);setValue(settingValue(next.settings,selected));setReason('');setConfirmed(false);pending.current=undefined;setMessage('配置已发布，版本 v'+next.version+'；后台服务将读取新版本。');onDone();}
  catch(e){setError(e instanceof ApiFailure?e:new ApiFailure('发布失败，请刷新核对。'));}
  finally{setBusy(false);}
 };
 return <section className="panel config-detail"><div className="panel-heading"><div><h2>配置详情</h2></div><span className={'status-chip '+(meta[4]==='high'?'red':'amber')}>{meta[4]==='high'?'高风险':'中风险'}</span></div>
  <header className="detail-head"><span className="config-icon"><Settings2 size={18}/></span><div><b>{meta[1]}</b><small className="mono">{selected}</small></div></header>
  <div className="detail-body"><dl>
   <div className="kv-row"><dt>分组</dt><dd>{meta[2]}</dd></div><div className="kv-row"><dt>当前值</dt><dd>{show(settingValue(snapshot.settings,selected))}</dd></div>
   <div className="kv-row"><dt>默认值</dt><dd>{show(settingValue(defaultSettings(),selected))}</dd></div><div className="kv-row"><dt>说明</dt><dd>{meta[5]}</dd></div>
   <div className="kv-row"><dt>编辑版本</dt><dd>v{base.version}</dd></div></dl>
   {stale&&<div className="notice warning" role="status">配置已更新到 v{snapshot.version}，请载入当前版本后重新编辑。<button className="text-button" disabled={busy} onClick={reset}>载入当前版本</button></div>}
   <h3>配置值</h3>
   <fieldset disabled={!operator||busy||stale} className="config-editor">
    {meta[3]==='boolean'?<select aria-label="配置值" value={String(value)} onChange={e=>change(e.target.value==='true')}><option value="true">开启</option><option value="false">关闭</option></select>
     :meta[3]==='domains'?<div className="config-domains">{(['ABOUT','VIDEO','AGENT'] as const).map(d=><label key={d}><input type="checkbox" checked={Array.isArray(value)&&value.includes(d)} onChange={e=>change(e.target.checked?[...(Array.isArray(value)?value:[]),d]:(Array.isArray(value)?value:[]).filter(v=>v!==d))}/>{names[d]}</label>)}</div>
     :<input aria-label="配置值" type="number" step="1" value={typeof value==='number'&&Number.isFinite(value)?value:''} onChange={e=>change(e.target.value===''?NaN:Number(e.target.value))}/>}
   </fieldset>
   <h3>变更说明</h3><textarea aria-label="变更说明" className="config-note" placeholder="请输入本次修改原因（3～200 字）" maxLength={200} value={reason} disabled={!operator||busy||stale} onChange={e=>{setReason(e.target.value);pending.current=undefined;}}/>
   {meta[4]==='high'&&<label className="config-confirm"><input type="checkbox" checked={confirmed} disabled={!operator||busy||stale} onChange={e=>{setConfirmed(e.target.checked);pending.current=undefined;}}/>我已核对变更前后值及影响范围</label>}
   {!operator&&<p className="notice">当前身份只读，可查看配置和变更记录。</p>}
   {message&&<p className="notice" role="status">{message}</p>}{error&&<ErrorBox error={error}/>}
  </div>
  <footer className="detail-actions"><button className="button small" disabled={!operator||busy||stale||!previous} onClick={()=>{change(previous!.before);setReason('回滚到上一条变更前的值');}}><RotateCcw size={13}/>载入上个值</button>
   <button className="button small" disabled={busy} onClick={reset}>放弃编辑</button>
   <button className="button small primary" disabled={!operator||busy||stale||!dirty||reason.trim().length<3||(meta[4]==='high'&&!confirmed)} onClick={()=>void submit()}>{busy?'正在发布…':'发布配置'}</button></footer>
 </section>;
}
export default function Config(){
 const {api,session}=useAuth(),config=useResource('configuration',s=>api.config(s),true,15000);
 const [cursor,setCursor]=useState('0'),history=useResource('configuration-history:'+cursor,s=>api.configHistory(cursor,s),true,15000);
 const [selected,setSelected]=useState<ConfigKey>('update.enabled'),[query,setQuery]=useState(''),[group,setGroup]=useState(''),[risk,setRisk]=useState('');
 const rows=useMemo(()=>CONFIG_CATALOG.filter(m=>(!query||(m[0]+' '+m[1]+' '+m[5]).toLowerCase().includes(query.trim().toLowerCase()))&&(!group||m[2]===group)&&(!risk||m[4]===risk)),[query,group,risk]);
 const refresh=()=>{config.refresh();history.refresh();};
 const groups=[...new Set(CONFIG_CATALOG.map(m=>m[2]))],high=CONFIG_CATALOG.filter(m=>m[4]==='high').length;
 return <div className="dashboard discover config-page"><header className="dashboard-heading"><div><h1>配置管理</h1><p>统一管理更新采集、搜索准入、代理规则与告警阈值</p><span className={'data-freshness '+(config.error?'failing':'')}><i/>{config.data?('当前发布版本 v'+config.data.version+' · '+(config.data.source==='DATABASE'?'数据库配置':'环境初值')):'正在读取配置'}</span></div>
  <div className="dashboard-period"><button className="button small" disabled={config.refreshing} onClick={refresh}><RefreshCw size={13}/>刷新配置</button></div></header>
  <div className="discover-kpis">{[
   ['配置项总数',CONFIG_CATALOG.length,'4 个配置分组',<Settings2 size={22}/>,'blue'],
   ['当前发布版本',config.data?'v'+config.data.version:'—',config.data?.source==='DATABASE'?'已持久保存':'等待持久配置',<CircleCheck size={22}/>,'green'],
   ['服务读取版本',config.data?.consumers.filter(c=>c.version===config.data!.version&&Date.now()-Date.parse(c.observed_at)<120000).length??'—','调度器与代理节点',<Clock size={22}/>,'amber'],
   ['高风险配置',high,'发布前核对影响并确认',<TriangleAlert size={22}/>,'red'],
  ].map(([label,value,foot,icon,tone])=><section className={'panel discover-kpi tone-'+tone} key={String(label)}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong><span className="kpi-foot">{foot}</span></div></section>)}</div>
  <ResourceView resource={config} showMeta={false}>{snapshot=><div className="discover-row config-main">
   <section className="panel config-list"><div className="panel-heading"><div><h2>配置项列表<small className="config-count">共 {rows.length} 条</small></h2></div><div className="list-tools config-filters">
    <label className="list-search"><Search size={13}/><input aria-label="搜索配置" placeholder="配置名称 / 键 / 说明" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <select aria-label="配置分组" value={group} onChange={e=>setGroup(e.target.value)}><option value="">全部分组</option>{groups.map(g=><option key={g} value={g}>{g}</option>)}</select>
    <select aria-label="风险等级" value={risk} onChange={e=>setRisk(e.target.value)}><option value="">全部风险等级</option><option value="high">高风险</option><option value="medium">中风险</option></select>
    <button className="button small" onClick={()=>{setQuery('');setGroup('');setRisk('');}}>重置</button></div></div>
    <div className="table-scroll"><table><thead><tr><th>配置名称</th><th>配置键</th><th>分组</th><th>当前值</th><th>风险</th></tr></thead><tbody>{rows.map(m=><tr key={m[0]} className={selected===m[0]?'selected':''} aria-selected={selected===m[0]} onClick={()=>setSelected(m[0])}><td><button className="text-button" onClick={()=>setSelected(m[0])}>{m[1]}</button></td><td className="mono">{m[0]}</td><td>{m[2]}</td><td>{show(settingValue(snapshot.settings,m[0]))}</td><td><span className={'risk-mark '+(m[4]==='high'?'red':'amber')}><i/>{m[4]==='high'?'高':'中'}</span></td></tr>)}
    {!rows.length&&<tr><td colSpan={5}>没有符合条件的配置项</td></tr>}</tbody></table></div></section>
   <Detail key={selected} snapshot={snapshot} selected={selected} operator={session.role==='operator'} previous={cursor==='0'?history.data?.items.find(h=>h.key===selected):undefined} onDone={refresh}/>
   <section className="panel config-changes"><div className="panel-heading"><div><h2>配置变更记录</h2></div></div><ResourceView resource={history} showMeta={false}>{h=><>
    {h.items.length?<div className="table-scroll"><table><thead><tr><th>版本 / 时间</th><th>配置项</th><th>变更前</th><th>变更后</th><th>操作人 / 原因</th></tr></thead><tbody>{h.items.map(c=><tr key={c.command_id}><td>v{c.version}<br/>{time(c.created_at)}</td><td>{CONFIG_CATALOG.find(m=>m[0]===c.key)?.[1]}</td><td>{show(c.before)}</td><td>{show(c.after)}</td><td>{c.operator}<br/>{c.reason}</td></tr>)}</tbody></table></div>:<Empty title="暂无变更记录">初始参数已保留，每次发布记录前后值、操作人和原因。</Empty>}
    <footer className="pagination"><span>每页最多 50 条</span><div><button className="button small" disabled={cursor==='0'} onClick={()=>setCursor(String(Math.max(0,Number(cursor)-50)))}>上一页</button><button className="button small" disabled={!h.next_cursor} onClick={()=>setCursor(h.next_cursor!)}>下一页</button></div></footer>
   </>}</ResourceView></section>
   <section className="panel config-checks"><div className="panel-heading"><div><h2>配置生效情况</h2></div></div><div className="check-body">
    <p className="config-explainer">API 按请求读取当前值。调度器下一轮扫描读取；代理节点定期同步。告警阈值在下次指标采样和规则计算时生效。</p>
    <div className="config-consumers">{snapshot.consumers.length?snapshot.consumers.map(c=><div key={c.name}><b>{c.name==='dispatcher'?'调度器':c.name.replace('proxy:','代理节点 ')}</b><span className={'status-chip '+(c.version===snapshot.version&&Date.now()-Date.parse(c.observed_at)<120000?'green':'amber')}>v{c.version}{c.version===snapshot.version&&Date.now()-Date.parse(c.observed_at)<120000?' 已读取':' 待同步'}</span><small>{time(c.observed_at)}</small></div>):<p>尚无服务读取记录</p>}</div>
    <h3 className="check-sub">最近发布</h3><p className="config-explainer">{time(snapshot.updated_at)}<br/>{snapshot.operator??'环境变量'}</p>
   </div></section>
  </div>}</ResourceView>
  <footer className="dashboard-foot"><span>变更只影响后续准入、任务与新失败处理；已冻结任务和已有冷却截止时间保持。</span><span>回滚载入旧值后，填写原因并重新发布。</span></footer>
 </div>;
}
