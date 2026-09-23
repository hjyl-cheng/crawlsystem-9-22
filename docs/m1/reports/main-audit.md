# 主 Agent 任务复核

状态：主线后端与控制台集成继续推进，M1 尚未整体验收。此前“后端 G1 已完成”的表述不够准确；原来的 18 项测试不能代表 MAIN-01～MAIN-05 全部完成。

| 任务 | 本轮补齐并验证的部分 | 仍未通过的验收 |
| --- | --- | --- |
| MAIN-01 环境 | 独立 PG/PgBouncer、账号/池预算；Temporal mTLS、隔离 namespace、7 天保留；真实 TypeScript Workflow/Activity 接入通过 | 业务 Worker 的运行配置需随执行实现最终验收；namespace 授权隔离未验证 |
| MAIN-02 公共基础 | 控制台/登录契约和根锁集成；迁移 002、索引、逐表保留规则、接口例子与 CI；干净安装、类型、契约/认证/前端模块检查及构建通过 | 执行模块尚未交付，其新增依赖与根 CI 集成未完成 |
| MAIN-03 Store/Ingest | 真实 PG 26 项通过，含幂等、冲突、SIGKILL 回滚、响应丢失、取消/并发收口、认证共享状态；不接受假 APPLIED | 与真实 Worker 重启、重复 Activity 的联合恢复测试未执行 |
| MAIN-04 API/派发 | 完整控制台 API；会话/预算持久共享；账号改密/停用原子撤销和旧验证隔离；业务指标；START/CANCEL 持久意图与数据库恢复测试 | 实际 Workflow 重复启动核对、启动确认丢失与取消传播；完整分布式追踪 |
| MAIN-05 集成 | 审查并集成控制台具体提交 ab6c094、7760e2f；16 项页面回归；真实 HTTP/PG 页面创建/等待/取消、API 重启保留登录、退出撤销均通过 | 执行分支仅有准备文档；API → Temporal → Worker → Ingest → PG → Console 同身份验收尚未完成 |

UI 设计由 Claude 负责；主 Agent 仍负责全部控制台后端、共享契约、依赖、执行分支审查与最终联合验收。实际测试范围和限制见 [主报告](main.md)。执行模块未交付不意味着主 Agent 的集成责任已经完成，也不能把 readiness Workflow 当成业务执行器。
