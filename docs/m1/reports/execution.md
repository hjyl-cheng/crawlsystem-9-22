# M1 执行侧准备与交付记录

日期：2026-09-23。状态：已完成 G0 前的入口核对和恢复场景准备；EXEC-01～EXEC-05 尚未实现或验收，不具备业务集成条件。

## 1. 分支与基线

| 项目 | 核对结果 |
| --- | --- |
| 工作目录 | `/home/ubuntu/workspace/crawlsystem-execution` |
| 分支 | `business/m1-execution` |
| 本轮起点 | `8824d7cc6d0a744b172f8b77fa7faabbffcfe985`，任务分工文档提交 |
| 本地可见的主 Agent 分支 | `business/crawler-platform`，本次核对同样指向上述提交 |
| G0 代码基线 | 尚未发现；上述文档提交不是 G0 |
| 公共接口版本、迁移版本 | 尚未发布 |
| 准备工作提交 | 通过 `git log -1 --format=%H -- docs/m1/reports/execution.md` 查询；该提交只包含准备文档 |
| 初始改动状态 | 干净 |

已阅读[共同规则](../README.md)、[执行任务](../agent-execution.md)、[主 Agent 任务](../agent-main.md)、开发计划和旧系统字段参考。当前主分支的 `packages/`、`apps/` 及 `docs/m1/integration-baseline.md` 尚不存在，不能按未发布的接口编写另一套业务协议。

本次交付仅新增本报告；公共类型、根依赖、数据库、API 和其他 worktree 均未修改。

## 2. 提交给 G0 的执行侧接口需求

以下是对主 Agent 的语义需求，具体字段名、路径、枚举、Schema 与样本由 `packages/contracts/` 统一发布。本报告不定义替代协议。

| 能力 | 调用上下文 / 输入 | 必须返回或保证的语义 | 验收关联 |
| --- | --- | --- | --- |
| Temporal 启动接口 | 已持久化的业务执行身份、输入版本和引用、隔离环境、任务队列 | 稳定 Workflow ID 的唯一算法；同身份重复派发的结果；已有 Workflow 的归属、类型和输入版本核对方式；已关闭执行的重复派发及保留期边界 | E01～E03 |
| 冻结输入读取 | 被授权的执行身份及输入引用 | 不可变版本或摘要；有界的样本及目标顺序；样本标识；执行代次；必需领域；总期限；恢复保留期；输入不匹配的明确错误 | E04、E12 |
| 检查点与执行权限 | 同一原 Plan、执行代次和调用身份 | 原回执关联、已完成目标、仍可执行范围、已消耗预算与取消状态；事实与 APPLIED 回执原子更新；检查点不能仅在 Worker 内存中 | E04～E08 |
| Submission 创建与校验 | 冻结样本、声明领域、稳定目标或分块身份 | 公共构造/规范化/摘要规则；稳定提交 ID 算法；时间和版本字段的来源；大小上限；同 ID 同内容重放与异内容冲突样例 | E05、E06、E09 |
| Ingest 提交与回执查询 | 原提交身份、原内容、对象级授权 | 持久 APPLIED；未找到与查询失败可区分；响应丢失后核对原回执；如有 RECEIVED，明确实际持久接管及后续查询规则 | E05、E07、E10 |
| 取消、旧代次和授权失败 | 当前 Plan / 代次与期望版本 | Store 拒绝失效代次和取消后的新写入；保留授权查询已成功回执的能力；统一错误分类、可重试性与业务关联 | E08、E09 |
| 预算与等待 | HTTP 请求、Activity 重试、依赖等待、业务执行的各层上下文 | 总期限的权威起点；有限次数与单次超时；预算是否需持久消费及其 API；等待恢复机制；不可重试错误及预算耗尽语义 | E07、E11、E12 |
| Worker 注册、心跳与阶段 | 实例身份、节点关系、构建版本、接单状态及当前执行关联 | 服务端心跳有效期与失联语义；并发执行关联方式；阶段/错误/最近回执查询；退出上报失败不改变业务完成事实 | E13、E14 |
| Store 结果读取 | 原 Plan 与授权身份 | 权威领域结果和 Plan 结果；完整成功、尚缺领域与流程结束的区分；真实 Agent/API 未实现的明确表示 | E10、E11 |
| 工程和隔离环境 | 执行模块及启动客户端 | Node、包管理器、TypeScript、Temporal SDK 固定版本；根锁文件；Control/Ingest 地址与身份注入方式；Temporal namespace / queue；隔离数据范围；启动和检查命令 | 全部 |

需要重点避免的接口歧义：

