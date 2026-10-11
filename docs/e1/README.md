# E1 每日备份与隔离恢复验收（2026-10-11）

现有每天北京时间 03:20、随机延迟最多 5 分钟的备份任务已接入当前业务库的快照校验。A1 和 S2 各保留最近 7 份成功副本，跨节点 SHA256 验证通过后才更新成功标记；原有最近成功时间和备份服务失败告警继续使用。

正式采集库沿用 `crawlsystem_m1_main_test`，下游库为 `crawlsystem_business_main`。每日备份覆盖全部非模板 PostgreSQL 数据库和角色，以及 ClickHouse 用户库、etcd / token、Kubernetes Secrets、配置和 Grafana SQLite。两个正式业务库的逐表行数 / 内容摘要和 `pg_dump` 共用导出的快照，新写入不影响核对。结构摘要覆盖有效字段顺序、类型、默认值、视图、索引、约束、触发器、函数、所有者和表 / schema 权限；删除字段留下的物理编号空洞不计入逻辑结构。

从 S2 取回 `20261011T084407Z`，对 13 个数据库逐库恢复。采集库 72 张表全部匹配，36 份迁移校验和、配置 v5、频道 / 视频、搜索词 / 来源 / 时钟、Worker 管理、登录 / 操作审计和交付回执均通过。旧结构业务库 64 张表按原结构恢复，另包含原有交付接收账本表，整个库共校验 65 张表。Temporal 两个库、其他基础 / 测试库也完成还原。ClickHouse 原生 RESTORE、用户表名单和不可变备份标记通过；Grafana SQLite 完整性和 etcd 离线恢复通过。

恢复使用 a2 上随机命名的临时 namespace，拒绝全部网络，不挂 Kubernetes token，PG 只监听 Unix socket、ClickHouse 只监听回环。Pod 设有 CPU、内存和临时磁盘上限；所有重步骤使用共享锁与 300 秒限制。大库采用 20 GiB emptyDir，归档通过管理 SSH 排他写入本轮 Pod UID 对应的临时卷，并核对 SHA256；还原长命令保活，重索引单独分批执行。副本完成或失败后核对 namespace UID 与本轮标识再删除。

本轮发现并处理了大库容量不足、管理连接静默超时、Kubernetes 大文件 stdin 传输不能正常结束，以及删除字段导致结构误判的问题。运行中断后保留已经通过的逐库证据，仅在同一份不可变备份、相同元数据和文件清单再次校验通过时复用。本轮 12 个库来自首次已通过的隔离运行，业务库在后续隔离运行补完；两次成功证据均对应同一 S2 备份，并记录运行标识。最终临时 namespace 和恢复文件副本全部清理。完整私密报告在 `/srv/crawl-backups/restore-latest.json`，公开摘要见 [evidence.json](evidence.json)。

12 项单元检查通过；隔离 PostgreSQL 的实际测试验证了并发写入时快照不变、相同行数下的内容变更可检测、结构变更可检测，以及删除字段后的 dump / restore 正确匹配。备份证据格式为 `verification_version=2`。备份服务使用版本管理中的脚本，原基础设施目录继续提供运行凭据和配置；新增 systemd 内存 / CPU / 进程上限，并归档当前备份 / 恢复工具和采集库迁移文件。

更新后的正式 `crawlsystem-backup.service` 于北京时间 17:08:45 → 17:11:30 实际运行成功，exit 0；最新备份 `20261011T090845Z` 共 648,430,967 字节，A1 / S2 校验通过，每日 timer 已启用。它与上述恢复演练使用相同的快照校验方式。

北京时间 15:45:38 → 17:11:59 的运行快照：视频 48,194 → 50,437，FULL 完成 1,684 → 1,758，业务交付 1,751 → 1,826。交付 pending / failed 均为 0，CDC 为 RUNNING、复制槽 active，PG 评论正文为 0。全部采集、解析、画像、代理和交付服务的镜像、Pod UID 和重启计数一致；业务库仍为旧结构 64 表。公网返回 200，Cloudflare PID 1882 保持，控制台原有未提交证据文件 SHA256 保持。

期间 FULL 失败 11 → 12，新增一条 `WORKER / UNAVAILABLE / ABOUT` 的失败导入，仍需人工重试。下一步 E2 补有次数和退避上限的自动重试，保留人工取消 / 拒绝、资格、并发和预算限制。

复核入口：

```sh
npm run check:safe -- backup-unit
npm run check:safe -- backup-runtime before
npm run check:safe -- backup-now
npm run check:safe -- backup-restore prepare
python3 scripts/dev/finish-e1-restore.py
npm run check:safe -- backup-runtime after
```

中断且资源已清理后，可使用 `backup-restore prepare --resume-verified` 接续同一备份的已通过证据，再运行顺序恢复脚本。手动入口与隔离资源说明见 [运维文档](../crawlsystem-infra-a1-s3/OPERATIONS.md)。角色、凭据、备份文件和原始运行日志均保留在 root-only 备份目录或私密 `.runtime/e1/`，不提交仓库。

当前是每日逻辑备份，各数据库分别一致；没有连续 WAL 归档 / 任意时间点恢复，也未验证整组机器从零恢复。历史测试数据清理、调度 / Temporal 部署完善、更多采集节点、正式控制台固定域名、业务告警和稳定代理来源仍属于后续阶段 E。
