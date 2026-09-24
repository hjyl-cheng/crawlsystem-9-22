# M1 HTTP 追踪与现有监控接入

Control/Ingest 使用 OpenTelemetry API 1.9.1、Core/SDK 2.11.0，接受 W3C `traceparent`/`tracestate`。无效父上下文会重新创建身份；每次请求返回自己的 `traceparent`，调用方可将其传入下一次请求。请求 ID 继续独立生成，鉴权不依赖追踪 ID。

HTTP span 使用路由模板和方法命名，仅记录状态码、请求 ID，以及成功响应内已校验的 Plan/Submission ID。请求完成日志同时包含 trace_id/span_id。不记录原始 URL、查询串、请求正文、Cookie、Authorization、密码或任意异常文本；不接收 baggage。trace ID 不进入 Prometheus 标签。

默认根采样率 10%，`TRACE_SAMPLE_RATIO` 可设 0～1；已有父上下文遵循父采样标志。每进程导出队列最多 256、每批 32、最长间隔 1 秒；关闭服务时 flush。超限可以丢诊断 span，不能影响业务事务或回执。当前输出为结构化 JSON 日志，复用 Alloy → Loki；没有新增 tracing 存储组件，也没有宣称具备 Tempo/Jaeger 瀑布图。

Loki 查询：`{job="kubernetes-pods"} | json | event="trace_span" | trace_id="<trace-id>"`。HTTP 请求本身也有 trace_id，可用于查找非采样请求。字段 `business.plan_id` / `business.submission_id` 在 span attributes 内，只从成功业务响应提取。

`/metrics` 输出 HTTP 延迟/状态和指定 M1_WORKSPACE_ID 的持久业务数量。预览清单允许现有 Prometheus 访问 18100；`deploy/prometheus-job.yaml` 按 Pod 抓取两个副本。共享事实指标在每个副本重复出现，汇总用 max；HTTP 计数按实例 rate 后求和，不能把共享回执数相加。

配置校验与增量安装：

```bash
python3 scripts/dev/configure-preview-monitoring.py
python3 scripts/dev/configure-preview-monitoring.py --apply
```

脚本保留其他 scrape job，以 resourceVersion 拒绝并发覆盖；先用现有 promtool 验证，再等待配置投影并向现有 Prometheus 发送 SIGHUP。实际 targets 和 Loki 查询结果必须另外留档，配置语法通过不能替代采集成功。

## 跨 Temporal 的业务链追踪（2026-09-24）

`POST /v1/plans` 把本次 Control 服务端 span 的 `traceparent` 写入 `m1.plans.trace_context`（迁移 003，格式受 CHECK 约束；无效值不写入，也不影响创建）。之后的链路都从数据库读取这个上下文，而不是经过 Temporal header，因此不改动冻结的 Workflow 输入，派发器或 Worker 重启后也能接上同一条链：

```text
Control POST /v1/plans (server span)
  ├─ intent-dispatcher: "temporal start" / "temporal cancel"（intent 上带 trace_context）
  └─ execution-worker: "activity <类型>"（Activity 首次读取输入后开启）
       └─ Control / Ingest server spans（Worker 请求携带 traceparent）
```

- 每个 Activity 的第一次输入读取发生在拿到上下文之前，这一次请求不在链上；其后的输入、事件、回执查询和提交请求全部带 Activity span 的 `traceparent`。
- 采样沿用父上下文标志：创建请求被采样时整条链都输出；未采样时下游也不输出（`TRACE_SAMPLE_RATIO` 仅决定无父上下文时的根采样）。
- 派发器和 Worker 的 span 同样以 `event=trace_span` 写入 stdout，由现有 Alloy → Loki 收集；查询方式与 HTTP 相同，按 `trace_id` 过滤即可看到 Control、派发器、Worker、Ingest 四个服务的记录。
- span 只含 plan_id、Activity 类型、重试次数和 Worker ID；不记录输入内容、回执正文、令牌或错误原文。
- Workflow 确定性代码内不创建 span；Temporal 服务端自身的调度耗时不在链上，需要时从 Temporal 历史查看。
