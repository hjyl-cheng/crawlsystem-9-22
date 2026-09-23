# 执行 Agent：Temporal、样本 Worker 与恢复

工作目录：`/home/ubuntu/workspace/crawlsystem-execution`

分支：`business/m1-execution`

共同规则：[M1 协作与验收](README.md)。

## 1. 交付目标与边界

把主 Agent 创建的样本 Plan 接入 Temporal：读取受控冻结输入，执行样本 Activity，生成稳定 Submission，经 Ingest 获取持久回执，并在中断后恢复原计划。

负责 `apps/execution-worker/`、`packages/execution-client/` 及其测试、运行说明。公共状态/协议、数据库和 Control/Ingest API 由主 Agent 提供。本轮不复制旧脚本的 SQL、BullMQ、Rota 或 Finalize 调度；真实采集与节点本地代理在 M2 另行接入。

## 2. 开始前

- 确认目录、分支和改动状态，阅读共同规则、开发计划、字段参考。
- 检查主 Agent 发布的 G0 commit SHA、公共契约、Worker 配置和接口样例并同步。
- G0 尚未发布时，可读旧执行/恢复入口、准备适配边界和测试场景；将具体接口需求反馈主 Agent，避免定义另一套 Plan/Submission。

## 3. 按顺序实施

### EXEC-01：实现 Workflow 启动适配器

- 实现 G0 中定义的客户端接口，由主 Agent 的启动意图派发器调用。
- 使用约定的稳定 Workflow ID、Task Queue 和输入引用；超时、重复请求和 Already Started 按同一业务身份处理。
- Workflow 已存在时核对其归属/输入版本，不能把任意同名执行都视为合法成功。
- 配置连接地址、证书和任务队列，支持优雅关闭；不将现场地址或凭据写入源码。

完成证据：模拟边界测试与实际 Temporal 接入结果；重复派发不会创建第二个业务 Plan。

### EXEC-02：实现样本 Workflow 与 Activity

- Workflow 负责确定性的流程协调；HTTP、文件读写、网络调用等副作用放到 Activity。
- 通过受控 API 取得冻结输入、权限和检查点，使用主 Agent 发布的有界、版本化样本；每条样本明确属于测试数据。
- 按统一 schema 产生频道、视频/评论等已声明领域的 Submission，提交身份不依赖 Activity attempt、进程 PID 或随机重启值。
- 大内容不反复塞入 Workflow 历史或 Heartbeat；输入引用必须在恢复时仍可取得。
- 所有领域是否完成由 Store 的结果决定；Workflow 完成与业务完整成功分别处理。
- 未实现的真实 Agent/API 不返回伪成功；需要该依赖的测试场景应保持等待或明确未完成。

完成证据：样本 Plan 可执行，数据库事实与回执由 Ingest 写入，Worker 不需要 PG 连接凭据。

### EXEC-03：实现提交恢复与预算

- 收到 APPLIED 后记录/读取对应进度；若提交响应丢失，先核对原回执或重传同一身份和同一内容。
- Worker 重启后从约定检查点和稳定输入恢复，禁止另开 Plan 重置已消耗预算。
- 区分 HTTP 重试、Activity 重试、依赖等待与业务重试；按照契约使用总期限、单次超时与有限次数。
- 执行代次失效、取消、授权拒绝及协议冲突按错误类型退出或等待，不能无限重试。
- 进程停止时暂停新增、执行有界排空；未完成项由持久工作流/输入/回执支撑恢复。

必须验证：Worker 强杀/重启、确认丢失、重复活动执行、Ingest 暂不可用、取消后的迟到提交，以及旧代次写入被拒绝。

### EXEC-04：上报可观测状态

- 上报实例身份、节点关系、构建版本、接单状态、时间有界的心跳以及当前 Plan/阶段关联。
- 错误包含规范类别、阶段、可重试性、业务关联 ID 和必要诊断，日志不输出凭据或整份大样本。
- 控制台通过主 Agent 的查询 API 读取这些状态；不另开未约定的前端直连 Worker 接口。
- 固定样本阶段没有实际代理时，报告未使用/未配置，不能生成虚构 IP 库存或健康数据。

完成证据：能够从一个失败 Plan 关联到对应 Worker、阶段、最近回执与错误。

### EXEC-05：验证与交付

- 使用 Temporal SDK 提供的测试能力覆盖 Activity、Workflow 等待/取消和确定性边界，必要时保存并重放代表性历史。
- 在隔离 Temporal 和真实 Control/Ingest/PG 链路完成联调。测试替身通过只算模块验证。
- 提供 Worker/启动适配器的构建启动命令、配置变量、停止与恢复步骤。
- 更新 `docs/m1/reports/execution.md`，列出版本、命令、结果、证据与尚未接入的能力，在自己的分支提交并交给主 Agent 集成。

## 4. 完成标准

给定一个已持久创建的样本 Plan，系统能够可靠启动执行、提交结果、查询原回执并在重启后恢复；没有直接 SQL、第二套任务队列或独立业务状态枚举。共享验收中执行侧负责的场景均有实际结果，真实采集未验收时明确记录。
