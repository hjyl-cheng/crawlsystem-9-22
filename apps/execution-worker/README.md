# M1 样本执行 Worker

接口为 `m1.v1`，Node 22.22.1，Temporal TypeScript SDK 1.24.0。只执行受控 API 返回的冻结固定样本；频道、视频和首屏评论经 Ingest 写入。真实采集、真实 Agent/API 和代理留到 M2。

## 安装、构建和检查

主线根锁文件已登记执行客户端和 Worker，使用 `npm ci` 安装固定版本；共享主机使用 `npm run check:safe -- install` 在临时资源限额内完成安装。模块分支同步主线锁文件后沿用同一安装方式。

在仓库根目录依次运行，等待上一个命令退出：

```bash
npm run typecheck --workspace @crawlsystem/execution-worker
npm run build --workspace @crawlsystem/execution-worker
npm run test --workspace @crawlsystem/execution-worker
npm run test:temporal --workspace @crawlsystem/execution-worker
```

以上默认命令都经过 `scripts/check-safe.sh`，需要 Linux systemd user manager、cgroup v2 内存控制器和 `flock`。它通过全局锁串行执行本模块的重型检查，对本次检查及全部子进程建立临时 scope：MemoryHigh=768 MiB、MemoryMax=1 GiB、MemorySwapMax=256 MiB、CPUQuota=150%、TasksMax=256。Node 堆上限 384 MiB，类型检查为 512 MiB（Temporal SDK 声明较大），命令总期限 300 秒；启动时宿主机可用内存须至少 2.5 GiB，运行时低于 1.5 GiB 会停止本次检查。采样保存在忽略的 `.runtime/execution-checks/`。资源控制不可用时直接失败，不回退为无限制运行。

这些限制不修改全用户 slice、容器、swap 或 OOM 服务。2026-09-24 资源事故及修复依据见 [事故记录](docs/resource-incident.md)。swap 只能缓冲，不能代替测试预算。

`build` 预先生成 `dist/workflow-bundle.cjs`；每个 Worker 和重启实例读取同一构建产物，不在进程启动时编译 webpack。`test:temporal` 默认启动 SDK 时间跳跃测试服务器，HTTP/数据库使用替身，仅证明编排行为；需要实际 namespace 验证时使用下述配置。不得并行运行 SDK 集成、全量类型检查和真实联调。

## 配置与启动

以 [`.env.example`](.env.example) 为模板创建仓库根 `.runtime/execution.env`（目录 0700、文件 0600）。Worker 不得加载主 Agent 的 `main.env`：其中含 PG 凭据和 JWT 签名密钥。Worker 启动主动拒绝这类配置。

| 配置 | 用途 |
| --- | --- |
| `CONTROL_API_URL` / `INGEST_API_URL` | 受控 API origin；仅 loopback 允许 HTTP，其他地址必须 HTTPS |
| `WORKER_TOKEN_FILE` | 可轮换 Worker JWT 文件，每次 HTTP 请求重新读取；sub 必须等于 WORKER_ID |
| `WORKER_ID` / `SERVER_ID` / `BUILD_VERSION` | 已配置的实例身份、节点关系和构建版本；并发实例使用独立 Worker 身份与令牌 |
| `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` / `TEMPORAL_TASK_QUEUE` | namespace 必须为 `crawlsystem-m1-*`；每个 queue 绑定一个 workspace |
| `TEMPORAL_TLS_CA_FILE` / `TEMPORAL_TLS_CERT_FILE` / `TEMPORAL_TLS_KEY_FILE` / `TEMPORAL_TLS_SERVER_NAME` | mTLS 引用，必须成组配置 |
| `TEMPORAL_ALLOW_INSECURE_LOOPBACK` | 仅本地临时测试设为 `true`；生产/现场 mTLS 不设置 |
| `WORKER_CAPACITY` | Activity 并发，默认 2，范围 1～20；共享宿主机先用 1 |
| `WORKER_HTTP_TIMEOUT_MS` | 单次 HTTP 超时，默认 5000，范围 100～10000 |
| `WORKER_HEARTBEAT_MS` | 注册心跳周期，默认 20000，范围 1000～30000；Store 90 秒判失联 |
| `WORKER_DRAIN_MS` | SIGTERM 排空期限，默认 15000，范围 1000～60000；SDK 强制关闭期限另加 10 秒 |

