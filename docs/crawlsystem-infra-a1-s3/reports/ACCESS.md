# 运维访问

在 A1 管理终端设置：

```bash
export K3S_CONFIG_FILE=/dev/null
export KUBECONFIG=/home/ubuntu/.kube/config
kubectl get nodes
```

K3S_CONFIG_FILE 避免普通用户读取 root 的服务配置所产生的警告；kubeconfig 为 600 管理员凭据。

## Grafana

A1 保持运行：

```bash
kubectl -n monitoring port-forward --address 127.0.0.1 svc/grafana 13000:3000
```

本机终端保持 SSH 隧道：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 13000:127.0.0.1:13000 ubuntu@43.173.68.88
```

本机浏览器访问 http://127.0.0.1:13000，用户名 admin。
随机管理员密码保存在 A1 项目目录下 secrets/grafana.password；从自己的受控终端读取，不在聊天中发送。
Prometheus 数据源已配置；Loki 数据源指向集群内日志服务。预置基础设施面板：`/d/crawl-infrastructure`。

## Temporal UI

A1：`kubectl -n temporal port-forward --address 127.0.0.1 svc/temporal-web 18080:8080`

本机：`ssh -N -o ExitOnForwardFailure=yes -L 18080:127.0.0.1:18080 ubuntu@43.173.68.88`

浏览器：http://127.0.0.1:18080；namespace 为 crawlsystem。

## 集群内部连接

- PostgreSQL：crawler-pg-rw.db.svc.cluster.local:5432
- PgBouncer：crawler-pg-pool.db.svc.cluster.local:5432，事务池，证书已包含池域名；verify-full 已实测。
- Temporal：temporal-frontend.temporal.svc.cluster.local:7233，mTLS。
- Kafka：crawler-kafka-kafka-bootstrap.kafka.svc.cluster.local:9093，TLS/SCRAM/ACL。
- ClickHouse：clickhouse.analytics.svc.cluster.local:8443 / 9440，服务端 TLS＋账号密码。

基础服务密码均随机生成并保存在受限 secrets/ 或 Kubernetes Secret，不复用主机登录密码。
业务库 crawler 的初始 owner 凭据由 CNPG 的 db/crawler-pg-app Secret 管理。

当前服务只提供 ClusterIP/本地转发入口。每日 A1 本地＋S2 副本备份和隔离恢复已验证；告警触发/恢复写入本地 journal。实际通知到人、持续观察及其余验收状态见 DEPLOYMENT-CHECKLIST.md；运维与恢复步骤见 ../OPERATIONS.md。当前定位为开发环境。