- 若 Submission 的内容包含观察时间，必须来自冻结输入或其他可恢复的固定值；Activity 重试时重新取当前时间会把同一提交变成异内容冲突。
- 用于回执核对的摘要只覆盖公共契约声明的内容，Worker 实例、Activity attempt、PID 等诊断信息不得意外改变稳定业务提交。
- 工作流已经存在不代表派发成功；同名但不同对象、输入版本或 Workflow 类型必须拒绝。关闭后的重复派发也不能自动创建第二次业务执行。
- 查询回执失败不等于未找到。取消或执行代次失效后，能否读取原回执与能否新增写入须分别授权。
- 预算若只存在进程内存，重启会重置；若只限定单个 Activity attempt，HTTP 与 Activity 嵌套重试仍可能放大请求数。总期限及需要严格累计的业务预算必须有持久依据。

## 3. G0 后的实现边界

`packages/execution-client/` 实现公共启动接口、Temporal 连接配置与关闭，以及受控 HTTP 调用。地址、证书路径和服务身份由环境注入；不使用源码中的现场地址、密码或证书。

`apps/execution-worker/` 包含 Workflow、Activity、进程生命周期、状态上报和模块测试。Workflow 只协调确定性步骤，历史中传递输入引用和小型结果；Activity 负责读取冻结输入、检查授权和检查点、按契约构造 Submission、核对回执及调用 Ingest。具体拆分按 G0 输入上限和检查点粒度确定。

恢复时继续原 Plan、原输入版本和原预算。开始新一轮提交前读取权威检查点；已 APPLIED 的目标由原回执确认。提交超时后查询原身份，必要时仅重传原身份及同内容；不得以新 Plan、新随机提交 ID 或新观察时间规避冲突。

HTTP 重试有单次超时和有限次数；Activity 由 Temporal 在有限总期限内重试。执行代次失效、授权拒绝、协议冲突与取消按公共错误处理。依赖等待使用持久协调机制和明确期限，不能不断新建 Activity 重置业务预算。业务重试的批准和预算由公共 API 决定。

Workflow 结束并不自行设置业务完整成功。执行结果以 Store 的领域与 Plan 状态为准；未接入的真实 Agent/API 保持未完成或依赖等待，固定样本不冒充真实结果。

停止流程先停止接单，再在配置期限内排空 Activity 并关闭连接；超时未完成项依赖 Temporal 和受控 API 恢复。取消传播用于及时停止副作用，最终写入围栏仍由 Store 判断。

Worker 上报实例/节点/版本、接单状态、有效心跳、当前 Plan/阶段、最近回执及规范错误。日志仅记录必要的关联和有界诊断，避免凭据与整份样本。固定样本阶段报告代理未使用/未配置。

## 4. 待执行的恢复与验收场景

本表全部为待实现/待运行，尚无通过结果。模块替身验证、Temporal SDK 验证和真实 Control/Ingest/PG 联调分别记录；关键数据库事实由主 Agent 的隔离集成测试核对，Worker 不获得 PG 凭据。

| 编号 | 注入位置或前置条件 | 必须核对的结果 | 验证层 |
| --- | --- | --- | --- |
| E01 | 相同启动意图并发派发；Temporal 接收启动后丢失响应 | 同一业务执行和 Workflow；再次派发核对原归属/输入，不产生第二个 Plan | 客户端边界 + 真实 Temporal |
| E02 | 已有同名 Workflow 使用不同对象、输入版本或类型 | 明确冲突，不确认启动意图成功 | 客户端边界 + 真实 Temporal |
| E03 | Plan 已持久化但未启动时派发器崩溃；工作流关闭后再次派发 | 持久启动意图恢复；关闭后重复派发遵循同一业务身份及保留期约定 | 主 Agent + 执行集成 |
| E04 | 首条提交前、部分目标 APPLIED 后分别 SIGKILL Worker，再启动新的进程 | 恢复原 Plan、冻结输入和剩余目标；新实例可追踪；预算和已完成事实不重置 | 真实 Temporal + Control/Ingest/PG |
| E05 | Ingest 事务提交后、HTTP 响应送达前断开连接 | 查询得到原 APPLIED 回执；同提交仅一个业务效果 | 模块故障注入 + 真实集成 |
| E06 | Activity 完成结果写回 Temporal 前 Worker 死亡；重复或重叠执行同一活动 | 原提交 ID 和摘要相同；重复请求返回同一持久回执 | SDK + 真实集成 |
| E07 | Ingest 暂时 503、连接失败或超时；回执查询也暂时不可用 | 有限重试；查询失败不当作未提交；恢复后核对原回执；期限耗尽可追踪 | 模块 + SDK + 真实集成 |
| E08 | 取消发生在读取权限后、提交前；提交已 APPLIED 后才取消 | 取消后的迟到新写入被拒绝；合法原回执仍可核对；已有事实不撤销、不误报完整成功 | 主 Agent + 执行集成 |
| E09 | 旧代次、错误对象权限、同 ID 异内容分别提交 | 统一错误分类；拒绝新写入；不无限重试；原事实与回执不被覆盖 | 模块 + 真实集成 |
| E10 | APPLIED 后读取检查点；如契约支持 RECEIVED，则暂未 APPLIED | APPLIED 与进度一致；RECEIVED 不计完成，持久查询后才推进 | 契约 + 真实集成 |
| E11 | 样本必需领域缺失或要求未接入的真实 Agent/API | 不伪造产出；依赖未满足时不宣称业务完整成功；等待/取消有确定结果 | SDK + 真实集成 |
| E12 | 接近总期限时重启；输入引用丢失/摘要不符；等待期间取消 | 不延长总期限或清零已消耗预算；输入不可用明确失败；等待可取消 | 模块 + SDK + 真实集成 |
| E13 | SIGTERM、有在途活动、关闭期间状态上报失败 | 停止接单并有界排空；未完成项可恢复；上报失败不覆盖原业务错误 | 进程 + 真实 Temporal |
| E14 | Worker 失联和恢复；多个活动并发；一个 Plan 失败 | 查询 API 可关联实例、节点、版本、阶段、回执与错误；心跳过期可见；无虚构代理信息 | 主 Agent查询 + 执行集成 |
| E15 | 超过请求大小/并发预算；检查 Workflow 副作用及重放 | 有界拒绝或背压；历史/心跳不包含大样本；SDK 测试及代表性历史重放保持确定性 | 模块 + SDK + 集成 |

