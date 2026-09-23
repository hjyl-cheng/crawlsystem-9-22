import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@crawlsystem/contracts';
import { ArrowRight, Hexagon, KeyRound, ShieldCheck } from 'lucide-react';
import { ApiFailure, ControlApi } from './api.js';

interface Auth { api: ControlApi; session: Session; logout: () => void; }
const AuthContext = createContext<Auth | null>(null);
export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('Authenticated view required');
  return auth;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<{ api: ControlApi; session: Session }>();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | null>(null);
  const activeRef = useRef(active); activeRef.current = active;
  const busyRef = useRef(false);
  const logout = (message?: string) => {
    request.current?.abort(); activeRef.current?.api.dispose();
    setActive(undefined); setToken(''); setError(message);
  };
  useEffect(() => () => { request.current?.abort(); activeRef.current?.api.dispose(); }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !token.trim()) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    const controller = new AbortController(); request.current = controller;
    let api: ControlApi | undefined;
    try {
      api = new ControlApi(import.meta.env.VITE_API_BASE_URL || '/api', token.trim(), () => logout('登录已失效，请重新验证身份。'));
      const session = await api.session(controller.signal);
      if (session.role === 'worker') throw new ApiFailure('执行身份不能登录管理控制台，请使用只读或操作身份。', 403, 'FORBIDDEN');
      setToken(''); setActive({ api, session });
    } catch (cause) {
      api?.dispose();
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '登录失败');
    } finally { busyRef.current = false; setBusy(false); }
  }
  if (active) return <AuthContext.Provider value={{ ...active, logout: () => logout() }}>{children}</AuthContext.Provider>;
  return <main className="login-page">
    <section className="login-story">
      <div className="brand"><Hexagon size={36}/><div>CrawlerHub<small>采集业务管理系统</small></div></div>
      <div><span className="eyebrow">CRAWL OPERATIONS</span><h1>每一次采集，<br/>都有迹可循。</h1><p>从计划到入库，从等待到回执。<br/>在同一处查看真实业务状态。</p></div>
      <div className="login-foot"><ShieldCheck size={18}/> 独立控制台 · 受控 API · 可追溯结果</div>
    </section>
    <section className="login-form"><div className="login-card">
      <span className="icon-tile"><KeyRound size={25}/></span>
      <h2>连接工作空间</h2><p className="muted">M1 联调登录</p>
      <div className="notice">使用后端签发的访问令牌验证身份。正式账号登录尚未接入，令牌仅保存在本次页面内存中。</div>
      <form onSubmit={login}>
        <label htmlFor="access-token">访问令牌</label>
        <input id="access-token" type="password" autoComplete="off" spellCheck={false} required value={token} onChange={e => setToken(e.target.value)} disabled={busy} placeholder="输入只读或操作员令牌"/>
        {error && <div role="alert" className="error-box">{error}</div>}
        <button className="button primary full" disabled={busy || !token.trim()}>{busy ? '正在验证身份…' : '进入控制台'}<ArrowRight size={16}/></button>
      </form>
      <p className="fine-print">刷新页面后需要重新登录。权限以服务端验证结果为准。</p>
    </div></section>
  </main>;
}
