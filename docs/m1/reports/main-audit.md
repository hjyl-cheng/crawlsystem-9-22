# 主 Agent 任务复核

更新：2026-09-23。**本轮可独立推进的后端发布与观测验收已完成，MAIN-05/M1 尚未完成。**

| 任务 | 已完成并验证 | 未完成 |
| --- | --- | --- |
| MAIN-01 环境 | 实际 PG/PgBouncer/Temporal、私有证书、连接预算；Worker 最小凭据环境；账号角色权限审计；双副本发布 | 真实 Worker 运行验收；Temporal namespace 权限隔离已确认未成立 |
| MAIN-02 公共基础 | 工程/锁/CI、迁移/索引、数据登记、控制台至 2aea207 的契约集成、统计一致快照、可追溯镜像构建 | 执行模块交付后的依赖、根 CI 与启动编排集成 |
| MAIN-03 Store/Ingest | 28 项实际 PG 测试，幂等/冲突/故障回滚/确认丢失/取消/并发收口/账号一致性/新统计均通过 | 与真实 Worker 强杀和重复 Activity 的联合恢复 |
| MAIN-04 API/派发 | 完整控制台 API；持久 START/CANCEL 及租约测试；账号共享状态已双副本验收；HTTP OTel、Loki、Prometheus 真实接通 | 实际 Workflow 重复启动核对、启动确认丢失、取消传播；Temporal/Worker 追踪传播 |
| MAIN-05 集成 | 新 UI 29 项回归、真实页面/PG；后端发布至两副本、公网浏览器、跨副本会话与指标/日志验收 | API → Temporal → Worker → Ingest → PG → Console 的同身份全链路及故障验收 |

执行目录已有未提交实现，尚无正式交付提交与验收结果；这不代表主 Agent 可以把最终集成责任交出去。UI 设计由 Claude 负责。详细源码/镜像版本、证据及生产限制见 [主报告](main.md)。
