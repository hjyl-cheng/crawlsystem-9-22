# 业务数据库结构来源

`bootstrap.sql` 原样复制自老服务器结构快照 `oldsystem/database/bootstrap/business.sql`（2026-09-10），SHA256 为 `8e2964ef1b322c95dea3ea00894213e3ce25030b70e718367782f00b45b1f3f5`。保留 public、publication、raw_crawler、result 的 64 张表及原约束。

新集群独立数据库 `crawlsystem_business_main` 使用此结构。旧服务器数据库未连接、未改写。`transport.sql` 只新增 `delivery_transport` 内部元数据 schema，保存 Kafka 交付身份、轮询和回执状态，不改旧业务表证据。
