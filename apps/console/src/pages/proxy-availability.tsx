import {useState} from 'react';
import {useAuth} from '../auth.js';
import {useResource} from '../resource.js';
import LineChart from '../components/line-chart.js';
export function ProxyAvailability({servers,providers}:{servers:string[];providers:string[]}){
  const {api}=useAuth();
  const [resolution,setResolution]=useState('day'),[server,setServer]=useState(''),[provider,setProvider]=useState(''),[metric,setMetric]=useState('available_percent');
  const resource=useResource('proxy-availability:'+JSON.stringify({resolution,server,provider}),signal=>api.proxyAvailability({resolution,...(server?{server_id:server}:{}),...(provider?{provider}:{})},signal),true,30_000);
  const data=resource.data,label=metric==='available_percent'?'代理可用率':'请求成功率';
  const rate=data?.summary[metric as 'available_percent'|'request_success_percent'];
  return <section className="panel discover-card proxy-availability">
    <div className="panel-heading"><div><h2>{resolution==='day'?'近 7 天':'近 24 小时'}{label}</h2><p>{rate==null?'暂无有效样本':`本范围 ${rate.toFixed(1)}%`} · {data?`${data.summary.samples.toLocaleString('zh-CN')} 次观测 · ${data.summary.requests.toLocaleString('zh-CN')} 次请求`:'正在读取…'}</p></div></div>
    <div className="availability-filters">
      <select aria-label="趋势时间范围" value={resolution} onChange={e=>setResolution(e.target.value)}><option value="day">近 7 天</option><option value="hour">近 24 小时</option></select>
      <select aria-label="趋势指标" value={metric} onChange={e=>setMetric(e.target.value)}><option value="available_percent">代理可用率</option><option value="request_success_percent">请求成功率</option></select>
      <select aria-label="趋势服务器" value={server} onChange={e=>setServer(e.target.value)}><option value="">全部服务器</option>{[...new Set([...servers,...(server?[server]:[])])].sort().map(s=><option key={s}>{s}</option>)}</select>
      <select aria-label="趋势服务商" value={provider} onChange={e=>setProvider(e.target.value)}><option value="">全部服务商</option>{[...new Set([...providers,...(provider?[provider]:[])])].sort().map(p=><option key={p}>{p}</option>)}</select>
      <button className="button small" onClick={resource.refresh}>刷新趋势</button>
    </div>
    {resource.error&&<div role="alert" className="notice warning">趋势读取失败：{resource.error.message}</div>}
    {resource.paused&&<p className="availability-note">自动刷新已暂停，点击“刷新趋势”继续。</p>}
    {data?.stale&&<div className="availability-note">{data.latest_report_at?'当前筛选超过 3 分钟没有新观测，历史记录保留。':'当前筛选尚无观测。'}</div>}
    <LineChart points={data?.points.map(p=>({x:new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',...(resolution==='hour'?{hour:'2-digit' as const,hour12:false}:{})}).format(new Date(p.bucket_at)),values:{rate:p.counts[metric as 'available_percent'|'request_success_percent']}}))} series={[{key:'rate',label,color:'#277cf7'}]} max={100} format={v=>v.toFixed(1)+'%'} empty={resource.error?'暂时无法读取趋势':'正在读取趋势…'} label={`${resolution==='day'?'近 7 天':'近 24 小时'}${label}`}/>
    <p className="availability-note">{metric==='available_percent'?'正常与降级观测 / 实际观测；下线后不再产生样本。':'成功请求 / 采集请求；主动探测不计入请求。'} 无观测或无请求的时段留空。</p>
    {data&&<p className="availability-note">北京时间 · 自 {new Date(data.recording_since).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})} 起留存 · {data.latest_report_at?'最近观测 '+new Date(data.latest_report_at).toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'等待节点上报'}</p>}
  </section>;
}
