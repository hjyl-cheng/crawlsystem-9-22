# 开发阶段运维与恢复

适用当前六节点开发环境。爬虫业务尚未部署。用户已决定暂缓外部备份；跨节点副本仍在同一组服务器内，不能防范整组丢失。

## 日常检查

在 A1 的 `docs/crawlsystem-infra-a1-s3` 下执行。恢复运维脚本到新管理机时，安装 Python 3、PyYAML、kubectl，并执行 `python3 -m venv .venv-infra && .venv-infra/bin/pip install -r requirements-infra.txt`；配置受限 kubeconfig 和到 S2/A3 的管理 SSH。

日常检查：

```sh
export K3S_CONFIG_FILE=/dev/null
kubectl get nodes
kubectl get pods -A
sudo systemctl list-timers 'crawlsystem-*'
sudo systemctl status crawlsystem-backup.service crawlsystem-observe.service
cat reports/observation-latest.json
```

服务访问和凭据位置见 `reports/ACCESS.md`。Grafana 预置 `Crawl 基础设施` 面板，路径 `/d/crawl-infrastructure`。不要把 `secrets/` 或 `/srv/crawl-backups/` 上传到公开仓库。

## 备份

- 每天系统时间 03:20 左右执行，实际时区以 `timedatectl` 为准。A1、S2 各保存最近 7 份成功备份，目录 `/srv/crawl-backups/YYYYMMDDTHHMMSSZ/`，root-only。
- `metadata.json` 记录范围；`SHA256SUMS` 记录逐文件摘要；只有 S2 校验成功才写 A1 的 `latest.json`。
- PG：所有非模板数据库的 custom-format 逻辑备份、角色定义（含密码哈希）。每个数据库分别一致；不同数据库之间不是同一原子快照。每日执行成功时恢复点最多约 24 小时；没有连续 WAL 归档和任意时间点恢复。
- ClickHouse：所有用户数据库的原生 BACKUP 文件。系统日志表不在备份中。
- K3s：etcd 快照、原始 server token、Kubernetes Secrets、部署配置和恢复所需凭据。快照只有配合正确 token 才能解密恢复集群引导数据。
- Grafana：使用 SQLite 在线备份接口生成一致副本。
- Kafka 使用三副本和 24 小时保留，当前没有独立消息归档；CDC 按至少一次投递验证，业务消费者需要按事件 ID 去重；Prometheus/Loki 历史和操作系统磁盘镜像不在此方案范围内。
- 失败的 `.partial` 目录保留诊断，不算成功副本。排障后仅删除确认不需要的失败目录，监控磁盘空间。

手动执行并检查结果：

```sh
sudo systemctl start crawlsystem-backup.service
sudo journalctl -u crawlsystem-backup.service -n 30 --no-pager
sudo cat /srv/crawl-backups/latest.json
sudo python3 scripts/verify-local-restore.py
```

恢复演练会从 S2 下载备份，核对摘要，在新建的 `infra-restore` 命名空间内恢复 PG/CH。该命名空间拒绝全部网络流量，只通过管理接口和 Unix socket 测试，完成后删除。etcd 使用匹配的 `etcdutl 3.6.14` 离线还原到新目录；没有对在线 K3s 执行 cluster-reset，也没有验证整组机器从零恢复。

真实灾难恢复应先建立替代环境并保存现存数据：按版本重新安装 K3s，使用备份的 server token 和快照按官方恢复流程启动首台 server，然后依次重建其余成员；按 `recovery-config.tar.gz` 恢复部署配置，在新 PG/CH 数据目录恢复数据库。不要直接把演练命令改为覆盖现有生产目录。Temporal 两个库来自分别一致的逻辑快照，恢复后需做应用一致性复核。Kafka 全部丢失后应重建 Topic/ACL，并明确 CDC 起始位置与去重策略。

## 监控和告警

Prometheus 收集节点、PG、Temporal、ClickHouse、Kafka broker 和 Kafka exporter 指标。每 5 分钟巡检 Connect REST 状态、PG slot 滞留、同步备库数量和备份状态，通过 A1 node-exporter textfile 暴露。

宿主机 journal 也已限制：持久日志最多256MiB、运行期64MiB，最多保留7天；容器日志10MiB×3。

告警目前发送到内部 `alert-journal`，持久记录在 A3 的 Alertmanager PVC `journal/alerts.jsonl`，单文件 16MiB、3 个轮转副本。触发和恢复通知已经实际验证。**本地记录不等于通知到人**；收件地址或机器人渠道尚未提供。

```sh
kubectl -n monitoring exec deploy/alert-journal -- cat /data/journal/alerts.jsonl
python3 scripts/verify-alerts.py
```

