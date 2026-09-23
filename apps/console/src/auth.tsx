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
  const tokenMode = import.meta.env.VITE_AUTH_MODE === 'token';
  const [active, setActive] = useState<{ api: ControlApi; session: Session }>();
  const [token, setToken] = useState('');
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [restoring, setRestoring] = useState(!tokenMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | null>(null);
  const activeRef = useRef(active); activeRef.current = active;
  const busyRef = useRef(false);
  const clearIdentity = (message?: string) => {
    request.current?.abort(); activeRef.current?.api.dispose();
    setActive(undefined); setToken(''); setPassword(''); setError(message);
  };
  function client(credential = '') {
    return new ControlApi(import.meta.env.VITE_API_BASE_URL || '/api', credential, () => {
      if (activeRef.current) clearIdentity('会话已过期，请重新登录。');
    });
  }
  useEffect(() => {
    if (tokenMode) return;
    const controller = new AbortController(); request.current = controller;
    const api = client();
    void api.session(controller.signal).then(session => {
      if (!controller.signal.aborted) setActive({ api, session });
    }).catch(cause => {
      if (!controller.signal.aborted && !(cause instanceof ApiFailure && cause.status === 401)) setError('暂时无法连接登录服务，请稍后重试。');
    }).finally(() => { if (!controller.signal.aborted) setRestoring(false); });
    return () => controller.abort();
  }, [tokenMode]);
  useEffect(() => () => { request.current?.abort(); activeRef.current?.api.dispose(); }, []);
  async function logout() {
    if (busyRef.current) return;
    busyRef.current = true; setError(undefined);
    try {
      if (!tokenMode) await activeRef.current?.api.logout();
      clearIdentity();
    } catch { setError('退出登录未成功，请检查连接后重试。'); }
    finally { busyRef.current = false; }
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || restoring || (tokenMode ? !token.trim() : !username.trim() || !password)) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    const controller = new AbortController(); request.current = controller;
    let api: ControlApi | undefined;
    try {
      api = client(tokenMode ? token.trim() : '');
      const session = tokenMode ? await api.session(controller.signal) : await api.login({ username: username.trim(), password }, controller.signal);
      if (session.role === 'worker') throw new ApiFailure('执行身份不能登录管理控制台，请使用只读或操作身份。', 403, 'FORBIDDEN');
      setToken(''); setPassword(''); setActive({ api, session });
    } catch (cause) {
      api?.dispose();
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '登录失败');
    } finally { busyRef.current = false; setBusy(false); }
  }
  if (active) return <AuthContext.Provider value={{ ...active, logout: () => { void logout(); } }}>{error && <div className="error-box" role="alert">{error}</div>}{children}</AuthContext.Provider>;
  return <main className="login-page">
    <section className="login-story">
      <div className="brand"><Hexagon size={36}/><div>CrawlerHub<small>采集业务管理系统</small></div></div>
      <div><span className="eyebrow">CRAWL OPERATIONS</span><h1>每一次采集，<br/>都有迹可循。</h1><p>从计划到入库，从等待到回执。<br/>在同一处查看真实业务状态。</p></div>
      <div className="login-foot"><ShieldCheck size={18}/> 独立控制台 · 受控 API · 可追溯结果</div>
    </section>
    <section className="login-form"><div className="login-card">
      <span className="icon-tile"><KeyRound size={25}/></span>
      <h2>连接工作空间</h2><p className="muted">{tokenMode ? '开发令牌登录' : '登录采集管理控制台'}</p>
      <form onSubmit={login}>
        {tokenMode ? <><label htmlFor="access-token">访问令牌</label><input id="access-token" type="password" autoComplete="off" spellCheck={false} required value={token} onChange={e => setToken(e.target.value)} disabled={busy} placeholder="输入只读或操作员令牌"/></> : <>
          <label htmlFor="username">账号</label><input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={64} value={username} onChange={e => setUsername(e.target.value)} disabled={busy || restoring} placeholder="请输入账号"/>
          <label htmlFor="password">密码</label><input id="password" name="password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={e => setPassword(e.target.value)} disabled={busy || restoring} placeholder="请输入密码"/>
        </>}
        {error && <div role="alert" className="error-box">{error}</div>}
        <button className="button primary full" disabled={busy || restoring || (tokenMode ? !token.trim() : !username.trim() || !password)}>{restoring ? '正在恢复登录…' : busy ? '正在验证身份…' : '进入控制台'}<ArrowRight size={16}/></button>
      </form>
      <p className="fine-print">{tokenMode ? '开发令牌仅保存在本次页面内存中。' : '登录状态保留 8 小时，刷新页面后可继续使用。'}</p>
    </div></section>
  </main>;
}
