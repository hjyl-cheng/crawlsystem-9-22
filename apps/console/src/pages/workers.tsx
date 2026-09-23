import { Link } from 'react-router';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Badge, Empty, PageHeading, Panel, Pagination, ResourceView, usePagination } from '../ui.js';
import { planPath, shortId, time } from '../presentation.js';

export default function Workers() {
  const { api } = useAuth(); const paging = usePagination();
  const highlight = paging.params.get('highlight');
  const resource = useResource(`workers:${paging.cursor}`, signal => api.workers(paging.cursor, 20, signal));
  return <><PageHeading title="Worker / 节点" description="登记关系、接单状态与心跳分别显示，失联以服务端判定为准。"/><Panel title="已登记的 Worker"><ResourceView resource={resource}>{page => <>
    {highlight && <div className="notice">正在定位 Worker：<code>{highlight}</code>{!page.items.some(worker => worker.worker_id === highlight) && '。当前页未包含该身份，可继续翻页查看。'}</div>}
    {page.items.length ? <div className="table-scroll"><table><thead><tr><th>Worker / 节点</th><th>版本</th><th>心跳状态</th><th>接单状态</th><th>最近心跳</th><th>容量 / 关联计划</th><th>代理</th></tr></thead><tbody>{page.items.map(worker => <tr key={worker.worker_id} className={worker.worker_id === highlight ? 'highlight-row' : ''}><td><strong>{worker.worker_id}</strong><small className="cell-note">节点：{worker.server_id}</small></td><td><code>{worker.build_version}</code></td><td><Badge tone={worker.stale ? 'red' : 'green'}>{worker.stale ? '心跳失联' : '心跳正常'}</Badge></td><td><Badge tone={worker.accepting_work ? 'blue' : 'neutral'}>{worker.accepting_work ? '上报接单中' : '上报停止接单'}</Badge></td><td>{time(worker.last_heartbeat_at)}</td><td><span>上报容量 {worker.capacity}</span>{worker.running_plan_ids.map(id => <small key={id} className="cell-note"><Link to={planPath(id)}>{shortId(id)}</Link></small>)}</td><td>未配置<small className="cell-note">固定样本不使用代理</small></td></tr>)}</tbody></table></div> : <Empty title="尚无登记的 Worker">等待执行节点注册并上报心跳。</Empty>}
    <Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/><div className="notice">节点信息来自 Worker 登记关系。节点 CPU、内存及代理额度尚未接入；失联时接单状态仅代表最后一次上报。</div>
    </>}</ResourceView></Panel></>;
}
