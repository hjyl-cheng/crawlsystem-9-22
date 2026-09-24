import { z } from 'zod';
import {
  ApiRoutes, ApiErrorSchema, SessionSchema, PlanSchema, PlanDetailSchema,
  ChannelListItemSchema, ChannelDetailSchema, CompletenessSchema, ConsoleAccountListSchema, PlansSummarySchema, WorkerSchema, StoredEventSchema,
  ReceiptSchema, CreatePlanSchema, CancelPlanSchema, LoginSchema, LogoutSchema, pageSchema, ProxyOverviewSchema, ProxyImportSchema, ProxyUpdateSchema, ProxyViewSchema, ProxySourceCreateSchema, ProxySourceUpdateSchema, ProxySourceViewSchema,
  type CreatePlan, type ProxyImport, type ProxySourceCreate, type ErrorCode, type PlanStatus, type Login,
} from '@crawlsystem/contracts';

const messages: Record<ErrorCode, string> = {
  INVALID_REQUEST: '请求内容不符合要求', UNAUTHENTICATED: '登录已失效，请重新登录',
  FORBIDDEN: '当前身份没有执行此操作的权限', NOT_FOUND: '对象不存在或不在可访问范围内',
  CONFLICT: '状态或操作身份发生冲突，请刷新核对', STALE_EXECUTION: '执行代次已过期',
  PLAN_TERMINAL: '本轮计划已经结束', INPUT_MISMATCH: '计划输入版本不一致',
  TARGET_MISMATCH: '结果超出本轮目标范围', DOMAIN_INCOMPLETE: '必需领域结果尚未完整',
  DOMAIN_NOT_REQUIRED: '该领域不属于本轮目标', DEPENDENCY_NOT_IMPLEMENTED: '所需能力尚未接入',
  BUDGET_EXHAUSTED: '本轮执行预算已耗尽', UNAVAILABLE: '服务暂时不可用', INTERNAL_ERROR: '服务处理失败',
};

export class ApiFailure extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly code: ErrorCode | 'NETWORK' | 'SCHEMA' | 'TIMEOUT' = 'NETWORK',
    public readonly retryable = false,
    public readonly correlationId?: string,
    public readonly detail?: string,
    public readonly retryAfterMs = 0,
  ) { super(message); }
}

export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  if (value.startsWith('/') && !value.startsWith('//') && !/[?#\\]/.test(value)) return value;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址必须是 HTTP(S) 地址或同源路径，不能包含凭据、查询或片段。');
  }
  return value;
}

