# A1–S3 外围验收记录
状态依据 2026-09-22 实际执行更新。PASS 仅覆盖本行记录的检查，PARTIAL 表示仍有验收缺项。

| ID | 验收 | 状态 | 证据／日期 |
|---|---|---|---|
| INFRA-01 | 六台私网地址与OS/架构一致 | PASS | 2026-09-22：preflight-a1/a2/a3/s1/s2/s3.txt；Ubuntu 26.04 amd64，地址一致 |
| INFRA-02 | 双向私网连通、时延与MTU | PASS | 2026-09-22：TCP 矩阵、固定端口 UDP 30/30、跨节点 Pod 约1MiB 传输及 MTU DF 30/30 通过；按用户决定，云安全组控制台审计不纳入本次验收，未执行该审计 |
| INFRA-03 | 六台之外验证敏感端口未公开 | PASS | 2026-09-22：Globalping新加坡/日本两个独立外部探测节点，六公网地址×14敏感TCP端口共84项均未连通；六机SSH对照均连通；原始结果见reports/external-ports.json。仅覆盖所测来源、时间及TCP端口 |
| INFRA-04 | 固定版本与实际imageID一致 | PASS | 2026-09-22：runtime-audit.json：48 个运行容器使用固定版本标签，imageID 全部记录，无 latest；不代表供应链安全审计 |
| INFRA-05 | 六节点Ready及三etcd健康 | PASS | 2026-09-22：六节点 Ready；etcd-health.json 三节点 health=true |
| INFRA-06 | 跨节点Pod/DNS及WireGuard计数 | PASS | 2026-09-22：pod-network-matrix.json：30/30 双向大块传输摘要一致，1420 MTU 不分片 ICMP 30/30；WireGuard 已启用 |
| INFRA-07 | PV目录/权限/宿主机磁盘余量 | PASS | 2026-09-22：六机磁盘充足；按节点创建空目录；实际 PV/PVC 记录见集群快照 |
| INFRA-08 | PG两实例实际同步状态 | PASS | 2026-09-22：pg-replication.txt：streaming / quorum，严格 ANY 1 |
| INFRA-09 | PgBouncer TLS/事务池/总连接预算 | PASS | 2026-09-22：TLS verify-full、事务池通过；pool-budget.json：64 客户端/256 事务零失败，20 个后端连接；应用角色总上限 80/PG 100 |
| INFRA-10 | 数据库与角色访问隔离 | PASS | 2026-09-22：security-matrix.json：3 个应用角色×4 个数据库的 12 项实际认证/授权检查通过 |
| INFRA-11 | Temporal schema Job和mTLS | PASS | 2026-09-22：Helm 部署成功、证书 Ready、schema 完成、mTLS 客户端连接通过 |
| INFRA-12 | 最小Workflow＋Activity返回INFRA_OK | PASS | 2026-09-22：temporal-smoke.txt 与 temporal-smoke-after-policy.txt：INFRA_OK:A1-S3 |
| INFRA-13 | 三Kafka副本跨节点/ISR | PASS | 2026-09-22：Kafka 三副本分布 S1/S2/S3，broker JMX 与 exporter 可见，已观测 ISR=3；主机重启结果另见 INFRA-29 |
| INFRA-14 | Kafka认证与拒绝未授权访问 | PASS | 2026-09-22：kafka-acl-matrix.json：读账号拒绝写事件/读内部 Topic、写账号拒绝读事件、错误密码拒绝；合法消费另有端到端证据 |
| INFRA-15 | Debezium单表和slot状态 | PASS | 2026-09-22：Connector 单 Task RUNNING；publication 单表；pg-slots.txt active/reserved/failover=true |
| INFRA-16 | PG Outbox测试记录到Kafka | PASS | 2026-09-22：两次 PG Outbox ID 与 Kafka 消费 headers 对应，第二次在网络隔离后 |
| INFRA-17 | CDC暂停/恢复和切主接点 | PASS | 2026-09-22：failover-validation.json：CDC 暂停/恢复事件完整；PG A2→A3 切换约19.31秒恢复健康，切换前后事件完整 |
| INFRA-18 | ClickHouse TLS/版本/读写 | PASS | 2026-09-22：clickhouse-smoke.json：HTTPS 校验证书、版本、隔离库写入读回及未认证 401 |
| INFRA-19 | 非业务监控Targets、备份与CDC状态 | PASS | 2026-09-22：18/18 targets UP；Kafka/CDC/PG slot/备份指标及12面板看板已验证；业务指标待业务开发 |
| INFRA-20 | 告警实际送达和恢复通知 | PASS | 2026-09-22：Prometheus→Alertmanager→本地journal及钉钉加签机器人，唯一测试ID对应的触发/恢复均通过；钉钉API两次errcode=0，见reports/alert-dingtalk-pipeline.json；平台接受通知，不代表人已阅读 |
| INFRA-21 | 集中日志限额/轮转/敏感信息检查 | PASS | 2026-09-22：容器10MiB×3、Loki72h、宿主journal256MiB/7天；48容器受限日志与报告未发现已知服务密码；不是全量安全审计 |
| INFRA-22 | NetworkPolicy正向和拒绝测试 | PASS | 2026-09-22：security-matrix.json：7个来源命名空间×6个服务，共42项允许/拒绝测试通过 |
| INFRA-23 | PG本地和跨节点备份成功 | PASS | 2026-09-22：开发阶段范围：A1 每日 PG 逻辑备份＋S2 副本，双方 SHA256 校验；无连续 WAL/PITR。用户已暂缓外部 S3 |
| INFRA-24 | 新资源恢复备份并核对数据 | PASS | 2026-09-22：local-restore.json：从 S2 回读，在新隔离资源恢复5个 PG数据库/角色和CH，核对Outbox/表；Grafana完整性及etcd离线还原通过 |
| INFRA-25 | etcd跨节点快照和恢复Token备份 | PASS | 2026-09-22：etcd快照、原始server token、配置和凭据均 root-only 保存于A1/S2；离线etcd恢复已测，整组机器从零恢复未测 |
| INFRA-26 | S3权限/上传下载/保留测试 | DEFERRED | 2026-09-22：按用户决定暂缓外部S3/异地备份，不作为当前开发阶段阻塞项 |
| INFRA-27 | 空载24小时资源和磁盘增长记录 | RUNNING | 自动记录：163 个样本，覆盖 13.501 小时；reports/observation-latest.json |
| INFRA-28 | 小负载24小时有效写入/净增长 | WAITING | 自动记录：0 个样本，覆盖 0.0 小时；reports/observation-latest.json |
| INFRA-29 | N-1及逐节点重启恢复边界 | PASS | 六台整机重启均已验证；A1由S1独立观测boot ID变化、服务恢复及前后CDC事件，启动后验证CH与Temporal；见reports/a1-reboot-validation.json；不代表零中断 |
| INFRA-30 | 开发阶段交接文档与未通过项目 | PASS | 2026-09-22：OPERATIONS.md、ACCESS.md、DEPLOYMENT-PROGRESS.md及本表记录endpoint、恢复步骤、限制与待完成项 |
