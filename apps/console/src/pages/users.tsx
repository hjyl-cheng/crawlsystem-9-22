import { useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, Download, KeyRound, MonitorSmartphone, Plus, Search, ShieldCheck, UserCheck, Users as UsersIcon, UserX } from 'lucide-react';
import type { ConsoleAccount } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty } from '../ui.js';
import { roleLabels } from '../presentation.js';
import LineChart from '../components/line-chart.js';
import './overview.css';
import './discover.css';
import './users.css';

const CLI_ONLY = '账号维护目前在服务器上用命令行进行（npm run console:accounts）';
const NO_HISTORY = '登录历史尚未留存：退出登录会删除会话，无法统计历史登录';
const NO_AUDIT = '账号审计日志尚未接入';
const short = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const shortOrDash = (value: string | null) => value ? short(value) : '—';
const full = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date(value)) : '未记录';
const sessions = (n: number | null) => n === null ? '未知' : `${n} 个`;
const avatarColors = ['#3f7fe0', '#0f9f75', '#c96a12', '#7a5af0', '#1686ad', '#c2413a'];
const colorOf = (name: string) => avatarColors[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % avatarColors.length]!;
const permissions: Record<ConsoleAccount['role'], string[]> = {
  reader: ['查看全部页面与数据', '不能创建或取消采集计划'],
  operator: ['查看全部页面与数据', '创建采集计划', '取消采集计划'],
};

