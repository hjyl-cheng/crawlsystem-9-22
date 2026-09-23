import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Bell, BriefcaseBusiness, ChevronDown, CircleHelp, Database, FileChartColumn, Hexagon, House, LogOut, Menu, Network, Search, Server, Settings, Workflow, X } from 'lucide-react';
import { useAuth } from './auth.js';
import { roleLabels } from './presentation.js';

function Pending({ children }: { children: ReactNode }) {
  return <span className="nav-pending" aria-disabled="true" title="此功能尚未接入">{children}</span>;
}
/** Only the group holding the current page starts expanded, keeping the sidebar short. */
function NavGroup({ icon, label, active = false, children }: { icon: ReactNode; label: string; active?: boolean; children: ReactNode }) {
  return <details className="nav-group" open={active}><summary>{icon}<span>{label}</span><ChevronDown size={12}/></summary><div className="nav-children">{children}</div></details>;
}
export function Layout() {
  const { session, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [searchError, setSearchError] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const under = (...prefixes: string[]) => prefixes.some(prefix => location.pathname.startsWith(prefix));
  function lookup(event: FormEvent) {
    event.preventDefault();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(search.trim())) { setSearchError(true); return; }
    setSearchError(false); navigate(`/plans/${encodeURIComponent(search.trim())}`); setSearch('');
  }
  return <div className="app-layout prototype-layout">
    <a href="#main-content" className="skip-link">跳到主要内容</a>
    {menuOpen && <button className="sidebar-backdrop" onClick={() => setMenuOpen(false)} aria-label="关闭导航"/>}
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
      <Link to="/" className="brand"><span className="brand-emblem"><Hexagon size={29}/><span/></span><div>CrawlerHub<small>采集业务管理系统</small></div></Link>
      <button className="mobile-only sidebar-close icon-button" aria-label="关闭导航" onClick={() => setMenuOpen(false)}><X size={18}/></button>
      <nav aria-label="主导航" onClick={event => { if ((event.target as HTMLElement).closest('a')) setMenuOpen(false); }}>
        <NavLink className="nav-primary" to="/" end aria-label="采集总览"><House size={16}/><span>首页</span></NavLink>
        <Link className="nav-primary" to="/#pipeline"><Workflow size={16}/><span>采集链路</span></Link>
        <NavGroup icon={<BriefcaseBusiness size={16}/>} label="任务管理" active={under('/plans')}>
          <Pending>Query 发现</Pending><Pending>候选频道</Pending>
          <NavLink to="/plans" aria-label="Plan 管理">全量采集 / Plan</NavLink>
          <Link to="/channels">频道管理</Link><Pending>计时器 Clock</Pending><Pending>更新采集</Pending><Pending>Agent 任务</Pending><Pending>数据 API</Pending><Pending>发布交付</Pending>
        </NavGroup>
        <NavLink className="nav-primary" to="/channels" aria-label="频道数据"><Database size={16}/><span>频道管理</span></NavLink>
        <span className="nav-primary unavailable" title="独立视频管理尚未接入" aria-disabled="true"><FileChartColumn size={16}/><span>视频管理</span></span>
        <NavGroup icon={<Network size={16}/>} label="代理资源"><Pending>IP 管理</Pending><Pending>IP 分组</Pending><Pending>服务器管理</Pending></NavGroup>
        <NavGroup icon={<Server size={16}/>} label="采集节点" active={under('/workers')}><NavLink to="/workers" aria-label="Worker / 节点">服务器总览</NavLink><Link to="/workers">Worker 管理</Link></NavGroup>
        <NavGroup icon={<FileChartColumn size={16}/>} label="数据与分析"><Pending>采集统计</Pending><Pending>质量分析</Pending><Link to="/#trends">趋势分析</Link></NavGroup>
        <NavGroup icon={<Settings size={16}/>} label="系统管理" active={under('/errors')}><Pending>用户管理</Pending><Pending>配置管理</Pending><NavLink to="/errors" aria-label="错误与追踪">错误与日志</NavLink></NavGroup>
      </nav>
      <div className="sidebar-version">M1 · 固定样本联调 <span title="灰色菜单表示尚未接入的功能"><CircleHelp size={12}/></span></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><button className="mobile-only icon-button" aria-label="打开导航" onClick={() => setMenuOpen(true)}><Menu size={20}/></button>
        <form className="quick-search" onSubmit={lookup}><Search size={15}/><input aria-label="按 Plan ID 定位" placeholder="搜索 Plan ID，定位计划与执行结果…" value={search} onChange={e => { setSearch(e.target.value); setSearchError(false); }}/>{searchError && <span role="alert">请输入完整 Plan UUID</span>}</form>
        <div className="topbar-right"><Link className="icon-button" to="/errors" aria-label="查看错误事件" title="查看错误事件"><Bell size={19}/></Link><div className="identity"><span className="avatar">{session.subject.slice(0, 1).toUpperCase()}</span><div><strong title={`${session.subject} · ${session.workspace_id}`}>{session.subject === 'console-preview-reader' ? 'preview' : session.subject}</strong><small>{roleLabels[session.role]}</small></div><button className="icon-button" aria-label="退出登录" title="退出登录" onClick={logout}><LogOut size={15}/></button></div></div>
      </header>
      <main id="main-content" className={`main-content ${location.pathname === '/' ? 'overview-content' : ''}`} key={`${session.workspace_id}:${session.subject}`}><Outlet/></main>
    </div>
  </div>;
}