每项证据应包含：代码及契约版本、隔离环境引用、原 Plan/Workflow/Submission 身份、输入与提交摘要、故障触发点、重启前后回执和权威结果、已消耗预算及总期限、实际命令和退出结果。敏感身份凭据不进入证据。

## 5. 已执行的核对及参考结论

| 命令 / 检查 | 结果 | 证据范围 |
| --- | --- | --- |
| `git branch --show-current` | `business/m1-execution` | 分支确认 |
| `git status --short`（修改前） | 无输出 | 初始工作区干净 |
| `git rev-parse HEAD` | `8824d7cc6d0a744b172f8b77fa7faabbffcfe985` | 文档起点 |
| `git log -5 --oneline business/crawler-platform` | 最新为任务文档提交 | 仅本地可见分支，未声称远端无新提交 |
| `git ls-tree -r --name-only business/crawler-platform docs/m1 packages apps` | 只有四份 M1 任务/协作文档 | 尚无本地 G0 工程与契约 |
| `git -C /home/ubuntu/workspace/oldsystem rev-parse HEAD` | `e92d9227a5a3847430e5d062bea13227564ee419` | 与固定参考版本一致 |
| `node --version` / `npm --version` | `v22.22.1` / `9.2.0` | 仅现场工具探测，非工程版本决策 |
| `command -v temporal` | 未找到，退出码 1 | 本地 PATH 无 CLI；不证明远端服务不可用 |

旧系统只做只读参考，未运行其服务或测试：

- `services/qybullmq/src/remoteNodes/executionContext.js`：冻结计划与恢复上下文需区分，不能随意删字段绕过校验。
- `services/qybullmq/src/remoteNodes/workerRetirement.js`：停止接单与在途执行排空需要分别核对。其 SQL、BullMQ 和锁协议不移植。
- `services/qybullmq/test/migrationRetryIntentPostCommit.worker.postgres.redis.integration.test.js`：参考“业务已提交、队列确认前进程退出”的故障窗口；新测试使用 Temporal 与 Ingest，不复用其中直接 SQL 或清库逻辑。
- `services/qybullmq/test/channelSnapshotAttemptFence.worker.postgres.redis.integration.test.js`：参考被接管后的旧活动迟到写入场景；新实现以公共执行代次和 Store 写入围栏为准。

现有 `docs/crawlsystem-infra-a1-s3/examples/temporal-smoke.py` 为独立 Python 基础设施 echo 冒烟，使用 TLS 并通过端口转发接入。它既不是 M1 Workflow，也未在本轮运行；既有基础设施报告不能计为 E01～E15 通过。

## 6. 启动、验证与后续交付

当前没有可构建或启动的执行应用，因此不提供虚假的 build/start/test 命令，也没有新增迁移。G0 发布后按具体 SHA 合并，采用统一工具链实现，再记录真实命令和结果。

G0 配置需覆盖：Temporal 地址、namespace、Task Queue、TLS CA/客户端证书/密钥引用及服务端名称；Control/Ingest 地址和服务身份；Worker/节点/构建身份；并发、HTTP/Activity 时间与次数预算、心跳和排空期限。实际变量名使用主 Agent 配置模板，Worker 配置不包含 PG 连接凭据。

下一交付顺序：同步 G0 → 启动适配器 → 样本 Activity 与确定性 Workflow → 回执恢复/预算/取消 → 状态上报/进程退出 → SDK 与真实隔离链路验证 → 本分支提交实现及证据，由主 Agent 按具体提交集成。

当前阻塞项是 G0 代码与固定 SHA、公共接口样例、隔离测试资源及运行配置。真实采集、本地代理和真实 API/Agent 按 M2 接入；本次未宣称 M1 或 M2 完成。
