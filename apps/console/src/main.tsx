import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router';
import { AuthProvider } from './auth.js';
import { Layout } from './layout.js';
import './tokens.css';
import './styles.css';
import './shell.css';
import './pages.css';

const Overview = lazy(() => import('./pages/overview.js'));
const Plans = lazy(() => import('./pages/plans.js'));
const PlanDetail = lazy(() => import('./pages/plan-detail.js'));
const CreatePlan = lazy(() => import('./pages/create-plan.js'));
const Channels = lazy(() => import('./pages/channels.js'));
const ChannelDetail = lazy(() => import('./pages/channel-detail.js'));
const Workers = lazy(() => import('./pages/workers.js'));
const Errors = lazy(() => import('./pages/errors.js'));
const ReceiptDetail = lazy(() => import('./pages/receipt.js'));
const Discover = lazy(() => import('./pages/discover.js'));
const Candidates = lazy(() => import('./pages/candidates.js'));
const Update = lazy(() => import('./pages/update.js'));
const Agent = lazy(() => import('./pages/agent.js'));

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert" className="fatal-error"><h1>页面暂时无法显示</h1><p>请重新加载页面。再次登录后，可通过 Plan ID 核对操作结果。</p><button className="button" onClick={() => window.location.reload()}>重新加载</button></div> : this.props.children; }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><AppErrorBoundary><BrowserRouter><AuthProvider><Suspense fallback={<div className="loading-state" role="status">正在加载页面…</div>}><Routes>
  <Route element={<Layout/>}>
    <Route index element={<Overview/>}/>
    <Route path="plans" element={<Plans/>}/><Route path="plans/new" element={<CreatePlan/>}/><Route path="plans/:id" element={<PlanDetail/>}/>
    <Route path="channels" element={<Channels/>}/><Route path="channels/:id" element={<ChannelDetail/>}/>
    <Route path="workers" element={<Workers/>}/><Route path="errors" element={<Errors/>}/><Route path="receipts/:id" element={<ReceiptDetail/>}/>
    <Route path="discover/queries" element={<Discover/>}/><Route path="discover/candidates" element={<Candidates/>}/><Route path="update" element={<Update/>}/><Route path="agent" element={<Agent/>}/>
    <Route path="*" element={<div className="empty-state"><h1>页面不存在</h1><Link to="/">返回采集总览</Link></div>}/>
  </Route>
</Routes></Suspense></AuthProvider></BrowserRouter></AppErrorBoundary></React.StrictMode>);