## 持续观察

`crawlsystem-observe.timer` 每 5 分钟执行。起点在 `/var/lib/crawlsystem-observation/started.json`，样本保留 7 天，报告为 `reports/observation-latest.json`。

首 24 小时只观察（常规备份等维护仍执行）；随后 24 小时每次产生 1 条测试 Outbox 和 ClickHouse 测试记录，并执行 1 个 Temporal 测试 Workflow。测试仅使用 `infra_smoke` 数据和专用队列，最多约 288 次；48 小时后停止合成写入，继续健康采样。记录资源、磁盘净增长、组件状态和每次测试结果。只有实际时间和样本覆盖达到要求才会标记 PASS；不足或存在故障为 RUNNING/REVIEW_REQUIRED。

## 可用性边界

- 应用角色连接总上限：crawler_owner 30、temporal_svc 45、dbz_svc 5，合计 80；PG max_connections=100，为管理与内部连接留出余量。连接池单独做过 64 客户端/256 事务测试；这不等同于未来爬虫业务容量压测。
- 两实例 PG 使用严格同步：任一实例不可用时，写事务可能等待同步确认。没有为演练降低一致性保证。
- Kafka/etcd 三副本可容忍一个成员故障，恢复后需确认全部副本同步。
- ClickHouse、Debezium、监控组件以及 A1 上的 Temporal/运维任务是单节点部署，相应节点重启会中断服务；重启可恢复不代表持续无中断。
- 当前执行环境在 A1 上。已准备 S1 独立 systemd 观察器以及 A1 的开机续验服务。A1 重启验收已通过；独立 S1 观测及启动后检查证据见 reports/a1-reboot-validation.json。
- 按用户 2026-09-22 决定，云安全组控制台审计不纳入本次验收，该审计未执行。独立外网检查已通过：新加坡/日本两个Globalping探测节点，六台公网地址的84项敏感TCP端口均未连通，六台SSH对照均连通；详见 reports/external-ports.json，仅覆盖所测来源、时刻及TCP端口。

## 钉钉告警接入

钉钉加签机器人已于2026-09-22启用，真实触发与恢复通知均通过，证据见 `reports/alert-dingtalk-pipeline.json`。配置保存在仅所有者可读的 `secrets/dingtalk.json`（权限0600）及Kubernetes Secret：`webhook` 为完整机器人URL，`secret` 为SEC开头加签密钥，`keyword` 默认为“爬虫基础设施”。机器人若配置IP白名单，需允许A3的实际公网出口IP。无需启用Outgoing交互功能。

执行 `python3 scripts/configure-dingtalk.py --apply` 接通，再执行 `python3 scripts/verify-alerts.py --dingtalk` 测试真实触发及恢复。配置器将凭据通过标准输入写入Kubernetes Secret，公共manifest不包含凭据。适配器校验钉钉API的errcode；发送失败返回502，让Alertmanager重试。本地journal保留。测试使用唯一ID，报告 `reports/alert-dingtalk-pipeline.json` 表示平台接受通知，不代表人已阅读。

## A1独立重启验收

`scripts/verify-a1-from-s1.py` 在S1以独立systemd任务运行，使用S1本机Kubernetes访问配置，记录A1新旧boot ID、全部工作负载健康和重启前后CDC事件；结果保存在S1的 `/var/lib/crawlsystem-a1-reboot/report.json`。

`crawlsystem-a1-complete.service` 已设置开机启动，仅在 `/var/lib/crawlsystem-a1-reboot/pending.json` 存在且boot ID确实变化时执行。它取回S1证据，验证CH、Temporal和CDC，再更新验收清单；失败明确写FAIL，不重复触发重启。`scripts/schedule-a1-reboot.py` 仅允许一次演练请求，先确认观察器已ARMED和备份新鲜，再延时180秒重启A1，当前管理会话会中断。

成功后，先前稳定性记录保存在 `/var/lib/crawlsystem-observation/archives/`，随后重新计时48小时。通过条件包括样本覆盖及PG、CDC、Kafka、监控、备份和小负载测试健康，不能用计划完成时间代替实际验收。故障时查看 `reports/a1-reboot-validation.json` 和 `journalctl -u crawlsystem-a1-complete.service`；S1的观察证据独立保留。

计划维护或验收重载影响观察时，可执行 `sudo python3 scripts/restart-observation.py --reason '实际维护原因'`。该脚本先采集并验证当前健康；仅在健康通过后，完整归档旧样本、旧汇总及重启原因，再重新开始两段各24小时观察。旧窗口的异常不会删除或改为通过。