export class ControlApi {
  readonly baseUrl: string;
  constructor(baseUrl: string, private token = '', private unauthorized: () => void = () => {}, private timeoutMs = 10_000) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }
  dispose() { this.token = ''; }

  private async request<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal, body?: unknown): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Accept: 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Console-Request': '1' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store', credentials: this.token ? 'omit' : 'include', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      });
      // Check authentication even when a gateway returns a non-JSON error page.
      if (response.status === 401 && path !== ApiRoutes.login) this.unauthorized();
      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const parsed = ApiErrorSchema.safeParse(raw);
        const error = parsed.success ? parsed.data.error : undefined;
        const retryAfter = response.headers.get('retry-after');
        const retryMs = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
        throw new ApiFailure(
          path === ApiRoutes.login && response.status === 401 ? '账号或密码不正确' : path === ApiRoutes.login && response.status === 429 ? '登录尝试过于频繁，请稍后再试' : error ? messages[error.code] : response.status === 401 ? messages.UNAUTHENTICATED : response.status === 403 ? messages.FORBIDDEN : '接口请求失败',
          response.status, error?.code ?? 'UNAVAILABLE', error?.retryable === true,
          error?.correlation_id, error?.message, Number.isFinite(retryMs) ? Math.max(0, retryMs) : 0,
        );
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new ApiFailure('接口数据与公共契约不兼容，请联系维护人员', response.status, 'SCHEMA');
      return parsed.data;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      if (error instanceof ApiFailure) throw error;
      if (timeout.signal.aborted) throw new ApiFailure('请求超时，操作结果需要核对', 0, 'TIMEOUT', true);
      throw new ApiFailure('无法连接服务，请检查网络后重试', 0, 'NETWORK', true);
    } finally { clearTimeout(timer); }
  }

  session = (signal?: AbortSignal) => this.request(ApiRoutes.session, SessionSchema, signal);
  login = (body: Login, signal?: AbortSignal) => this.request(ApiRoutes.login, SessionSchema, signal, LoginSchema.parse(body));
  logout = (signal?: AbortSignal) => this.request(ApiRoutes.logout, LogoutSchema, signal, {});
  plans = (cursor = '0', status?: PlanStatus, limit = 20, signal?: AbortSignal) => this.request(`${ApiRoutes.plans}?${new URLSearchParams({ limit: String(limit), cursor, ...(status ? { status } : {}) })}`, pageSchema(PlanSchema), signal);
  plan = (id: string, signal?: AbortSignal) => this.request(ApiRoutes.plan(id), PlanDetailSchema, signal);
  create = (body: CreatePlan, signal?: AbortSignal) => this.request(ApiRoutes.plans, PlanSchema, signal, CreatePlanSchema.parse(body));
  cancel = (id: string, body: z.infer<typeof CancelPlanSchema>, signal?: AbortSignal) => this.request(ApiRoutes.cancel(id), PlanSchema, signal, CancelPlanSchema.parse(body));
  channels = (cursor = '0', limit = 20, signal?: AbortSignal) => this.request(`${ApiRoutes.channels}?${new URLSearchParams({ limit: String(limit), cursor })}`, pageSchema(ChannelListItemSchema), signal);
  plansSummary = (signal?: AbortSignal) => this.request(ApiRoutes.plansSummary, PlansSummarySchema, signal);
  completeness = (signal?: AbortSignal) => this.request(ApiRoutes.completeness, CompletenessSchema, signal);
  consoleAccounts = (signal?: AbortSignal) => this.request(ApiRoutes.consoleAccounts, ConsoleAccountListSchema, signal);
  channel = (id: string, signal?: AbortSignal) => this.request(ApiRoutes.channel(id), ChannelDetailSchema, signal);
  workers = (cursor = '0', limit = 20, signal?: AbortSignal) => this.request(`${ApiRoutes.workers}?${new URLSearchParams({ limit: String(limit), cursor })}`, pageSchema(WorkerSchema), signal);
  errors = (cursor = '0', limit = 20, signal?: AbortSignal) => this.request(`${ApiRoutes.errors}?${new URLSearchParams({ limit: String(limit), cursor })}`, pageSchema(StoredEventSchema), signal);
  receipt = (id: string, signal?: AbortSignal) => this.request(ApiRoutes.receipt(id), ReceiptSchema, signal);
  proxies = (signal?: AbortSignal) => this.request(ApiRoutes.proxies, ProxyOverviewSchema, signal);
  importProxies = (body: ProxyImport, signal?: AbortSignal) => this.request(ApiRoutes.proxyImport, z.strictObject({ created: z.number().int(), updated: z.number().int() }), signal, ProxyImportSchema.parse(body));
  proxySources = (signal?: AbortSignal) => this.request(ApiRoutes.proxySources, z.strictObject({ items: z.array(ProxySourceViewSchema).max(50) }), signal);
  createProxySource = (body: ProxySourceCreate, signal?: AbortSignal) => this.request(ApiRoutes.proxySources, ProxySourceViewSchema, signal, ProxySourceCreateSchema.parse(body));
  updateProxySource = (id: string, body: z.input<typeof ProxySourceUpdateSchema>, signal?: AbortSignal) => this.request(ApiRoutes.proxySource(id), ProxySourceViewSchema, signal, ProxySourceUpdateSchema.parse(body));
  updateProxy = (id: string, body: z.input<typeof ProxyUpdateSchema>, signal?: AbortSignal) => this.request(ApiRoutes.proxy(id), ProxyViewSchema, signal, ProxyUpdateSchema.parse(body));
}