```bash
# 先构建，然后在部署进程的内存/CPU 限额内前台运行。
node --env-file=.runtime/execution.env --import tsx apps/execution-worker/src/main.ts

# 使用已有 mTLS namespace 的 SDK 编排验证；配置文件包含 EXECUTION_TEMPORAL_EXISTING=true。
EXECUTION_ENV_FILE=.runtime/execution.env npm run test:temporal --workspace @crawlsystem/execution-worker

# 真实 API/PG/Temporal 验证；operator token 仅测试驱动读取，未注入子 Worker。
EXECUTION_ENV_FILE=.runtime/execution.env npm run test:live --workspace @crawlsystem/execution-worker
```

实际服务部署还需在容器或进程管理器中设置整组内存/CPU 上限；Activity 并发和 V8 堆上限都不能约束 Rust SDK、原生模块和所有子进程的总内存。

## 恢复、取消与预算

Workflow 历史只记录公共输入引用、截止时间、尝试上限和小型状态；不含大样本或令牌。副作用均在 Activity。初次读取及每次执行都验证冻结内容 Hash、Plan/Workspace/Workflow 归属、期限和执行代次。

Workflow 的执行 Activity 最多使用冻结 `max_attempts` 次，HTTP 每次操作最多两次请求尝试；嵌套预算有固定上界，所有写入仍受原 `deadline_at` 限制。API 读取和提交均有单次期限、大小限制、schema 校验和取消信号。API 明确不可重试的授权、代次、协议错误不反复重试；Activity 失败时记录规范类别、phase、attempt、Plan 和请求关联 ID，不记录原始错误、凭据或样本。

Activity 使用公共 `fixtureSubmission`，提交身份和内容不依赖本次进程或 Activity attempt。APPLIED 响应丢失时先读原回执；查询失败直接进入有限重试，不当作未提交。重启读取原 Plan 检查点，不创建新 Plan、不更换输入和观察时间。

缺少 AGENT 时 Store 为 WAITING，Workflow 使用一个持久定时器等待原截止时间；没有模拟的 Agent 结果或代理健康数据。业务完成始终来自 Store。预算耗尽/不可恢复错误尝试上报 FAILED，Store 原子关闭写入权限；上报暂不可用时主 Agent 的到期扫描兜底。

SIGTERM/SIGINT 停止 SDK 接单并有界排空。进程死亡后启动同 queue、同构建兼容版本的 Worker，由 Temporal 心跳超时和原历史恢复。心跳只保存小型 Plan/阶段/回执关联，回执和输入才是业务恢复依据。Control 先持久化取消，再由派发器调用 Temporal cancel；取消后的迟到提交由 Store 拒绝。单独直接取消 Temporal 不会伪造业务 CANCELLED。

## 真实联调脚本

`scripts/live-acceptance.ts` 使用唯一 task queue 和现成的隔离测试 workspace，创建少量计划并保存原回执。通过本地代理转发真实 Ingest 请求，在提交成功后丢失响应、在 VIDEO 前暂停并 SIGKILL 自己创建的 Worker，再启动替代进程；还验证暂时 503、缺 AGENT 等待、取消、迟到旧代次写入、Worker 查询和实际历史重放。

需要额外配置 `OPERATOR_TOKEN_FILE`。可设置 `EXECUTION_BACKEND_ENV_FILE` 指向主 Agent 私有后端环境，让测试驱动启动真实持久意图派发器；该文件仅由派发器读取。未提供时脚本直接调用实际启动适配器，报告不会把它算作派发器集成。不得给 Worker 注入这个文件。测试证据默认保存在 `.runtime/execution-evidence/`，可用 `EXECUTION_EVIDENCE_DIR` 指定目录。

脚本仅取消自己创建的未结束 Plan、关闭自己的进程，保留合法事实与回执。测试中断或主机重启导致无最终结果时必须记录未通过，不能以已生成代码或模块替身结果代替真实联调。

若本机开发 API/转发未运行，可使用 `test:live-local`。它要求 `EXECUTION_BACKEND_ENV_FILE`，启动缺失的 loopback PG/Temporal 转发和 Control/Ingest API，所有子进程仍属于同一个受限 scope。PG 转发使用主 Agent 的自动重连 helper；API 建议配置独立端口（例如 18120/18121）。结束时只停止自己启动的进程，已有监听器保持原状。这个 supervisor 可以读取后端环境，Worker 的实际进程环境会另外核对，拒绝含数据库、签名密钥或 operator 凭据。
