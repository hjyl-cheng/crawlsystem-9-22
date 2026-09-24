# M1 执行侧交付报告

日期：2026-09-24。状态：EXEC-01～EXEC-04 已实现，EXEC-05 执行侧模块、Temporal SDK 和真实链路验证通过；待主 Agent 集成根锁文件及业务主线。真实采集/代理/Agent/API 属于 M2，本报告不宣布整个 M1 已验收。

## 1. 分支、版本与范围

- 分支：`business/m1-execution`。
- G0：`ca3973f43d4ee3bc355cb0cc3ab1a373f5292a92`；接口 `m1.v1`。
- 本轮已同步的主线：`fe7d02bdb31722c91a444661e054c64d09f533d3`；本分支合并起点 `adf6492d2b28c8974fbfb0f45fd3241bf8ab9b81`。
- 本轮交付提交：用 `git log -1 --format=%H -- apps/execution-worker packages/execution-client docs/m1/reports/execution.md` 获取；代码文件的确切 SHA-256 另存于[源码清单](../../../apps/execution-worker/docs/evidence/source-sha256.json)。
- Node `22.22.1`、npm `9.2.0`、TypeScript `5.9.3`、Temporal SDK `1.24.0`。
- 只修改 `apps/execution-worker/`、`packages/execution-client/` 和本报告。公共 Schema、根依赖/锁文件、数据库迁移、Control/Ingest 实现未修改。早期“G0 未发布”的准备报告已由本报告替代，历史保留在 Git。

## 2. 实现结果

| 任务 | 交付内容 |
| --- | --- |
| EXEC-01 | `createWorkflowStarter(options)` 实现公共 start/cancel/close；稳定 Workflow ID、REJECT_DUPLICATE、超时回查；核对原始历史的类型、Task Queue、完整 WorkflowInput；关闭后重复派发仍返回原 run_id；不把不存在的取消直接确认成功 |
| EXEC-02 | 确定性 `fixturePlanWorkflow`；所有 HTTP 副作用在 Activity；通过 API 验证冻结输入 Hash/归属/版本/检查点；复用公共 `fixtureSubmission` 生成频道、视频和评论；权威结果取自 Store |
| EXEC-03 | APPLIED 响应丢失先核对原回执；相同身份/内容重传；Activity 有限尝试和 HTTP 最多两次；原 deadline 不变；缺 AGENT 使用持久定时器；取消、旧代次、授权/协议错误有明确退出；SIGTERM 有界排空 |
| EXEC-04 | Worker/节点/构建身份、接单状态、心跳、活动 Plan 和阶段/回执/错误关联；实际 API 身份必须匹配 Worker ID；日志不带凭据或大样本；代理由公共接口表示 NOT_CONFIGURED |
| EXEC-05 | 模块与 SDK 测试、真实 mTLS Temporal → Worker → Ingest → PG 联调、强杀恢复、历史重放、运行说明和资源事故修复；代码待主线集成 |

Workflow 历史不保存冻结样本。真实恢复历史中 7 个载荷最大为 299 字节；保存原输入引用、期限及小型结果。心跳也不承担业务持久化职责。

Worker 启动拒绝 PG 连接凭据和 JWT 签名密钥；真实联调读取了 Worker 子进程的实际环境变量名核对隔离，证据不包含变量值。测试驱动的 operator token 和后端环境文件只供驱动/API/派发器使用。

## 3. 实际验证命令与结果

以下命令在仓库根执行，全部串行，默认通过临时资源 scope 限制本次命令及所有子进程。

| 命令 | 结果与范围 |
| --- | --- |
| `npm run typecheck --workspace @crawlsystem/execution-worker` | 通过；执行客户端、Worker、脚本/测试及导入的公共契约 |
| `npm run build --workspace @crawlsystem/execution-worker` | 通过；生成 Workflow bundle，重启 Worker 只加载产物 |
| `npm run test --workspace @crawlsystem/execution-worker` | 17/17 通过；HTTP/启动边界与 SDK MockActivityEnvironment，不冒充数据库验收 |
| `bash apps/execution-worker/scripts/check-safe.sh contracts` | 公共契约 3/3 通过 |
| `npm run test:temporal --workspace @crawlsystem/execution-worker` | 4 个 SDK 场景通过（含父套件 TAP 为 5/5）；测试服务器上的重复启动、持久等待截止、恰好 3 次 Activity 重试、取消及各场景历史重放 |
| `EXECUTION_ENV_FILE=.runtime/execution.env npm run test:live-local --workspace @crawlsystem/execution-worker` | 11 项真实链路检查通过；现有 mTLS Temporal、实际 Control/Ingest/PG、实际子 Worker 和持久派发器 |

SDK 用例在真实服务器之前使用测试服务器及受控替身；真实联调未模拟 Store/回执。故障代理只转发真实 Ingest 请求，并在实际提交后丢弃响应或在提交前注入暂停/503。

证据：[验证日志](../../../apps/execution-worker/docs/evidence/validation.log)、[真实联调结果](../../../apps/execution-worker/docs/evidence/live-results.json)、[恢复历史](../../../apps/execution-worker/docs/evidence/recovered-history.json)、[资源采样](../../../apps/execution-worker/docs/evidence/resources.json)。最终补充了公共契约允许带 `/` 的 workspace ID 取消校验，对该修改再次跑过类型检查、17 项模块测试和 3 项契约测试。

## 4. 真实链路结果

环境：现有 `crawlsystem-m1-main` namespace；每次生成独立 `execution-live-*` queue；隔离 workspace `m1-execution-20260924`；本机临时 Control/Ingest 端口 18120/18121；测试库由主 Agent 后端配置引用。没有清库、修改迁移或接管其他进程。

