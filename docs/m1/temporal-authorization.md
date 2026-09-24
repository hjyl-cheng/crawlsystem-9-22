# Temporal namespace 授权

更新：2026-09-24。解决运行权限审计发现的问题：Temporal CA 签发的任何证书都能读取其他 namespace（`runtime-access.json` 中 `other_namespace_describe: ALLOWED`）。

## 设计

- Temporal 启用默认的 JWT claim mapper 和 authorizer（`values/temporal.yaml` → `server.config.authorization`）。公共 frontend（7233）只接受带 `Authorization: Bearer <JWT>` 的请求，由 `permissions` 声明决定 namespace 与角色，例如 `crawlsystem-m1-main:write`。
- ES256 私钥为 `.runtime/temporal-jwt/signing.pem`（不进 Git），只放入 Secret `control/temporal-jwt-signing`。Temporal 通过 `file://` 读取 ConfigMap `temporal/temporal-jwks` 中的公钥，每分钟刷新，不访问 Control。Key ID 取公钥 SHA-256 的前 16 位。
- 客户端用 ServiceAccount 令牌调用 Control 的 `POST /v1/workload/temporal-token`，经 TokenReview 核验后按 `TEMPORAL_WORKLOAD_PERMISSIONS` 签发 15 分钟令牌；客户端在半程刷新，通过 `setApiKey` 切换：

| ServiceAccount | 权限 | 用途 |
| --- | --- | --- |
| `crawler/execution-worker` | `crawlsystem-m1-main:read`、`:worker` | 轮询与完成任务；不能启动或取消 Workflow |
| `control/intent-dispatcher` | `crawlsystem-m1-main:write` | 启动、核对历史、取消 |

  Control 不会签发 `system:*` 或 `admin` 权限；权限格式不符的令牌在签发端和契约中都会被拒绝。
- Temporal 自身的 worker 服务、admintools 和 UI 改走 **internal-frontend**（7236，不做授权）。`temporal-internal` NetworkPolicy 只对 `temporal` 命名空间开放 7236/6936。UI 没有逐用户的 JWT，只能在集群内访问；如需公开访问，需另行接入 OIDC。
- 本机工具：`node --import tsx scripts/dev/temporal-token.ts <文件> <ns>:<role>` 签发 1 小时令牌，配合 `TEMPORAL_API_KEY_FILE` 使用；只能签发 read/write/worker。

## 本地验证（temporal-server 1.32.0，SQLite，与集群相同的授权配置）

- 无令牌返回 `PERMISSION_DENIED`；`m1:write` 令牌可以在 m1 中 describe、启动、取消，但 describe 或启动 `crawlsystem`、列出全部 namespace 均被拒绝。
- 过期令牌在连接阶段即被拒绝；`setApiKey` 换成其他 namespace 的令牌后立即按新权限生效。
- 只有 `worker` 权限的 Worker 无法通过启动时的 namespace 检查；`read`+`worker` 能正常轮询。`createWorkflowStarter` 的幂等启动与取消在 `write` 令牌下通过。
- JWKS 变更后必须配置 `refreshInterval` 新密钥才会生效（集群配置为 1 分钟）。

## 集群验证

- 第一步已部署（`fb2469b`）：Control 签发 Temporal 令牌，派发器与 Worker 已携带令牌连接；此时 Temporal 尚未启用授权，令牌被忽略。预览验收 6 项通过（执行、心跳、四服务追踪、Worker 替换、持久取消）。

## 启用顺序

1. `deploy-preview.ts`：发布签名密钥和 JWKS，派发器与 Worker 开始携带令牌（已完成）。
2. `node --env-file=.runtime/main.env --import tsx scripts/dev/temporal-authz.ts enable`：预检（JWKS 存在、两个客户端已配置令牌、工作区干净）→ 应用 `temporal-internal` → `helm upgrade` → 验证无令牌和跨 namespace 访问被拒。脚本会记录升级前的 revision。
3. 回退：`... temporal-authz.ts rollback`（helm rollback 到记录的 revision）。

影响：
- Helm 升级会重启 a1 上的 Temporal（单副本），Workflow 状态持久保存，重启后继续。
- 新增一个 internal-frontend Pod。`temporal_svc` 连接上限 45，当前实际 6 个连接；最坏情况下全部连接池之和会超过上限，需要监控。
- `crawlsystem` namespace 的其他客户端（基础设施 smoke/观察器）需要 `crawlsystem:write` 令牌或改走 internal-frontend。

密钥轮换：生成新的 `signing.pem`，旧文件改名为 `previous.pem` 后重新部署（JWKS 同时发布两个公钥）；待旧令牌全部过期（≤15 分钟）后删除 `previous.pem` 再部署一次。
