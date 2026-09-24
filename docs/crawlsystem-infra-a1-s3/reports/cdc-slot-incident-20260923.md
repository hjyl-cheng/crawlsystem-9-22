# CDC 复制槽失效与 48 小时观察重启（2026-09-23 ～ 09-24）

## 经过（北京时间）

| 时间 | 事件 |
| --- | --- |
| 09-22 20:04 | 最终配置的 48 小时观察开始 |
| 09-23 起 | `infra_outbox_slot` 保持 active，但 retained WAL 以约 200MB/小时持续增长 |
| 09-23 16:05 | retained 达到约 4GiB（`max_slot_wal_keep_size`），复制槽 `wal_status=lost` |
| 09-23 16:35 | Debezium 任务 FAILED（Unable to obtain valid replication slot） |
| 09-23 20:05 起 | 小负载阶段 218 个样本全部不健康；空载阶段另有 57 个异常样本（REVIEW_REQUIRED） |
| 09-24 上午 | A1 重启后，裸 Pod `kafka/infra-kafka-validation` 未重建，小负载的 Kafka 校验同样无法执行 |

## 原因

Debezium 只捕获 `publication.outbox`。Outbox 空闲时复制槽位置不前进，而 PG WAL 是整个集群共享的，Temporal 等库持续写入的 WAL 全部被这个槽保留，直到触发保留上限、槽被作废。配置缺少 Debezium 心跳。

## 修复（2026-09-24 15:40～15:52）

- Kafka：新增心跳 Topic `infra-heartbeat.infra_cdc` 及 `dbz-connect` 的 Write/Describe ACL（集群禁止自动建 Topic）。
- PG：新增 `publication.debezium_heartbeat`，加入 `infra_outbox_pub` 但不在 `table.include.list` 中；Connector 增加 `heartbeat.interval.ms=60000`、`heartbeat.action.query`、`topic.heartbeat.prefix`。
- 删除已作废的复制槽；旧 offset 指向已不存在的 WAL，Debezium 拒绝启动，因此停止 Connector、重置 offset 后重新快照 outbox（253 行，消费端可见重复但无缺口）。脚本：`scripts/repair-cdc-heartbeat.py`（默认只读，`--apply` 执行）。
- 修复后：Connector/任务 RUNNING，新槽 active、`wal_status=reserved`，retained 约 16MB。
- 重新创建 `infra-kafka-validation`；合成 smoke（Outbox→Kafka、ClickHouse、Temporal）全部 PASS。
- 同期启用 Temporal namespace 授权（见 `docs/m1/temporal-authorization.md`），smoke 改走 internal-frontend。观察器使用的脚本副本已同步，原文件备份为 `*.bak-20260924`。
- `restart-observation.py` 健康检查通过后归档旧窗口并重新计时：新窗口始于 **09-24 15:52**，最早 09-26 15:52 可完成，仍以实际样本为准。

## 后续

- `infra-kafka-validation` 是绑定 A1 的裸 Pod，节点重启后可能不会重建；建议改为 Deployment（replicas=1）。
- 观察器应把"复制槽 retained WAL 持续增长"作为早期告警，而不是等到 `lost` 才发现。
