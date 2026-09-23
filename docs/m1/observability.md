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

待执行模块交付后，需要把 Trace Context 经 Temporal 客户端/Workflow/Activity 传递到执行 HTTP 调用，并验收同一业务链；当前只有 HTTP 层的规范接入和日志输出，不等于完整分布式追踪。Worker 可使用公共 `@crawlsystem/http/tracing`，禁止在 Workflow 确定性代码内直接调用 Node SDK。
