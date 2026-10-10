import {useState} from 'react';
import {useParams,Link} from 'react-router';
import {useAuth} from '../auth.js';
import {useResource} from '../resource.js';
import {Empty,PageHeading,Panel,ResourceView} from '../ui.js';
import {channelPath,number,time} from '../presentation.js';
import './analytics.css';
export default function ChannelHistory() {
 const {id=''}=useParams(),{api}=useAuth(),[days,setDays]=useState(30),[entity,setEntity]=useState('channel');
 const r=useResource(`channel-history:${id}:${days}`,signal=>api.channelHistory(id,days,signal));
 return <><PageHeading title="指标历史" description="查看频道和视频的持久采集观察，未知值保留为空。"><Link className="button" to={channelPath(id)}>返回频道详情</Link></PageHeading>
 <div className="analytics-filters"><label>时间范围<select aria-label="历史时间范围" value={days} onChange={e=>setDays(Number(e.target.value))}><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="180">最近 180 天</option></select></label></div>
 <ResourceView resource={r}>{data=>{
  const points=data.points.filter(p=>entity==='channel'?p.domain==='ABOUT':p.entity_id===entity),videos=[...new Set(data.points.filter(p=>['VIDEO','SAMPLING'].includes(p.domain)).map(p=>p.entity_id))];
  const values=points.filter(p=>p.views!==null),max=Math.max(1,...values.map(p=>p.views!));
  return <Panel title="采集观察"><div className="analytics-filters inset"><label>观察对象<select aria-label="观察对象" value={entity} onChange={e=>setEntity(e.target.value)}><option value="channel">频道订阅与总播放量</option>{videos.map(v=><option key={v} value={v}>视频 {v}</option>)}</select></label></div>
   {values.length>1 && <div className="inset"><svg viewBox="0 0 800 180" style={{width:'100%',maxHeight:180}} role="img" aria-label="播放量观察曲线"><polyline fill="none" stroke="#3b82f6" strokeWidth="3" points={values.map((p,i)=>`${20+i/(values.length-1)*760},${160-p.views!/max*140}`).join(' ')}/>{values.map((p,i)=><circle key={i} cx={20+i/(values.length-1)*760} cy={160-p.views!/max*140} r="4" fill="#3b82f6"><title>{p.at}：{number(p.views)}</title></circle>)}</svg><p className="fine-print">播放量按采集顺序展示；悬停查看数值。</p></div>}
   {points.length?<div className="table-scroll"><table><thead><tr><th>观察时间</th><th>类型</th><th>订阅</th><th>播放</th><th>点赞</th><th>评论数</th><th>时长（秒）</th><th>结果</th></tr></thead><tbody>{points.map((p,i)=><tr key={i}><td>{time(p.at)}</td><td>{p.kind==='SNAPSHOT'?'存量快照':'采集观察'}</td><td>{number(p.subscribers)}</td><td>{number(p.views)}</td><td>{number(p.likes)}</td><td>{number(p.comments)}</td><td>{number(p.duration_seconds)}</td><td>{p.status==='PARTIAL'?'部分字段待解析':p.status==='UNAVAILABLE'?'不可访问':'已入库'}</td></tr>)}</tbody></table></div>:<Empty title="这段时间没有该对象的指标观察"/>}
   <p className="fine-print inset">来源：ClickHouse · 最多最近 {data.limit} 条观察 · 存量快照单独标明，不代表当日新增采集。</p>
  </Panel>;
 }}</ResourceView></>;
}
