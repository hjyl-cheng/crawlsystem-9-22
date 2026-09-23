import { useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Activity, Bot, Boxes, ChevronRight, CircleHelp, Database, FileWarning, Hexagon, LayoutDashboard, ListTodo, LogOut, Menu, Network, Search, Server, ShieldCheck, Workflow, X } from 'lucide-react';
import { useAuth } from './auth.js';
import { roleLabels } from './presentation.js';

const navigation = [
  { to: '/', label: '采集总览', icon: LayoutDashboard },
  { to: '/plans', label: 'Plan 管理', icon: ListTodo },
  { to: '/channels', label: '频道数据', icon: Database },
  { to: '/workers', label: 'Worker / 节点', icon: Server },
  { to: '/errors', label: '错误与追踪', icon: FileWarning },
];

export function Layout() {
  const { session, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [searchError, setSearchError] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const current = navigation.find(n => n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to));
  function lookup(event: FormEvent) {
    event.preventDefault();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(search.trim())) { setSearchError(true); return; }
    setSearchError(false); navigate(`/plans/${encodeURIComponent(search.trim())}`); setSearch('');
  }
  return <div className="app-layout">
    <a href="#main-content" className="skip-link">跳到主要内容</a>
    {menuOpen && <button className="sidebar-backdrop" onClick={() => setMenuOpen(false)} aria-label="关闭导航"/>}
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
      <div className="brand"><Hexagon size={31}/><div>CrawlerHub<small>采集业务管理系统</small></div><button className="mobile-only icon-button" aria-label="关闭导航" onClick={() => setMenuOpen(false)}><X size={18}/></button></div>
      <div className="workspace"><span className="workspace-mark"><Boxes size={17}/></span><div><strong>{session.workspace_id}</strong><small>当前工作空间</small></div></div>
      <div className="nav-caption">采集运营</div><nav aria-label="主导航">{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setMenuOpen(false)}><Icon size={18}/>{label}</NavLink>)}</nav>
      <div className="nav-caption">扩展能力</div><div className="future-nav"><span><Bot size={18}/>Agent 执行<small>未接入</small></span><span><Network size={18}/>代理资源<small>未接入</small></span><span><Workflow size={18}/>发布交付<small>未启用</small></span></div>
      <div className="sidebar-bottom"><div className="scope-card"><Activity size={18}/><strong>M1 样本联调</strong><p>固定样本验证<br/>状态以持久业务事实为准</p></div><span className="sidebar-version">CrawlerHub Console · {session.contract_version}</span></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><button className="mobile-only icon-button" aria-label="打开导航" onClick={() => setMenuOpen(true)}><Menu size={20}/></button>
        <div className="breadcrumb">控制台<ChevronRight size={14}/><strong>{current?.label ?? '业务详情'}</strong></div>
        <form className="quick-search" onSubmit={lookup}><Search size={16}/><input aria-label="按 Plan ID 定位" placeholder="输入 Plan ID 定位…" value={search} onChange={e => { setSearch(e.target.value); setSearchError(false); }}/>{searchError && <span role="alert">请输入完整 Plan UUID</span>}</form>
        <div className="identity"><span className="avatar">{session.subject.slice(0, 1).toUpperCase()}</span><div><strong>{session.subject}</strong><small>{roleLabels[session.role]}</small></div><button className="icon-button" aria-label="退出登录" title="退出登录" onClick={logout}><LogOut size={17}/></button></div>
      </header>
      <main id="main-content" className="main-content" key={`${session.workspace_id}:${session.subject}`}><Outlet/></main>
      <footer className="app-footer"><span><ShieldCheck size={14}/> 固定样本 · 数据与执行结果分别核对</span><span><CircleHelp size={14}/> 时间以浏览器所在时区显示</span></footer>
    </div>
  </div>;
}