恢复 Plan：`0d4e8f7b-2cff-44f9-af63-b0af90538ad9`。Temporal run：`01a0d171-ea63-713f-8099-f067507ebb42`。具体输入 Hash、期限、原回执、事件和其他计划 ID 在真实联调结果中。

| 场景 | 实际观察 |
| --- | --- |
| 持久启动意图 | 创建 Plan 后再启动派发器，可靠启动原 Workflow；派发器退出不丢在途执行 |
| 响应丢失 | ABOUT 已由 Ingest 应用后断开响应；Worker 查询原 APPLIED 回执，ABOUT 只发送一次 |
| Worker SIGKILL/重启 | 在 VIDEO 提交前杀掉实际 Worker；新进程从原输入和检查点恢复，未更改 Plan/input_hash/deadline；历史中执行 Activity attempt 为 2 |
| Ingest 暂时不可用 | 恢复后注入一次 503；有限重试仍发送相同 VIDEO 身份和内容 |
| 重复派发 | 执行中和关闭后都返回原 Workflow/run；错误输入 Hash 被拒绝 |
| 回执与事实 | 恢复 Plan 为 COMPLETED，只有 ABOUT/VIDEO 两条回执；多次计划和重试后当前视频 1 条、评论 1 条，无重复增长 |
| 缺 AGENT | 两个可实现领域已 APPLIED，AGENT 为 PENDING，Store/Workflow 保持 WAITING/RUNNING；取消后业务为 CANCELLED |
| 取消后迟到提交 | ABOUT 已应用、VIDEO 尚未提交时取消；旧代次 VIDEO 被真实 Store 拒绝，仅保留原 ABOUT 回执；原回执仍可查询及重放 |
| Worker 状态 | 实际身份/版本/心跳可查询，proxy_status 为 NOT_CONFIGURED；SIGTERM 在期限内退出 |
| 历史重放 | 实际恢复后的 Temporal 历史经 Worker.runReplayHistory 通过 |

业务状态与 Temporal 终态分别处理：控制取消使 Workflow 进入取消终态；业务状态来自 Store，不能据 Workflow completed/failed 自行推导完整成功。

## 5. 资源事故与实际修复

09:25～09:27 的开发验证重叠启动缺乏整组资源上限。宿主机无 swap，随后出现内存压力、85%～90% iowait 和 SSH 超时，测试并发很可能是触发因素。没有逐进程历史 RSS，不能假称已证明某一个进程的具体占用；事故期间未得到完整测试结果，均不计通过。详见[事故记录](../../../apps/execution-worker/docs/resource-incident.md)。

用户已让 Claude 恢复 2 GiB swap、swappiness=10，并明确不设置全用户内存上限/earlyoom。执行侧没有修改这些系统决定，而是修复自身行为：

- 默认构建/检查命令使用锁串行，对本次检查及所有子进程设置临时 MemoryHigh=768 MiB、MemoryMax=1 GiB、MemorySwapMax=256 MiB、CPUQuota=150%、300 秒期限。
- 宿主机可用内存不足 2.5 GiB 时拒绝启动，低于 1.5 GiB 时结束本次检查；不支持资源边界时直接失败。
- Worker 加载预构建 bundle，不在每次重启时运行 webpack；缓存上限从初始实现的 100 降为 10。
- 测试 API、转发、派发器和 Worker 同属于受限进程组；退出时回收自己创建的进程。PG 转发使用主线重连 helper，测试驱动有界重试且不更换幂等请求身份。

最终 Temporal SDK 场景采样峰值约 257 MiB；完整真实联调约 653 MiB，后者宿主机最低可用约 3.35 GiB。数字是 1 秒采样值，不是容量承诺。最初 384 MiB 编译器堆不足导致检查退出；最终类型检查采用 512 MiB 堆、整组 1 GiB 上限不变并通过。swap 只是缓冲，不保证不会再发生内存压力。

## 6. 运行与主线集成

完整命令、环境变量、停止与恢复步骤见 [Worker 说明](../../../apps/execution-worker/README.md)和[客户端说明](../../../packages/execution-client/README.md)。新增迁移：无。

1. 主 Agent 合并本次具体提交，统一更新根锁文件以登记 `@crawlsystem/execution-client`、`@crawlsystem/execution-worker` 两个 workspace；使用已有 SDK 版本，没有要求新版本依赖。执行分支未越权修改根锁文件，本地验证使用 `npm install --package-lock=false --no-save`。
2. 更新锁文件后 `npm ci`，构建 Workflow bundle，按 `.env.example` 注入 API/Temporal-only 的 Worker 配置。Worker 实际部署仍需容器或进程管理器整组内存限额。
3. 主 Agent 的既有 `dev:dispatcher` 动态导入本客户端即可接入真实执行。一个 queue 对应一个 workspace，Worker JWT sub 对应实例 ID；开发令牌默认 1 小时，到期需更新文件。
4. 保留 DONE 意图和原 Plan：Temporal 历史保留 7 天后，服务本身不能仅凭 ID 区分从未运行和已被清理的旧执行。主线不得把已关闭/过期 Plan 重新派发；适配器不创建新 Plan。

本次不包括真实采集、真实 Agent/API、节点本地代理、生产容量或业务前端的最终联合验收；后两项由主 Agent 按整体验收安排。执行模块已具备主线集成条件，根锁文件登记是明确的集成步骤，不把当前分支的 `npm ci` 报为已经通过。
