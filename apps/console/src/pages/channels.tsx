import { Link } from 'react-router';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty, PageHeading, Panel, Pagination, ResourceView, SampleBadge, usePagination } from '../ui.js';
import { channelPath, planPath, shortId, time } from '../presentation.js';

export default function Channels() {
  const { api } = useAuth(); const paging = usePagination();
  const resource = useResource(`channels:${paging.cursor}`, signal => api.channels(paging.cursor, 20, signal));
  return <><PageHeading title="频道数据" description="当前可用资料与本轮完成情况分别展示，缺失数据保留真实状态。"/><Panel title="频道列表" extra={<SampleBadge/>}><ResourceView resource={resource}>{page => <>{page.items.length ? <div className="table-scroll"><table><thead><tr><th>频道名称 / 身份</th><th>来源</th><th>最近计划</th><th>记录更新时间</th><th/></tr></thead><tbody>{page.items.map(channel => <tr key={channel.channel_id}><td><Link to={channelPath(channel.channel_id)}>{channel.title ?? '基础资料待入库'}</Link><small className="cell-note mono">{channel.channel_id}</small></td><td><SampleBadge/></td><td><Link to={planPath(channel.latest_plan_id)} className="mono">{shortId(channel.latest_plan_id)}</Link></td><td>{time(channel.updated_at)}</td><td><Link to={channelPath(channel.channel_id)}>查看数据 →</Link></td></tr>)}</tbody></table></div> : <Empty title="尚无频道记录">样本计划创建后，可在这里查看频道。</Empty>}<Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/></>}</ResourceView></Panel></>;
}