function Card({ title, subtitle, extra, className = '', children }: { title: string; subtitle?: string; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{extra}</div>{children}</section>;
}
function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="kv-row"><dt>{label}</dt><dd>{children}</dd></div>;
const Avatar = ({ name, big = false }: { name: string; big?: boolean }) => <span className={`avatar-dot ${big ? 'big' : ''}`} style={{ background: colorOf(name) }}>{name.slice(0, 1).toUpperCase()}</span>;
const RoleChip = ({ role }: { role: ConsoleAccount['role'] }) => <span className={`role-chip ${role}`}>{roleLabels[role]}</span>;
const StatusChip = ({ status }: { status: ConsoleAccount['status'] }) => status === 'ACTIVE' ? <span className="status-chip green"><i/>启用</span> : <span className="status-chip red"><i/>已停用</span>;

type Tab = 'info' | 'scope' | 'security' | 'activity';
const tabs: [Tab, string][] = [['info', '基本信息'], ['scope', '权限范围'], ['security', '登录安全'], ['activity', '最近操作']];
function Detail({ account, workspace, self }: { account?: ConsoleAccount; workspace: string; self: boolean }) {
  const [tab, setTab] = useState<Tab>('info');
  if (!account) return <section className="panel user-detail"><div className="panel-heading"><div><h2>用户详情</h2></div></div><div className="detail-body"><Empty title="选择用户查看详情"/></div></section>;
  return <section className="panel user-detail">
    <div className="panel-heading"><div><h2>用户详情</h2></div></div>
    <header className="detail-head"><Avatar name={account.username} big/><div><b>{account.username}{self && <em className="self-tag">当前登录</em>}</b><small className="mono">{account.subject}</small></div><StatusChip status={account.status}/></header>
    <div className="detail-tabs" role="tablist">{tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
    <div className="detail-body">
      {tab === 'info' && <dl><Row label="用户名">{account.username}</Row><Row label="主体 ID"><span className="mono">{account.subject}</span></Row><Row label="工作空间"><span className="mono">{workspace}</span></Row>
        <Row label="角色"><RoleChip role={account.role}/></Row><Row label="账号状态"><StatusChip status={account.status}/></Row><Row label="创建时间">{full(account.created_at)}</Row><Row label="最后修改">{full(account.updated_at)}</Row></dl>}
      {tab === 'scope' && <><dl><Row label="角色"><RoleChip role={account.role}/></Row><Row label="数据范围">仅工作空间 <span className="mono">{workspace}</span></Row></dl>
        <h3>可执行的操作</h3><ul className="scope-list">{permissions[account.role].map(p => <li key={p} className={p.startsWith('不能') ? 'deny' : ''}>{p}</li>)}</ul>
        <p className="detail-note">执行身份（Worker）使用独立令牌，不能登录控制台。</p></>}
      {tab === 'security' && <><dl><Row label="在线会话">{sessions(account.active_sessions)}</Row><Row label="最近登录">{full(account.latest_session_at)}</Row><Row label="密码存储">scrypt 加盐哈希，不保存明文</Row>
        <Row label="会话有效期">8 小时，退出即失效</Row><Row label="登录限流">每账号每分钟 10 次</Row><Row label="双因素认证">未接入</Row></dl>
        <p className="detail-note">修改密码或停用账号后，该账号已有会话立即失效。</p></>}
      {tab === 'activity' && <Empty title="暂无操作记录">{NO_AUDIT}</Empty>}
    </div>
    <footer className="detail-actions"><button className="button small" disabled title={CLI_ONLY}><KeyRound size={13}/>重置密码</button><button className="button small danger" disabled title={CLI_ONLY}><UserX size={13}/>{account.status === 'ACTIVE' ? '停用账号' : '启用账号'}</button></footer>
  </section>;
}

// Account administration is operator-only; the API refuses read-only identities too.
export default function Users() {
  const { session } = useAuth();
  if (session.role !== 'operator') return <div className="dashboard users-page"><header className="dashboard-heading"><div><h1>用户管理</h1></div></header>
    <div role="alert" className="notice warning">当前为只读身份，没有查看账号列表的权限。</div></div>;
  return <UsersView/>;
}

function UsersView() {
  const { api, session } = useAuth();
  const resource = useResource('console-accounts', signal => api.consoleAccounts(signal), true, 30_000);
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState(''), [role, setRole] = useState(''), [status, setStatus] = useState('');
  const accounts = resource.data?.items;
  const workspace = session.workspace_id;
  const rows = useMemo(() => accounts?.filter(a => (!query || `${a.username} ${a.subject}`.toLowerCase().includes(query.trim().toLowerCase())) && (!role || a.role === role) && (!status || a.status === status)), [accounts, query, role, status]);
  const current = accounts?.find(a => a.username === selected) ?? accounts?.find(a => a.subject === session.subject) ?? accounts?.[0];
  const active = accounts?.filter(a => a.status === 'ACTIVE').length, operators = accounts?.filter(a => a.role === 'operator').length;
  const known = accounts?.filter(a => a.active_sessions !== null), online = known?.length ? known.reduce((s, a) => s + a.active_sessions!, 0) : undefined;
  const latest = accounts?.map(a => a.latest_session_at).filter((v): v is string => !!v).sort().at(-1);
  const pct = (n: number) => accounts?.length ? `${(n / accounts.length * 100).toFixed(1)}%` : '—';
  return <div className="dashboard discover users-page">
    <header className="dashboard-heading">
      <div><h1>用户管理</h1><p>管理控制台账号、角色权限与登录会话</p>
        {resource.updatedAt && resource.data ? <span className="data-freshness" title="来自账号库 console.accounts"><i/>账号库已同步 · {short(new Date(resource.updatedAt).toISOString())}</span> : null}</div>
      <div className="dashboard-period">
        <button className="button small" disabled title={CLI_ONLY}><Download size={13}/>导出列表</button><button className="button small primary" disabled title={CLI_ONLY}><Plus size={13}/>新建用户</button></div>
    </header>

    <div className="discover-kpis">
      <Kpi label="用户总数" tone="blue" icon={<UsersIcon size={22}/>} value={accounts?.length} foot={<>工作空间 <span className="mono">{workspace}</span></>}/>
      <Kpi label="启用中" tone="green" icon={<UserCheck size={22}/>} value={active} foot={accounts ? `占比 ${pct(active!)} · 已停用 ${accounts.length - active!}` : '—'}/>
      <Kpi label="操作员" tone="amber" icon={<ShieldCheck size={22}/>} value={operators} foot={accounts ? `可创建与取消计划 · 只读 ${accounts.length - operators!}` : '—'}/>
      <Kpi label="在线会话" tone="blue" icon={<MonitorSmartphone size={22}/>} value={online} foot={latest ? `最近登录 ${short(latest)}` : accounts ? '暂无登录会话' : '—'}/>
    </div>

    <div className="discover-row users-main">
      <section className="panel user-list">
        <div className="panel-heading"><div><h2>用户列表{rows && <small className="list-count">共 {rows.length} 条</small>}</h2></div>
          <div className="list-tools user-filters">
            <label className="list-search" htmlFor="user-search"><Search size={13}/><input id="user-search" placeholder="搜索用户名 / 主体 ID…" value={query} onChange={event => setQuery(event.target.value)} disabled={!accounts}/></label>
            <select aria-label="角色" value={role} onChange={event => setRole(event.target.value)} disabled={!accounts}><option value="">全部角色</option><option value="operator">操作员</option><option value="reader">只读用户</option></select>
            <select aria-label="状态" value={status} onChange={event => setStatus(event.target.value)} disabled={!accounts}><option value="">全部状态</option><option value="ACTIVE">启用</option><option value="DISABLED">已停用</option></select>
            <button className="button small" onClick={() => { setQuery(''); setRole(''); setStatus(''); }} disabled={!accounts}>重置</button>
          </div></div>
        {rows ? <div className="table-scroll"><table><thead><tr><th>用户</th><th>角色</th><th>状态</th><th className="num">在线会话</th><th>最近登录</th><th>创建时间</th><th>最后修改</th><th>操作</th></tr></thead>
          <tbody>{rows.map(a => <tr key={a.username} className={a.username === current?.username ? 'selected' : ''} onClick={() => setSelected(a.username)} aria-selected={a.username === current?.username}>
            <td><div className="channel-cell"><Avatar name={a.username}/><div><b>{a.username}{a.subject === session.subject && <em className="self-tag">我</em>}</b><small className="mono">{a.subject}</small></div></div></td>
            <td><RoleChip role={a.role}/></td><td><StatusChip status={a.status}/></td><td className="num">{a.active_sessions ?? '—'}</td><td>{shortOrDash(a.latest_session_at)}</td><td>{shortOrDash(a.created_at)}</td><td>{shortOrDash(a.updated_at)}</td>
            <td><button className="link-button" onClick={event => { event.stopPropagation(); setSelected(a.username); }}>查看</button></td></tr>)}
            {!rows.length && <tr><td colSpan={8} className="no-match">没有符合条件的用户</td></tr>}</tbody></table></div>
          : <Empty title={resource.error ? '无法读取账号' : '正在读取账号…'}>{resource.error?.message}</Empty>}
      </section>
      <Detail key={current?.username} account={current} workspace={workspace} self={current?.subject === session.subject}/>
    </div>

    <div className="discover-row users-lower">
      <Card title="近 7 日登录趋势" className="login-trend">
        <LineChart points={undefined} series={[{ key: 'logins', label: '登录次数', color: '#277cf7', area: true }]} empty={NO_HISTORY} label="近 7 日登录趋势"/>
      </Card>
      <Card title="账号变更与待处理事项" className="user-events" extra={<span className="dashboard-unavailable" title={NO_AUDIT}>查看全部<ArrowRight size={12}/></span>}>
        <Empty title="暂无记录">{NO_AUDIT}。账号的新建、改密、停用目前通过服务器命令行完成。</Empty>
      </Card>
    </div>
    <footer className="dashboard-foot"><span>账号与会话来自账号库；密码只以加盐哈希保存，页面不展示任何凭据。</span><span>账号的新建、改密与停用通过服务器命令行完成</span></footer>
  </div>;
}
