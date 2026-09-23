# 开发阶段基础设施进度（2026-09-22）

六节点服务已搭建，备份恢复、监控、隔离、六台整机重启、独立公网端口检查和钉钉告警验收均通过。目前仅剩实际48小时时长验收。最终配置的持续观察于北京时间 **2026-09-22 20:04:58** 开始：24小时空载，随后24小时合成小负载；按五分钟采样节奏，最早9月24日20:05左右完成，仍以实际健康样本及覆盖条件为准。爬虫业务未开发或部署。

## 本轮完成

- 每日 A1 本地备份＋S2 副本，逐文件 SHA256 校验，保留7份，root-only。覆盖 PG 全部非模板库/角色、CH用户库、etcd/token、配置/凭据和 Grafana SQLite。外部备份按用户决定暂缓；当前没有PG连续WAL/PITR和整组服务器同时丢失的保护。
- 从 S2 下载并在隔离新资源恢复5个PG数据库、角色和CH原生备份；核对既有Outbox事件、表和备份标记。Grafana数据库完整性及etcd离线还原通过。没有对在线集群执行cluster-reset。
- 18/18 Prometheus targets UP，Kafka最小ISR=3、不同步分区=0。增加Kafka broker/exporter、CDC/slot/备份状态采集，17条告警规则和12面板Grafana预置看板。
- Prometheus→Alertmanager→持久本地journal及钉钉加签机器人的触发和恢复均实测通过；钉钉API返回errcode=0。新增凭据及manifest已纳入20260922T120523Z备份，S2副本逐文件校验通过。
- PG角色/数据库12项、NetworkPolicy访问矩阵42项、Kafka认证和ACL拒绝4项通过。PG明文连接被拒绝，合法TLS/mTLS访问与核心链路已有证据。
- 64客户端/256事务连接池测试零失败，后端连接峰值20；应用角色总连接上限80，PG上限100。
- 六节点Pod间30条有向路径的约1MiB传输摘要和1420 MTU不分片测试通过。Globalping新加坡/日本独立探测节点已验证六公网地址84项敏感TCP端口均未连通，六机SSH正向对照均连通；证据见reports/external-ports.json。
- CDC暂停/恢复通过；PG计划切主约19秒恢复健康，前后事件完整。后续A3整机重启还触发过PG自动切主，最终主库回到A2。
- S1/S2/S3/A2/A3实际整机重启及事件核对通过，最终复测恢复时间约166/226/186/43/192秒。A1完整操作系统重启随后通过，见reports/a1-reboot-validation.json。
- 容器日志10MiB×3、Loki保留72h、宿主journal256MiB/7天；48容器受限日志和报告扫描未发现已知服务密码。运行镜像全部固定版本标签，imageID已记录。

## 演练发现并修复

- 单实例Connect在broker协调器重启后进入默认五分钟重平衡等待。设置scheduled.rebalance.max.delay.ms=0，将任务停止、worker配置同步超时提高到30秒，重启S3复测通过。
- Grafana冷启动时出现大量磁盘读取和内存回收，长时间不监听HTTP。把内存上限由384MiB提高到1GiB、CPU上限提高到500m，并增加启动/存活探针；A3整机重启复测正常。初次异常和诊断保留于node-reboot-validation.json，不抹掉失败记录。
- 早期部署还修复过Strimzi命名空间/亲和性、PG池域名证书、PgBouncer滚动策略、ClickHouse明文兼容端口、Debezium日志/异步注册及Kafka CLI选项问题，当前manifest已包含修复。

## 尚未完成

1. 24h空载＋24h小负载的实际时长验收：定时器已启用，结果自动更新reports/observation-latest.json和验收清单。

钉钉告警已于2026-09-22接通并通过真实触发、恢复测试，平台均返回errcode=0；本地journal继续保留，凭据保存于权限0600的本地配置及Kubernetes Secret。证据见reports/alert-dingtalk-pipeline.json。
A1完整操作系统重启已通过：S1独立观测，启动后自动验证；见reports/a1-reboot-validation.json。

独立公网探测已通过：Globalping新加坡与日本探测节点，六台公网地址各14个敏感TCP端口共84项均未连通，六台SSH正向对照均连通；见reports/external-ports.json。仅证明所测来源和时刻的这些端口未能建立TCP连接。

A1演练恢复成功后已归档此前观察记录并重新计时；随后钉钉验收的监控重载窗口记录到一次监控目标离线样本。当前健康复核已通过，旧窗口的8个样本（含该异常）完整保存在/var/lib/crawlsystem-observation/archives/20260922T120458Z-maintenance，并从最终配置开始24h空载＋24h小负载，见reports/observation-maintenance-restart.json。实际时间和健康样本达到要求才会通过。观察器同时检查PG同步备库/复制槽、CDC任务、Kafka副本与测试写入结果。

2026-09-22 按用户决定，云安全组控制台审计不纳入本次验收；该审计未执行，不作为剩余待办。

两实例PG严格同步在单实例不可用期间可能阻塞写入；CH、Connect、监控及A1上的Temporal存在单节点中断窗口。本轮验证恢复能力，不宣称业务零中断或生产容量验收通过。业务指标待爬虫业务开发时接入。

操作与恢复步骤见../OPERATIONS.md；访问方式见ACCESS.md；逐项证据见../DEPLOYMENT-CHECKLIST.md。
