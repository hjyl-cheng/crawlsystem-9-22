# 主线五步推进与分支交接

核对日期：2026-09-24。用户已授权主 Agent 继续推进。顺序沿用本轮讨论的五步；主 Agent 负责后端、公共契约、分支审查与最终验收，Claude 负责控制台，执行 Agent 负责执行模块。阶段完成以实际结果和证据为准。

## 当前分支

| 分支 | 核对到的提交与工作区 | 主线处理 |
| --- | --- | --- |
| `business/crawler-platform` | 原基线 `fe7d02b`，本轮合入控制台 `f6e3c8a` 和执行模块 `e07e955` | 后端、可靠入库、查询、控制台与执行模块已汇合；继续联合验收 M1 |
| `business/m1-console` | `f6e3c8a`；新增 `67a1774` 的侧栏树线修复、`f6e3c8a` 的默认展开；另有未提交的浏览器证据 JSON | 两个已提交修改已合入；未提交证据保留在原 worktree |
| `business/m1-execution` | 正式交付 `e07e955`，工作区干净，基于 `adf6492` / `fe7d02b` | 已审查合入；根锁文件登记与干净安装已完成 |

执行模块交付包括启动适配器、HTTP 客户端、Workflow/Activity、心跳、有界重试、预编译和故障测试。正式报告记录 17 项模块测试、4 个 SDK 场景和 11 项真实链路检查通过，附源码 Hash、恢复历史与资源采样；这些是执行分支的交付证据，主线联合验收另外记录。旧 G0 准备报告已由正式交付报告替代。

## 第一步：M1 收尾（当前）

| 任务 | 责任 | 通过条件 |
| --- | --- | --- |
| 修复从未派发的 Plan 取消积压 | 主 Agent | 数据库证明 START 为 SKIPPED 且 attempts=0 时，取消意图安全收口；曾经派发但确认丢失时仍必须取消 |
| 执行模块提交与报告 | 执行 Agent | 已交付 `e07e955` 及正式报告/证据；后续增量仍按具体提交集成 |
| 根依赖、CI、启动编排 | 主 Agent | 按交付的 workspace package 更新集中锁文件；干净安装通过；CI 覆盖执行模块；启动缺配置时明确失败 |
| 真实 START/CANCEL 恢复 | 主 Agent 集成，执行 Agent 提供测试接口 | API 原子创建意图；派发器中断后恢复；启动确认丢失只产生同一 Workflow；取消经持久 CANCEL 意图完成，不由测试脚本直接调用 cancel 代替 |
| Worker 恢复与预算 | 执行 Agent实现，主 Agent联合验收 | 强杀后原 Plan/输入/截止时间/提交身份保持不变；重复 Activity 不重复入库；缺 AGENT 等待；真实历史重放通过 |
| 页面与因果链 | 主 Agent提供数据，Claude负责页面 | 同一 Plan/Workflow/Worker/Receipt 可关联；真实 Worker 驱动入库后页面显示一致；HTTP 追踪延伸到 Temporal/Activity |

本轮数据库回归 **30/30**，包含从未派发的取消、截止和失败，以及已派发但确认丢失的取消保护。其启动适配器使用测试替身，只证明真实 PG 中的派发状态机，不替代真实 Temporal 验收。

随后主线真实 Temporal 联合验收 **13 项通过**，合并后模块 **34/34**，浏览器已核对由实际 Worker 产生的同一 Plan/Workflow/Worker/Receipt，证据见[主 Agent 报告](reports/main.md)。当前第一步剩余常驻执行部署、令牌轮换与跨 Temporal 追踪；预览部署尚未包含本轮修复。

审查发现原 `live-acceptance.ts` 后续等待取消直接调用 `starter.cancel()`，未覆盖持久 CANCEL 恢复。主线增加 `M1_VERIFY_DISPATCH_RECOVERY` 验收模式：真实 start 已被 Temporal 接收后让派发器退出，等待原 30 秒租约回收并核对同一 run；取消入库时停止派发器，由新进程读取 CANCEL 意图，随后核对真实 Workflow 取消。故障注入入口只允许 `main-joint-*` 测试 workspace，生产派发器不带故障开关。

## 第二步：一个真实频道（M2）

主 Agent 先落实真实 Plan/目标范围、输入版本和领域完成契约，再与执行 Agent 接入真实采集、本机代理和必要的 Data API/Agent。Claude 接入真实字段和等待/失败原因。

通过条件：一个已准入频道按约定范围产出基础信息、视频、评论、Agent 分析；事实和推断分开；空结果、受限内容和输入不足有明确状态；中断后恢复未完成部分。旧代码和数据库字段作为参考，旧调度算法不自动成为约束。

真实运行前固定视频/评论范围、代理和 API/Agent 配额及测试频道；未提供的现场资源列出具体缺项。不能用固定样本或虚构 Agent 结果替代真实验收。

## 第三步：持续更新，再接频道发现（M3）

主 Agent 实现更新计划与调度、准入和查询 API，执行 Agent 实现各阶段恢复，Claude 接控制台。About/Video/Agent 独立更新、新视频发现和近期视频刷新先完成，再接 Query 周期、候选去重、来源和准入。

通过条件：重复更新不重复建实体；旧结果不覆盖新版本；只重试未完成部分；发现任务有额度、背压和终止条件。配额、Agent 成本和代理健康贯穿这一步。

## 第四步：交付与历史（M4）

主 Agent 负责发布资格、版本化 Outbox、消费者/Inbox、回执/对账、历史投递及保留规则；Claude 展示实际发布与交付状态。复用既有 Debezium/Kafka/ClickHouse。

通过条件：测试接收端得到正确版本，重复和乱序不重复产生效果，失败可重放和核对；历史统计不重复累计。下游 CRM 等应用和旧数据迁移继续单独评估。

## 第五步：规模化与上线验收（M5）

先确定频道量、更新频率、峰值提交、时效和成本，再测 P95/P99、有效吞吐、并发、扩容效率、积压/背压和资源峰值；验证数据库故障、业务恢复、备份还原和发布回滚。已有基础设施验收可复用，但必须补业务数据和回执的一致性证据。

安全、资源限制和监控从 M1 持续推进；当前 Temporal 证书未具备 namespace 授权隔离、完整跨执行链追踪未接通。正式接入前补齐身份隔离与审计，不能把这两项留到上线后。

## 共享主机验证约束

主线使用 `npm run check:safe -- typecheck|unit|build-console|browser|integration`。数据库检查默认读取忽略的 `.runtime/main.env`，可通过 `M1_CHECK_ENV_FILE` 指向其他隔离测试配置。不要把该环境文件提供给 Worker。

该入口与执行 worktree 共用 `/tmp/crawlsystem-execution-check.lock`，重检查串行；仅为本次检查创建临时 systemd user scope，整组 MemoryHigh=768 MiB、MemoryMax=1 GiB、MemorySwapMax=256 MiB、CPUQuota=150%、TasksMax=256，最多 300 秒。启动要求宿主机可用内存至少 2.5 GiB，低于 1.5 GiB 停止本次检查。无法建立限制即失败；不调整全用户/基础设施限额或 swap。

V8 默认堆 384 MiB，前端构建 512 MiB，全仓类型检查 640 MiB；第一次类型检查在 512 MiB 堆上限退出，已如实记录，不把失败计为通过。实际用量日志保存在 `.runtime/main-checks/`。CI 使用独立 runner，继续运行标准命令。
