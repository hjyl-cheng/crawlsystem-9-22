# Temporal 启动适配器与受控 HTTP 客户端

`createWorkflowStarter(options)` 实现公共 `WorkflowStarter` 并提供 `close()`，可直接由主 Agent 的意图派发器加载。连接地址、namespace、任务队列和 mTLS 参数遵循 [公共集成基线](../../docs/m1/integration-baseline.md)。

稳定 Workflow ID 为 `m1/<workspace_id>/<plan_id>`，类型为 `fixturePlanWorkflow`。启动使用 REJECT_DUPLICATE；Already Started 或启动确认丢失时，读取原执行首条历史的类型、task queue 及完整 `WorkflowInput` 身份，返回原 run_id；不同输入不能冒充重复成功。关闭执行仍拒绝复用 ID。

Temporal 历史保留期以外无法仅凭 Workflow ID 区分从未启动和已被删除的旧执行。主 Agent 必须保留 DONE 意图/Plan，不能重新派发已关闭/过期的原 Plan；适配器不创建业务 Plan。当前派发器在 Store 中保留完成意图并跳过终态/过期 START。不得将此适配器当作允许绕过持久启动意图的公共接口。

取消不存在的 Workflow 不直接确认成功：先前的 START RPC 可能仍在执行，派发器应保留取消意图继续核对。已关闭且类型/queue 匹配的执行可确认取消已无须传达。

`ExecutionApi` 通过公共 Schema 校验受控输入、回执、心跳、事件。拒绝远程明文、URL 凭据和重定向；限制请求及响应大小。提交先核对原回执，响应丢失后再次核对，必要时重传相同身份/内容。非 404 查询失败不视为回执缺失。

运行和验证见 [Worker 说明](../../apps/execution-worker/README.md)。此模块及 Worker 不导入 Store/PG，不需要 SQL 凭据。
