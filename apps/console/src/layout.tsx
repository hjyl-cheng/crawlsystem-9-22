import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Bell, BriefcaseBusiness, ChevronDown, CircleHelp, Database, FileChartColumn, Hexagon, House, LogOut, Menu, Network, Search, Server, Settings, X } from 'lucide-react';
import { useAuth } from './auth.js';
import { roleLabels } from './presentation.js';

/** Same look as a real child link; a trailing tag marks it as not yet available. */
function Pending({ children }: { children: ReactNode }) {
  return <span className="nav-pending" aria-disabled="true" title="此功能尚未接入">{children}<small>待接入</small></span>;
}
/** Groups start expanded. The prop never changes, so React leaves a group the user collapsed alone. */
function NavGroup({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return <details className="nav-group" open><summary>{icon}<span>{label}</span><ChevronDown size={12}/></summary><div className="nav-children">{children}</div></details>;
}
export function Layout() {
  const { session, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [searchError, setSearchError] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
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
        <NavGroup icon={<BriefcaseBusiness size={16}/>} label="任务管理">
          <NavLink to="/discover/queries">Query 发现</NavLink><NavLink to="/discover/candidates">候选频道</NavLink>
          <NavLink to="/plans">全量采集</NavLink>
          <NavLink to="/update">更新采集</NavLink><NavLink to="/agent">Agent 任务</NavLink><NavLink to="/data-api">数据 API</NavLink><NavLink to="/delivery">发布交付</NavLink>
        </NavGroup>
        <NavLink className="nav-primary" to="/channels"><Database size={16}/><span>频道管理</span></NavLink>
        <NavLink className="nav-primary" to="/proxies"><Network size={16}/><span>IP 资源管理</span></NavLink>
        <NavLink className="nav-primary" to="/workers"><Server size={16}/><span>Worker 管理</span></NavLink>
        <NavGroup icon={<FileChartColumn size={16}/>} label="数据与分析"><NavLink to="/analytics">采集统计</NavLink><NavLink to="/quality">质量分析</NavLink><Link to="/#trends">趋势分析</Link></NavGroup>
        <NavGroup icon={<Settings size={16}/>} label="系统管理">{session.role === 'operator' && <NavLink to="/users">用户管理</NavLink>}<NavLink to="/config">配置管理</NavLink><NavLink to="/failures">失败处理</NavLink><NavLink to="/storage">存储与流水线</NavLink><NavLink to="/errors" aria-label="错误与追踪">错误与日志</NavLink></NavGroup>
      </nav>
      <div className="sidebar-version">M1 · 固定样本联调 <span title="灰色菜单表示尚未接入的功能"><CircleHelp size={12}/></span></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><button className="mobile-only icon-button" aria-label="打开导航" onClick={() => setMenuOpen(true)}><Menu size={20}/></button>
        <form className="quick-search" onSubmit={lookup}><Search size={15}/><input aria-label="按 Plan ID 定位" placeholder="搜索 Plan ID，定位计划与执行结果…" value={search} onChange={e => { setSearch(e.target.value); setSearchError(false); }}/>{searchError && <span role="alert">请输入完整 Plan UUID</span>}</form>
        <div className="topbar-right"><Link className="icon-button" to="/errors" aria-label="查看错误事件" title="查看错误事件"><Bell size={19}/></Link><div className="identity"><span className="avatar">{session.subject.slice(0, 1).toUpperCase()}</span><div><strong title={`${session.subject} · ${session.workspace_id}`}>{session.subject === 'console-preview-reader' ? 'preview' : session.subject}</strong><small>{roleLabels[session.role]}</small></div><button className="icon-button" aria-label="退出登录" title="退出登录" onClick={logout}><LogOut size={15}/></button></div></div>
      </header>
      <main id="main-content" className={`main-content ${location.pathname === '/' || location.pathname === '/plans' || location.pathname === '/update' || location.pathname === '/agent' || location.pathname === '/data-api' || location.pathname === '/delivery' || location.pathname === '/channels' || location.pathname === '/proxies' || location.pathname === '/workers' || location.pathname === '/config' || location.pathname === '/users' || location.pathname.startsWith('/discover/') ? 'overview-content' : 'page-content'}`} key={`${session.workspace_id}:${session.subject}`}><Outlet/></main>
    </div>
  </div>;
}
