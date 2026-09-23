> 当前实施以 [运维与恢复说明](OPERATIONS.md)、[验收清单](DEPLOYMENT-CHECKLIST.md) 和 [进度报告](reports/DEPLOYMENT-PROGRESS.md) 为准。以下保留原始设计；开发阶段已按用户决定暂缓外部 S3，采用 A1 本地＋S2 副本并验证隔离恢复。

# crawlSystem 外围组件完整搭建手册
## 24.8-INFRA-R2 · A1/A2/A3/S1/S2/S3 真实地址版

**编制／版本核对日期：2026-09-22。**
**适用资源：A1 4C8G，其余五台 2C8G，合计 14 vCPU / 48 GB。**
**状态：部署手册＋配置包；本地静态检查，不是已登录六台服务器执行成功的报告。**

本手册是《24.8 爬虫平台重构方案》的外围部署配套，不修改采集算法、业务状态和组件取舍。与旧 INFRA 版的区别：写入真实服务器清单，移除假设的 `10.77.*` 主机 VPN 网段，使用已有 `10.4.4.*` 私网；节点间 Pod 加密由 K3s/Flannel `wireguard-native` 承担，PG、Kafka、Temporal、ClickHouse 使用原生 TLS／认证。

> **先用现有磁盘、以小负载搭齐组件；设置过程数据保留和增长预警，后续按实际增长扩容。**不要求现在为千万／亿级数据买齐磁盘，也不承诺未知盘容量在任意采集速度下一天绝不会写满。安装空组件、小批量联调，与大量采集放量是两件事。

---

## 目录

- [1. 六台机器落位与边界](#scope)
- [2. 正式版本锁表与兼容性](#versions)
- [3. 从哪里执行：上传文件与只读检查](#preflight)
- [4. 真实私网、加密与安全组](#network)
- [5. 安装 K3s：三个控制节点、三个工作节点](#k3s)
- [6. 磁盘：用现有容量、限制增长、后续扩容](#storage)
- [7. Helm 与基础 Operator](#operators)
- [8. PostgreSQL 与 PgBouncer](#postgres)
- [9. Temporal：数据库、TLS、最小任务验收](#temporal)
- [10. Kafka：三节点 KRaft 和 ACL](#kafka)
- [11. Debezium：Outbox 到 Kafka 全链路验收](#debezium)
- [12. ClickHouse：历史数据库与 TLS](#clickhouse)
- [13. Prometheus / Grafana / 告警 / 日志](#observability)
- [14. 备份、外部 S3 与恢复](#backup)
- [15. NetworkPolicy 与权限验证](#security)
- [16. KEDA、后续 Worker 与扩容](#scale)
- [17. 一页检查清单、排障与交接](#handoff)
- [18. 版本升级、文件清单与验证范围](#validation)
- [19. 官方依据](#sources)

<a id="scope"></a>
## 1. 六台机器落位与边界

### 1.1 地址直接使用你的清单

Kubernetes 节点名使用小写，显示名称仍为 A1～S3。不会自动更改原操作系统 hostname。

| 节点 | 公网 IP（SSH 管理） | 私网 IP（集群互联） | 配置 | K3s 角色 | 本次主要负载 |
|---|---|---|---|---|---|
| A1 / `a1` | 43.173.68.88 | 10.4.4.12 | 4C8G | server / etcd ① | Operator、Temporal 四角色、Temporal UI、管理入口 |
| A2 / `a2` | 43.173.68.187 | 10.4.4.3 | 2C8G | agent | PostgreSQL 实例 A、PgBouncer；资源允许后小型 Loki |
| A3 / `a3` | 43.172.94.2 | 10.4.4.17 | 2C8G | agent | PostgreSQL 实例 B、PgBouncer、Prometheus/Grafana/Alertmanager |
| S1 / `s1` | 43.172.65.165 | 10.4.4.2 | 2C8G | server / etcd ② | Kafka Broker/Controller ①、Entity Operator |
| S2 / `s2` | 43.159.169.76 | 10.4.4.8 | 2C8G | server / etcd ③ | Kafka Broker/Controller ②、Debezium Connect |
| S3 / `s3` | 43.172.80.48 | 10.4.4.5 | 2C8G | agent | Kafka Broker/Controller ③、小型 ClickHouse |

Kafka 三个实例可能互换 S1/S2/S3 上的编号；实际以 Pod/PV 落位为准。PG 主角色可以切换，不写死 A2 永远是 Primary。

### 1.2 不重复安装的东西

K3s 是 Kubernetes 发行版，包含自己的 containerd、etcd、Flannel、CoreDNS、metrics-server 等。不要再并行安装 kubeadm 集群、Docker 作为 K3s 必需运行时、第二套 CNI 或第二套 etcd。

本方案不用主机 `wg0` 六节点手工配钥，不叠加 Cilium/Calico；K3s 自带网络策略控制器配合 Flannel。已有跨节点私网仍需实际互通验证，地址前缀相同不证明处于同一互通 VPC。

### 1.3 这批资源的用途

它是**同一最终技术架构的小规模部署与联调底座**。各服务设置启动预算，不预先启用大量 Collector、浏览器或本地模型。

| 项目 | 可以建设的能力 | 当前取舍 |
|---|---|---|
| K3s | 三个 etcd 成员 | A1 是初始入口，不是自动漂移的高可用 VIP |
| PG | 两实例、严格同步一副本、稳定写入口 | 任一 PG 副本不可用可能暂停写入；不偷偷切异步 |
| Kafka | 三个不同节点、RF=3、min ISR=2 | Broker/Controller 共进程、部分与 etcd 共机；不是大型生产隔离规格 |
| Temporal | SQL 持久化，四服务各一副本 | 集中在 A1，A1 故障时有恢复窗口 |
| ClickHouse | 单实例分析 | S3 节点永久丢失时靠已验证备份／保留源重建，不具备在线副本 |
| 监控/日志 | 小型实例、有限保留 | 不构成独立 HA 运维平台 |
| 备份 | 支持接外部 S3 | 账号与目的地仍需填写；不能把同机目录当异地备份 |

存储、CPU、故障域都会影响可用性。以上是明确的低成本起点，不是“全系统已经无单点”。PG、Kafka、etcd一次只维护一个副本。[S04][S08][S12]

<a id="versions"></a>
## 2. 正式版本锁表与兼容性

### 2.1 最新稳定，优先兼容；不漂移到 `latest`

本次重新查看了官方发布页。选择规则：正式发行、无 RC/Beta、明确补丁号，并核对 Operator 的支持范围。**“最新”不等于跨组件任何组合都已认证，“最稳定”也没有统一排名。**

两个显式例外：

- K3s 官方最新主线已到 `v1.37.0+k3s1`，本次固定 **`v1.36.4+k3s1`**，属于 1.36 正式维护分支；CNPG 1.30、Strimzi 1.2.0 的已声明 Kubernetes 支持／测试交集到 1.36，不能为追最高编号忽略兼容。[S01][S02][S03]
- ClickHouse 固定 **26.8 LTS 的 26.8.10.6 补丁**，不是刚发布新次版本优先。与旧手册的 26.8.6.5 相比更新了 LTS 补丁。[S16]

| 组件 | 锁定版本 | 说明 |
|---|---|---|
| Ubuntu | 已有受支持 24.04 LTS 可继续；26.04 LTS 也先核对 | 不为本次部署重装系统；包针对 amd64 |
| K3s / Kubernetes | `v1.36.4+k3s1` | 兼容性例外，所有六台一致 |
| Helm CLI | `4.3.0` | CLI 与 Chart 分开锁定 |
| CloudNativePG | `1.30.0` | PostgreSQL Operator |
| PostgreSQL | `18.6` | CNPG 官方 operand 镜像 |
| PgBouncer | `1.25.2` | CNPG Pooler，原生 TLS |
| cert-manager | `1.21.2` | 证书签发、续期 |
| Barman Cloud 插件 | `0.15.0` | 外部对象存储备份 |
| Strimzi | `1.2.0` | Kafka Operator；支持 Kafka 4.3.1 |
| Kafka | `4.3.1` | KRaft，不装 ZooKeeper |
| Debezium | `3.6.3.Final` | 3.6 稳定线，Connect 镜像 |
| Temporal Server / Admin Tools | `1.32.0` | 不是 `auto-setup` 开发容器 |
| Temporal Chart | `1.7.0` | 与 Server/UI 分开锁 |
| Temporal UI | `2.54.1` | 运维 UI，不是业务控制台 |
| ClickHouse | `26.8.10.6` | 对应 release tag `v26.8.10.6-lts` |
| KEDA | `2.20.2` | 安装能力，暂不创建自动放量对象 |
| Prometheus | `3.14.0` | 正式版，不用 3.15 RC |
| Alertmanager | `0.34.1` | 收件渠道必须配置 |
| node_exporter | `1.12.1` | 每节点一个，私网监听 |
| Grafana | `13.2.2` | OSS 镜像 |
| Loki / Alloy | `3.7.8` / `1.19.2` | 小型集中日志，资源检查后启用 |
| Temporal Python SDK（仅冒烟） | `1.30.0` | 独立 venv，不替代后续业务 SDK 决策 |

完整镜像名和来源位于 `versions.lock.json`。操作系统库如 OpenSSL/WireGuard 使用发行版安全补丁；不自行编译替换内核加密库。

### 2.2 部署前校验，而不是让脚本盲追版本

在 A1 解压目录执行：

```bash
python3 scripts/check-releases.py
```

它只检查官方 release 的指定 tag、draft/prerelease 标志，不更新系统。403/限流、网络错误、404 都需要查明；不是绕过验证的理由。PG/Kafka/CH 仍需对照本章官方页面及目标 registry。为业务新镜像另建发布锁表。

安装后保存真实 imageID：

```bash
bash scripts/record-cluster.sh
```

镜像 digest 必须来自实际 registry，不在本文杜撰 sha256。本环境未成功连接外部 registry 拉镜像，未做 Helm 实际渲染；目标机的镜像拉取、模板渲染、CRD 服务端 dry-run 仍是必做检查。发布页可核对不等于运行组合已通过验收。

<a id="preflight"></a>
## 3. 从哪里执行：上传文件与只读检查

### 3.1 约定

所有未注明的 `kubectl` / `helm` / `python3 scripts/...` 命令均在 **A1 普通管理员账号**执行，目录为 `~/crawlsystem-infra-a1-s3`。需要系统权限的命令使用 sudo。SSH 用户默认示例是 `ubuntu`，实际不同则替换；没有默认密码。

文件包中没有真实私钥或密码。不要把 `secrets/`、kubeconfig、K3s token 上传到 Git 或发聊天。

### 3.2 Mac 上传配置包

```bash
# Mac：先进入下载目录，文件名以实际下载为准。
scp ./24.8-INFRA-R2_A1-S3_配置脚本_2026-09-22.zip ubuntu@43.173.68.88:~/
ssh ubuntu@43.173.68.88
```

A1：

```bash
sudo apt-get update
sudo apt-get install -y unzip python3 python3-yaml ca-certificates curl jq openssl
unzip -n 24.8-INFRA-R2_A1-S3_配置脚本_2026-09-22.zip
cd ~/crawlsystem-infra-a1-s3
python3 scripts/validate-static.py
bash scripts/preflight.sh | tee reports/preflight-a1.txt
```

`unzip -n` 不覆盖已经编辑过的同名文件；不要把旧版目录与新版混用。后续每台节点也需要该包中的安装脚本和自身节点目录中的配置（例如 `nodes/a2/`），可从 Mac 各自上传同一 ZIP，或从 A1 经已配置的 SSH 安全传输。**不要求把 A1 私钥分发给所有节点。**

### 3.3 六台只读检查

每台解压后执行 `bash scripts/preflight.sh`。本脚本只读，不格式化、不关闭防火墙、不重启、不安装服务。

需要确认：Ubuntu amd64；私网 IP 确实配置在对应机器；旧 K3s/PG/业务不与新部署冲突；时间同步；现有剩余磁盘及 inode；六台双向私网路径；Pod `10.42.0.0/16`、Service `10.43.0.0/16` 不与其他内网/VPN重叠。

磁盘没有达到“旧文档几百GB示例值”**不是停止条件**。真正停止条件是已经接近满盘、目录里有未知旧数据、挂载错误、或空组件都没有安全余量。先报告真实 `df -hT`，不要直接跑 fio 大写入基准。

### 3.4 基础依赖（确认无冲突后，六台各执行）

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl jq openssl python3 python3-yaml \
  unzip iproute2 iputils-ping netcat-openbsd wireguard-tools
sudo timedatectl set-ntp true
sudo modprobe overlay
sudo modprobe br_netfilter
sudo modprobe wireguard
printf 'overlay\nbr_netfilter\nwireguard\n' | sudo tee /etc/modules-load.d/crawlsystem.conf
printf 'net.ipv4.ip_forward=1\nnet.bridge.bridge-nf-call-iptables=1\nnet.bridge.bridge-nf-call-ip6tables=1\n' \
  | sudo tee /etc/sysctl.d/90-crawlsystem.conf
sudo sysctl --system
```

出现模块缺失时安装匹配当前内核的发行版模块；不要用关闭加密来蒙混通过。已有 sysctl 先审阅。本包采用不启用 swap 的 K3s 基线：有 swap 时先检查负载，再 `sudo swapoff -a`；持久化修改仅针对确切 swap 条目，禁止随意覆盖 `/etc/fstab`。

<a id="network"></a>
## 4. 真实私网、加密与安全组

### 4.1 网络选择

```text
SSH：Mac → 各节点公网IP
集群：10.4.4.12/.3/.17/.2/.8/.5
跨节点Pod：K3s Flannel wireguard-native
业务Service：ClusterIP/DNS
运维UI：kubectl port-forward + SSH本地转发
```

不用旧版 `10.77.*`，不手建 `wg0`。K3s WireGuard 加密的是所覆盖的跨节点 Pod 路径，不自动覆盖同机流量、所有 hostNetwork 或外部 S3。后续跨信任域通信仍使用原生 TLS。[S05]

### 4.2 安全组建议

先设置云安全组，再启动服务。新规则不能覆盖现有 SSH 允许项；保留第二个 SSH 会话和云控制台救援入口。

| 协议端口 | 目标 | 允许来源 |
|---|---|---|
| TCP SSH 端口（通常22） | 六台公网 | 你的管理公网IP/CIDR；不是全互联网 |
| TCP6443 | A1/S1/S2 私网 | 六个已登记私网 `/32`；后续管理 LB 另批准 |
| TCP2379/2380 | A1/S1/S2 私网 | 三个控制节点私网 `/32` |
| UDP51820 | 六台私网 | 六个节点私网 `/32`，Flannel IPv4 WireGuard |
| TCP10250 | 六台私网 | 集群节点/需要访问的集群 Pod 路径，供 kubelet/metrics |
| TCP9100 | 六台私网 | 监控来源；node_exporter 不向公网监听 |
| TCP443出站、DNS、NTP | 各节点 | 软件源、镜像、时间与名字解析；按现有策略审批 |
| PG5432 / Kafka9093 / CH8443,9440 / Connect8083 / UI端口 | 不提供公网入口 | 仅ClusterIP、NetworkPolicy及SSH转发 |

私网入口可先限定六个具体地址，不默认整个 `10.0.0.0/8` 都可信。Pod 到主机地址在不同路径可能有/无 SNAT，现有主机防火墙还要考虑实际 Pod CIDR 来源，不能只根据一个 allow 规则宣称已通。IPv6 若启用也要独立审计，不只管IPv4。

本教程不自动清空 iptables、不远程强开全拒绝 UFW、不运行 `ufw disable`。已有 UFW/nftables 需要按上述矩阵增加准确规则，云安全组与主机规则共同验收。K3s所有节点的WireGuard端口要求见官方文档。[S04]

### 4.3 安装前做双向网络测试

```bash
# 每台执行；ICMP禁用时，改用批准的TCP测试，不能只根据ping判断。
for ip in 10.4.4.12 10.4.4.3 10.4.4.17 10.4.4.2 10.4.4.8 10.4.4.5; do
  ping -c 3 -W 2 "$ip"
done
```

如果有跨地域大延迟，不继续强行搭一个同步 PG/etcd/Kafka 集群。相同 IP 前缀不能证明实际物理距离。服务安装后再验证所有节点到 A1/S1/S2 的 TCP6443，以及跨节点 Pod 的 DNS/TCP。

<a id="k3s"></a>
## 5. 安装 K3s：三个控制节点、三个工作节点

### 5.1 先 A1

```bash
# A1 / 10.4.4.12
cd ~/crawlsystem-infra-a1-s3
sudo bash scripts/install-k3s-node.sh a1
# 确认提示时输入 INSTALL-a1
sudo k3s kubectl get nodes -o wide
```

脚本会校验节点私网 IP、架构、swap、旧 K3s 是否存在；下载锁定二进制和官方校验文件并核验，安装对应 `nodes/a1/k3s-config.yaml`。已有集群直接拒绝，不会 reset 或卸载。

A1配有 `cluster-init: true`，仅用来首次建立空集群。不要对已初始化数据库反复执行；后续维护使用升级/恢复流程。

### 5.2 安全分发完整加入 Token

A1 就绪后完整 token 位于 `/var/lib/rancher/k3s/server/token`。其中含敏感密钥，不打印进聊天。

在 A1 当前管理员会话生成受限临时副本：

```bash
umask 077
sudo cat /var/lib/rancher/k3s/server/token > "$HOME/k3s-join.token"
chmod 600 "$HOME/k3s-join.token"
```

使用你已经有权限的 SSH/SFTP 将文件传到其余五台。如果 A1 没有到这些节点的 SSH 凭据，可以由 Mac 以现有 SSH 登录传输；不需要开放新的服务端口。

```bash
# 示例：A1 已能使用 SSH 登录 S1；不要原样执行到不具备权限的账号。
scp "$HOME/k3s-join.token" ubuntu@10.4.4.2:~/k3s-join.token
```

每个加入节点执行：

```bash
sudo install -d -m 0700 /etc/rancher/k3s
sudo install -m 0600 ~/k3s-join.token /etc/rancher/k3s/cluster-token
rm -f ~/k3s-join.token
```

这里只删除刚传输的临时 token，不删除系统 token。A1 的临时副本分发后同样移除并将恢复所需 token 另行安全备份。

### 5.3 顺序加入

每台已解压相同包，在对应机器只运行自己的命令：

| 顺序 | 机器 | 执行 |
|---|---|---|
| 2 | S1 | `sudo bash scripts/install-k3s-node.sh s1` |
| 3 | S2 | `sudo bash scripts/install-k3s-node.sh s2` |
| 4 | A2 | `sudo bash scripts/install-k3s-node.sh a2` |
| 5 | A3 | `sudo bash scripts/install-k3s-node.sh a3` |
| 6 | S3 | `sudo bash scripts/install-k3s-node.sh s3` |

S1/S2是server，A2/A3/S3是agent，脚本自动按明确节点角色选择。加入地址使用真实A1私网 `https://10.4.4.12:6443`。

### 5.4 A1 管理环境

```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown "$(id -u):$(id -g)" ~/.kube/config
chmod 600 ~/.kube/config
kubectl get nodes -o wide
kubectl label node a1 pool.crawlsystem/core=true --overwrite
kubectl label node a2 a3 pool.crawlsystem/pg=true --overwrite
kubectl label node s1 s2 s3 pool.crawlsystem/kafka=true --overwrite
kubectl get pods -A -o wide
kubectl top nodes
```

期望：六节点Ready，InternalIP与第一章一致；A1/S1/S2三个etcd。kubeconfig是管理员权限，不能给未来业务控制台。

### 5.5 跨节点Pod验证

先建命名空间，再启动两个小型诊断Pod：

```bash
kubectl apply -f manifests/00-namespaces.yaml
kubectl apply -f examples/network-check-a1.yaml
kubectl apply -f examples/network-check-s3.yaml
kubectl -n infra-test get pods -o wide
kubectl -n infra-test logs network-check-a1
kubectl -n infra-test logs network-check-s3
sudo wg show
```

PG尚未安装时它的DNS查询不存在是预期；Kubernetes默认Service应能解析。后续PG就绪再从两个Pod做连通性检查。`sudo wg show` 在节点上看真实接口和字节变化，不要求存在 `wg0`。

### 5.6 A1不是最终HA VIP

三个server/etcd健康不等于管理入口IP漂移。A1暂时不可用时，可SSH到S1或S2用其本地 `sudo k3s kubectl` 维护。新节点不能只依赖失联的A1加入。之后需要单地址自动高可用入口时，配置云内网LB/成熟代理并纳入证书SAN；不在这里临时编写负载均衡服务，也不随意在云VPC上使用未验证的漂移VIP。

<a id="storage"></a>
## 6. 磁盘：用现有容量、限制增长、后续扩容

### 6.1 不预购最终容量

本版不再要求“每台先买100～220GiB才能开始”。先运行 `df -hT`；在现有健康磁盘上创建新目录，以小型组件、少量测试数据启动。PVC 是存储声明，不等于创建时把全部声明字节写入磁盘。[S19]

但不能把六台空闲空间相加当成一块盘：PG/Kafka/CH有独立落位，节点 S3 的盘满不会自动借用 A1 磁盘。镜像、日志、WAL、索引、合并临时文件也要算。

### 6.2 本包的初始逻辑预算

| 节点 | 新目录 | 初始PVC声明 |
|---|---|---|
| A1 | K3s默认数据目录／镜像 | 不创建业务PVC |
| A2 | `/srv/crawl-data/pg`；可选`loki` | PG30Gi；Loki5Gi |
| A3 | `pg/prometheus/grafana/alertmanager` | 30＋6＋2＋1Gi |
| S1、S2 | `/srv/crawl-data/kafka` | 各12Gi |
| S3 | `kafka/clickhouse` | 12＋20Gi |

**这些是空环境起始预算，不是对真实磁盘的探测结果，也不是硬配额。**首次创建前可以一起调整 `storage-plan.json`、PV及对应PVC/Cluster声明。不要在运行集群上通过改小容量或删PVC“重来”。

采用静态local PV，`Retain`回收策略；PG/Kafka靠自身副本，不额外部署Ceph/Longhorn重复复制。没有CSI动态扩容器，不能承诺改PVC数字就自动扩云盘。localPV绑定节点，换Pod不会搬走数据。[S19][S20]

### 6.3 只创建空目录，不格式化

各机按自身节点执行：

```bash
# A2示例；A3/S1/S2/S3分别替换节点名。
cd ~/crawlsystem-infra-a1-s3
sudo bash nodes/a2/prepare-dirs.sh
```

脚本对非空目录不改所有权；发现旧数据先调查。不会跑 `mkfs`、分区或递归chown现有数据库。目录是挂载点时，先确认正确数据盘已挂上，重启仍有效。

A1创建PV：

```bash
kubectl apply --dry-run=server -f manifests/01-storage.yaml
kubectl apply -f manifests/01-storage.yaml
kubectl get pv
kubectl get storageclass
```

`WaitForFirstConsumer`在使用Pod出现前PVC可能Pending，属于预期；出现Pod后仍Pending查PV标签、容量、节点、目录和资源，不先删卷。

### 6.4 防止非业务数据先占满磁盘

本包给了起步保护，不代表精确物理上限：

| 数据 | 起步设置 | 边界 |
|---|---|---|
| 容器stdout/stderr | 每容器10Mi日志文件、3份轮转 | 容器数增加会增加总量；退出Pod残留另监控 |
| K3s etcd快照 | 每6小时、7份 | 手动快照另有生命周期；恢复token独立保管 |
| PG WAL | max_wal_size 2GB、slot保留4GB | 都不能当全部pg_wal硬上限；归档失败等仍可持续增长 |
| Kafka冒烟Topic | 24h、每分区256Mi，segment64Mi | 分区/副本/活动段额外开销；**只用于测试Topic** |
| Connect内部Topic | compact | 恢复数据，不按24h任意清除 |
| Prometheus | 7天或3GB目标、PVC6Gi | WAL/Head额外占用，不能把3GB当总目录精确上限 |
| ClickHouse系统日志 | 保留7天，关闭部分高量日志 | TTL后台合并执行，不是到点立即清理 |
| 可选Loki | 72h、低入站速率、小并发 | 限速不是总磁盘硬配额，满盘前停增样本／减日志量 |

**异常WAL增长要处理故障原因，绝不直接删除 `pg_wal`。**复制槽落后接近保护预算，先降低新写入、恢复消费并核对接点；被限制失效的slot需要恢复方案，不能当“正常无损清理”。[S08]

正常成功采集不要默认记录完整HTML/JSON到stdout。重试不应复制完整频道快照；心跳维护当前状态，不永久追加所有IP快照。业务表去重、历史TTL和源Outbox安全清理由24.8的业务合同实施，本次外围安装不会替业务代码完成它们。

### 6.5 磁盘什么时候扩

先记录空载一天，再小批量采集观察一天；按单节点、单挂载点计算：

```text
日净增长 = 当日物理新增 - 当日安全回收
可用安全余量 = 当前可用 - 运维/恢复预留
预计可维持时间 ≈ 可用安全余量 / 日净增长（仅增长稳定且>0时）
```

监控给了30%剩余预警、15%剩余严重告警，以及近6小时趋势推算一天内用尽的提示；是可调整初始阈值，不是保证预测准确。扩容提前量要覆盖云盘操作、迁移、备份和恢复时间，不等100%才处理。

**安装和低负载联调不必然一天写满；无界日志、失效归档和过量业务写入可以很快耗尽空间。**没有实际磁盘大小与写入量，不能给“保证撑多少天”的数字。

### 6.6 后期扩盘的正确顺序

```text
确认最新备份/恢复路径
→ 云控制台扩“对应的实际磁盘”
→ lsblk/findmnt确认设备、分区、文件系统
→ 需要时扩对应分区
→ 按实际ext4/XFS等扩文件系统
→ 宿主机df和容器可见空间核对
→ 调整容量登记、资源预算与清理窗口
```

不提供猜测设备名的 `growpart /dev/vda 3` 一键操作；LVM、分区方式和文件系统不同，命令不同。`local`目录底层文件系统变大后可看到新增空间，但PV/PVC声明不是自动同步扩容控制器；不要为了更新元数据直接删除已绑定卷。使用支持扩容的云CSI时才按对应驱动流程扩PVC；迁移存储类别则用新卷、原生副本／备份恢复和受控切换。**加Worker、扩盘、迁存储，是三个不同操作。**[S20]

<a id="operators"></a>
## 7. Helm 与基础 Operator

### 7.1 A1安装Helm并下载固定Operator

```bash
cd ~/crawlsystem-infra-a1-s3
bash scripts/install-helm.sh
python3 scripts/check-releases.py
bash scripts/fetch-operators.sh
```

下载进入 `vendor/`，保留文件SHA256。`prepare-operators.py`只调整Operator的A1落位、资源起步值及Strimzi命名空间，不改CRD定义；先查看diff。

```bash
diff -u vendor/cnpg.yaml vendor/cnpg.prepared.yaml || true
diff -u vendor/strimzi.yaml vendor/strimzi.prepared.yaml || true
```

### 7.2 按顺序安装

```bash
kubectl apply --server-side --dry-run=server -f vendor/cert-manager.prepared.yaml
kubectl apply --server-side -f vendor/cert-manager.prepared.yaml
kubectl -n cert-manager wait deployment --all --for=condition=Available --timeout=300s

kubectl apply --server-side --dry-run=server -f vendor/cnpg.prepared.yaml
kubectl apply --server-side -f vendor/cnpg.prepared.yaml
kubectl -n cnpg-system wait deployment --all --for=condition=Available --timeout=300s

kubectl apply --server-side --dry-run=server -f vendor/barman.prepared.yaml
kubectl apply --server-side -f vendor/barman.prepared.yaml
kubectl get deploy -A | grep -E 'barman|cnpg'

kubectl apply --server-side --dry-run=server -f vendor/strimzi.prepared.yaml
kubectl apply --server-side -f vendor/strimzi.prepared.yaml
kubectl -n kafka wait deployment --all --for=condition=Available --timeout=300s

kubectl apply --server-side --dry-run=server -f vendor/keda.prepared.yaml
kubectl apply --server-side -f vendor/keda.prepared.yaml
kubectl -n keda wait deployment --all --for=condition=Available --timeout=300s
```

Barman插件必须与CNPG Operator处于同一命名空间；检查下载清单实际落位，不能只看Deployment存在。[S10]

出现字段归属冲突不默认 `--force-conflicts`；出现接口版本拒绝不删掉安全／同步字段来绕过。一次一个Operator，先Ready再下一步。实际空载CPU/内存以 `kubectl top` 为准，512Mi等limit不是组件官方最低需求或容量承诺。

<a id="postgres"></a>
## 8. PostgreSQL 与 PgBouncer

### 8.1 生成本地密码并创建Secret

```bash
python3 scripts/create-secrets.py
```

随机密码保存在A1本目录 `secrets/`，目录700、文件600；不输出。已有Secret不自动改值，因此**重复执行不是轮换密码**。如果以前用另一份目录生成过Secret，先恢复匹配的密码文件，避免本地文件与集群已有Secret不同。

### 8.2 创建PG

```bash
kubectl explain cluster.spec.postgresql.synchronous --api-version=postgresql.cnpg.io/v1
kubectl explain cluster.spec.replicationSlots --api-version=postgresql.cnpg.io/v1 --recursive
kubectl apply --dry-run=server -f manifests/10-postgres.yaml
kubectl apply -f manifests/10-postgres.yaml
kubectl -n db get cluster,pod,pvc -w
```

初始参数：PG18.6；A2/A3反亲和两实例；每实例request2Gi/limit3Gi；shared_buffers1GB；max_connections100；logical WAL；严格同步1台；逻辑slot同步和hot_standby_feedback开启。它们是小规模起步预算。

```bash
PRIMARY=$(kubectl -n db get cluster crawler-pg -o jsonpath='{.status.currentPrimary}')
kubectl -n db exec "$PRIMARY" -- psql -X -U postgres -d postgres -c 'SELECT version();'
kubectl -n db exec "$PRIMARY" -- psql -X -U postgres -d postgres -c \
 'SELECT application_name,state,sync_state,write_lag,flush_lag,replay_lag FROM pg_stat_replication;'
kubectl -n db exec "$PRIMARY" -- psql -X -U postgres -d postgres -c 'SHOW synchronous_standby_names;'
```

必须看到真实复制状态。两实例严格同步在失去一台时可能停写，换来既定故障模型的持久性保护；要在任意单副本故障后仍保持同步写入，应补第三个有资源和独立故障域的PG实例，不偷偷改变为异步。[S08]

### 8.3 Pooler与数据库初始化

```bash
kubectl apply --dry-run=server -f manifests/11-pgbouncer.yaml
kubectl apply -f manifests/11-pgbouncer.yaml
kubectl -n db get pooler,pod,svc
bash scripts/bootstrap-databases.sh
bash scripts/sync-pg-ca.sh
```

事务池地址：`crawler-pg-pool.db.svc.cluster.local:5432`。两个Pooler每个每数据库最多15连接，总数不是15；多个数据库、维护直连、Temporal、CDC还要加在一起。该预算不是全球限流服务，业务最大副本数仍须约束。[S09]

Temporal基础阶段直连 `crawler-pg-rw`，不强塞到未经验证的事务池。业务SQL必须自己保持事务、幂等、版本与字段正确性；Pooler不替业务授权。

初始化脚本只创建基础数据库和隔离测试表：

| 数据库/角色 | 用途 |
|---|---|
| `crawler` / `crawler_owner` | 空业务库，后续迁移 |
| `temporal`、`temporal_visibility` / `temporal_svc` | Temporal持久化与SQL可见性 |
| `infra_smoke` / `dbz_svc`只读复制 | 本次Outbox链路测试 |

`infra_smoke.publication.outbox`是测试，**不是生产业务表的最终Schema**。脚本撤销这些库PUBLIC连接，再授予对应角色；未来新账号必须显式授权。

复制PG CA只复制公开证书，不复制私钥。CA轮换需重新同步到Temporal/Connect使用方并测试，不能认为首次复制就是完整跨namespace自动轮换。

### 8.4 PgBouncer连接验收

用授权测试客户端连Pooler，指定 `sslmode=verify-full` 和CA。CNPG默认Pooler可能复用PG服务证书；检查证书SAN。DNS名称不在SAN时，使用SQL客户端的 `hostaddr` 连接PoolerIP、`host`校验证书覆盖的PG DNS，或配置覆盖Pooler DNS的原生证书；**不要关闭host verification**。项目正式连接串在这项验证后冻结。[S09]

<a id="temporal"></a>
## 9. Temporal：数据库、TLS、最小任务验收

### 9.1 签发证书

```bash
kubectl apply --dry-run=server -f manifests/20-certificates.yaml
kubectl apply -f manifests/20-certificates.yaml
kubectl -n temporal wait certificate --all --for=condition=Ready --timeout=300s
kubectl -n analytics wait certificate --all --for=condition=Ready --timeout=300s
```

Temporal内部及Frontend客户端认证使用同一批准CA，业务SDK未来使用独立客户端证书。本包另发7天有效的测试证书，只用于维护验收。mTLS证明身份，不自动给最终业务用户做好对象权限。

### 9.2 固定Chart安装

```bash
helm repo add temporal https://go.temporal.io/helm-charts
helm repo update temporal
mkdir -p vendor
helm pull temporal/temporal --version 1.7.0 --destination vendor
helm show values vendor/temporal-1.7.0.tgz > vendor/temporal-default-values.yaml
helm template temporal vendor/temporal-1.7.0.tgz -n temporal \
  -f values/temporal.yaml > vendor/temporal-rendered.yaml
```

核对渲染结果：没有Cassandra/Elasticsearch子集群，SQL两个库正确，password引用Secret，PG CA同时挂载到Server及Schema Job/admintools，mTLS开启，镜像版本正确。Chart1.7.0的字段与旧Chart不同，不能拿旧values直接套。[S13]

```bash
grep -nE 'image:|caFile|secretName|crawler-pg-rw|requireClientAuth' vendor/temporal-rendered.yaml
kubectl apply --dry-run=server -f vendor/temporal-rendered.yaml
helm upgrade --install temporal vendor/temporal-1.7.0.tgz -n temporal \
  -f values/temporal.yaml --wait --timeout 20m
kubectl -n temporal get pod,job,svc
```

初始History Shards沿用Chart的512；**初始化后不能当普通配置随意变更**。这是保留数据分区的决策，不是Pod副本数。[S13]

如果Schema Job失败，检查其日志、PG同步副本、账号和证书，不直接重建PG。`postgres12`是Temporal插件标识，不要求数据库降到PostgreSQL12。

### 9.3 验收一次真实任务，不只打开UI

A1终端1保持：

```bash
kubectl -n temporal port-forward --address 127.0.0.1 svc/temporal-frontend 17233:7233
```

A1终端2：

```bash
cd ~/crawlsystem-infra-a1-s3
bash scripts/export-smoke-certs.sh
sudo apt-get install -y python3-venv
python3 -m venv .venv-smoke
.venv-smoke/bin/pip install -r examples/requirements-smoke.txt
.venv-smoke/bin/python examples/temporal-smoke.py
```

期望 `INFRA_OK:A1-S3`；该程序启动短命测试Worker，执行一个Workflow/Activity，不抓YouTube，不写Crawler业务事实。它证明基本执行通路，不证明故障恢复和真实负载容量。namespace `crawlsystem`保留7天，应由Chart创建并核验。

### 9.4 Mac查看Temporal UI

A1另一个终端：

```bash
kubectl -n temporal port-forward --address 127.0.0.1 svc/temporal-web 18080:8080
```

Mac：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 18080:127.0.0.1:18080 ubuntu@43.173.68.88
# 浏览器打开 http://127.0.0.1:18080
```

不要将Web改公网NodePort来省步骤。正式多用户访问再加SSO/权限，当前仅通过你的管理员SSH。

<a id="kafka"></a>
## 10. Kafka：三节点KRaft和ACL

### 10.1 创建Kafka

```bash
kubectl api-resources | grep -E 'KafkaNodePool|KafkaTopic|KafkaUser|Kafka '
kubectl apply --dry-run=server -f manifests/30-kafka.yaml
kubectl apply -f manifests/30-kafka.yaml
kubectl -n kafka get kafka,kafkanodepool,pod,pvc -w
kubectl -n kafka wait kafka/crawler-kafka --for=condition=Ready --timeout=900s
```

Strimzi1.2.0使用的API按包内固定文件和实际CRD校验。三Pod分别在S1/S2/S3，兼任Broker/Controller；每个堆768Mi、容器2Gi为低负载起点。只有TLS/SCRAM内部9093，没有公网Listener。RF3/minISR2与生产者acks=all配合，不等于下游已交付。

### 10.2 Topic和用户

```bash
kubectl apply --dry-run=server -f manifests/31-topics-users.yaml
kubectl apply -f manifests/31-topics-users.yaml
kubectl -n kafka get kafkatopic,kafkauser
```

本次Topic：`infra.outbox.events`（3分区/3副本）、Connect内部config（1分区）、offset/status（各3分区）。内部Topic使用compact，不删除偏移恢复记录。测试Topic 24h和字节保留值只用于**非生产冒烟**；正式生产retention必须覆盖获准停机与追赶窗口。

账号：`dbz-connect`只允许必要Connect内部Topic和测试Topic；`infra-reader`只读测试Topic／测试组。以后Business Consumer创建自己的最小ACL，不复用维护账号。

### 10.3 不把新增Pod当新增硬件

S1/S2的etcd与Kafka同机、S3的CH与Kafka同机，发生I/O争用时先按指标减低工作量或拆到新增资源。KRaft选举、ISR、replica lag需验收；不要给2核节点无限增加并行消费者。

<a id="debezium"></a>
## 11. Debezium：Outbox到Kafka全链路验收

### 11.1 生成客户端配置

```bash
kubectl -n kafka wait kafkauser/dbz-connect --for=condition=Ready --timeout=300s
kubectl -n kafka wait kafkauser/infra-reader --for=condition=Ready --timeout=300s
python3 scripts/configure-kafka-clients.py
kubectl apply --dry-run=server -f manifests/32-debezium.yaml
kubectl apply -f manifests/32-debezium.yaml
kubectl -n kafka rollout status deployment/debezium-connect --timeout=600s
```

密码只写到受控本地文件与Secret；不会打印JAAS配置。脚本直接调用发行版Connect启动脚本，读取显式worker.properties，避免把不确定的环境变量映射当作已生效配置。`plugin.path=/kafka/connect`应在所选镜像实际确认；查看 `/connector-plugins`。

### 11.2 注册单表Connector

A1终端1：

```bash
kubectl -n kafka port-forward --address 127.0.0.1 svc/debezium-connect 8083:8083
```

A1终端2：

```bash
curl -fsS http://127.0.0.1:8083/connector-plugins | jq
python3 scripts/register-connector.py
curl -fsS http://127.0.0.1:8083/connectors/infra-outbox/status | jq
```

期望Connector和单Task均RUNNING。同名Connector已存在则比较配置，不创建多个重复捕获。`publication.autocreate.mode=disabled`；SQL Publication和`table.include.list`都限定 `publication.outbox`。新增`tasks.max`不能并行读取同一PostgreSQL Connector流。[S11]

### 11.3 写一条测试事件

```bash
PRIMARY=$(kubectl -n db get cluster crawler-pg -o jsonpath='{.status.currentPrimary}')
kubectl -n db exec -i "$PRIMARY" -- psql -X -U postgres -d infra_smoke \
  -v ON_ERROR_STOP=1 < sql/infra-outbox-insert.sql
kubectl apply -f examples/kafka-smoke-reader.yaml
kubectl -n kafka logs -f pod/infra-kafka-reader
```

应读到 `INFRA_TEST` / `A1-S3`。一个测试Pod只消费一条，重新测试先保留旧日志再删**这个明确的临时Pod**重建，不能删Kafka/PG PVC。

此结果仅说明 `PG事务Outbox→Debezium→Router→Kafka`可用；没有Business Consumer，不能标记 `DELIVERED`。生产端仍要event_id/Inbox/revision和业务事务，成熟传输组件不替业务判定。

### 11.4 复制槽和测试清理

```bash
kubectl -n db exec "$PRIMARY" -- psql -X -U postgres -d infra_smoke -c \
 'SELECT slot_name,active,restart_lsn,confirmed_flush_lsn,wal_status,failover FROM pg_replication_slots;'
```

`slot.failover=true`需与PG逻辑槽同步配合，正式切主后验证LSN/offset与重复事件。没有这一演练不宣称CDC已完整HA。冒烟环境不要自动删inactive slot；测试结束后明确删除测试Connector及其确属 `infra_outbox_slot` 的槽，另立受控清理步骤，不处理其他库的槽。

接生产前：以批准的业务迁移创建生产Outbox/Publication/账号/Topic，确定捕获起点和保留责任后切换；不要无差别CDC爬虫表。

<a id="clickhouse"></a>
## 12. ClickHouse：历史数据库与TLS

```bash
kubectl -n analytics wait certificate/clickhouse-server --for=condition=Ready --timeout=300s
kubectl apply --dry-run=server -f manifests/40-clickhouse.yaml
kubectl apply -f manifests/40-clickhouse.yaml
kubectl -n analytics rollout status deployment/clickhouse --timeout=600s
```

S3节点单副本、request2Gi/limit3Gi、每查询1Gi/max_threads2，适合小型联调。系统日志有限保留；业务历史表及TTL必须后续按24.8数据合同创建。

### 12.1 HTTPS检查，不能 `curl -k`

A1终端1：

```bash
kubectl -n analytics port-forward --address 127.0.0.1 svc/clickhouse 18443:8443
```

A1终端2：

```bash
mkdir -p secrets
kubectl -n analytics get secret clickhouse-tls -o jsonpath='{.data.ca\.crt}' | base64 -d > secrets/ch-ca.crt
curl --fail --cacert secrets/ch-ca.crt \
  --resolve clickhouse.analytics.svc.cluster.local:18443:127.0.0.1 \
  -u default 'https://clickhouse.analytics.svc.cluster.local:18443/' \
  --data-binary 'SELECT version(), currentDatabase()'
```

curl交互输入 `secrets/clickhouse.password` 对应密码；不要把密码写URL／命令历史，别发聊天。新客户端用8443 HTTPS或9440 native TLS；未开放8123/9000明文数据端口。

维护default仅用于初始化/验收；后续创建analysis_writer、console_reader最小角色，业务不拿管理员。HTTP TLS不等于每个客户端都有mTLS，当前ClickHouse是服务端TLS＋密码认证。

### 12.2 历史保留

只接分析白名单字段和获准粒度；不全库镜像PG，不把整频道JSON每次复制。TTL后台执行，写入错误/重复还需要投递协议与去重，不依靠后台merge自动解决全部业务重复。

备份见第14章。分析源删除之后不能再宣称可从PG随时重建任意历史。

<a id="observability"></a>
## 13. Prometheus / Grafana / 告警 / 日志

### 13.1 安装最小监控

```bash
kubectl apply --dry-run=server -f manifests/50-monitoring.yaml
kubectl apply -f manifests/50-monitoring.yaml
kubectl apply --dry-run=server -f manifests/51-node-exporter.yaml
kubectl apply -f manifests/51-node-exporter.yaml
kubectl -n monitoring get pod,pvc,svc
```

Prometheus/Grafana/Alertmanager落A3；node_exporter每台一个，绑定本机私网IP9100。hostNetwork路径需主机安全组，不由普通Pod策略完全覆盖。

初始抓取：Prometheus自身、六台node_exporter、CNPG、CH、声明了scrape注解的Temporal/其他Pod。**不把这个起步配置宣称为全量监控。**Kafka/JVM/Connect延迟、备份年龄及业务指标未完成Exporter配置的项目，必须记录并在生产准入前补齐。

### 13.2 Mac查看Grafana

A1：

```bash
kubectl -n monitoring port-forward --address 127.0.0.1 svc/grafana 13000:3000
```

Mac：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 13000:127.0.0.1:13000 ubuntu@43.173.68.88
# 浏览器：http://127.0.0.1:13000，用户名admin，密码由本地secrets生成。
```

Grafana数据源已指向内部Prometheus。初始化后，Secret变化不一定改掉Grafana库内旧admin密码，轮换走产品支持流程。

Prometheus的Targets：在A1 `kubectl -n monitoring port-forward svc/prometheus 19090:9090 --address 127.0.0.1`，再通过SSH转发19090查看。Targets不UP不能写“监控验收通过”。

### 13.3 告警必须送到你

当前Alertmanager接收器名称是 `UNCONFIGURED`，**不会自动发通知**。按你现有邮件/Webhook/企业通知适配配置真实Receiver；原生Webhook格式不一定等于飞书/钉钉机器人格式，不强行直连假装可用。

`examples/alertmanager-webhook.NOT_APPLY.yaml`是产品配置示意；真实带凭据的配置放Secret，修改Deployment对应卷引用。测试触发与恢复各收到一次通知，才算通过。

已提供磁盘剩余与增长趋势告警。组件级slot、ISR、备份、延迟告警需根据实际Exporter指标名验证后配置，不把未抓到的指标写成永远绿色。

### 13.4 可选集中日志

确认A2和节点资源余量后：

```bash
kubectl top nodes
kubectl top pods -A --sort-by=memory
kubectl apply --dry-run=server -f manifests/52-loki-optional.yaml
kubectl apply -f manifests/52-loki-optional.yaml
kubectl apply --dry-run=server -f manifests/53-alloy-optional.yaml
kubectl apply -f manifests/53-alloy-optional.yaml
kubectl -n monitoring get pod -o wide
```

Loki是单进程72h保留；Alloy读CRI日志。入站限速是防风暴起点，仍需观察实际压缩后字节与系统日志。不要通过打印每次响应体制造日志海洋；相同错误做聚合，业务回执不可仅依赖日志。

暂不空跑独立Tempo；先有业务OTel埋点再接入选定Trace后端。记录这是待交付能力，不把“有Grafana”当作已拥有所有全链路诊断。

<a id="backup"></a>
## 14. 备份、外部S3与恢复

### 14.1 不因暂缺S3阻塞空库联调，但阻断生产准入

现有6台之外的S3兼容存储，需要真实Bucket/Endpoint/地域与最小权限账号。这里不假装已经提供云账号，也不临时将同一台VPS目录当高可靠对象存储。空环境联调可继续；正式业务数据上线前必须完成备份恢复。

分开目的地／前缀：PG备份WAL、etcd快照、CH备份、业务Raw/恢复对象。账号分权。Raw普通TTL不能误删PG恢复链仍需的WAL；备份期限由Barman等工具管理。[S10][S17]

### 14.2 配置PG对象备份

A1受控目录 `secrets/` 保存不带换行的Access Key/Secret Key文件，文件600。不是把值贴进聊天。

```bash
kubectl -n db create secret generic backup-s3 \
  --from-file=ACCESS_KEY_ID=secrets/s3-access-key \
  --from-file=ACCESS_SECRET_KEY=secrets/s3-secret-key
cp examples/pg-objectstore.yaml secrets/pg-objectstore.yaml
# 编辑REPLACE_BACKUP_BUCKET和REPLACE_S3_ENDPOINT，并核对供应商region/CA。
kubectl apply --dry-run=server -f secrets/pg-objectstore.yaml
kubectl apply -f secrets/pg-objectstore.yaml
kubectl -n db patch cluster crawler-pg --type=merge --patch-file=examples/pg-enable-backup.json
```

这会启用WAL归档。**归档失败会增加本地WAL占用**，配置后立即检查日志与远端对象；不要带着错误存储凭据继续大量写入。

```bash
cat <<'YAML' | kubectl apply -f -
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata: {name: initial-infra-check, namespace: db}
spec:
  cluster: {name: crawler-pg}
  method: plugin
  pluginConfiguration: {name: barman-cloud.cloudnative-pg.io}
YAML
kubectl -n db get backup initial-infra-check -o yaml
# 只有首次备份成功且远端对象存在后，才安装周期任务。
kubectl apply -f manifests/12-pg-backup-schedule.yaml
```

示例14d恢复窗口用于小环境起点；要结合实际RPO/RTO和恢复成本批准。Barman插件和对象存储的真实兼容性由备份/恢复验证，不只看POST返回成功。

### 14.3 恢复必须用新资源

`examples/pg-restore.NOT_APPLY.yaml`是独立恢复集群示例：先新建空目录/PV与独立StorageClass，按容量安排临时节点；填正确备份源后才apply。禁止复用现有PG目录、禁止覆盖 `crawler-pg`。

恢复后连接新集群，验证 `infra_smoke.publication.outbox` 测试记录、数据库角色、所选恢复点。测试恢复集群与生产slot/Connector隔离，不让它与生产争同一个CDC身份。

### 14.4 etcd快照

A1/S1/S2分别核对：

```bash
sudo k3s etcd-snapshot save --name manual-before-business
sudo k3s etcd-snapshot ls
```

把 `examples/etcd-s3-secret.NOT_APPLY.yaml`复制到secrets填真实参数后应用。控制节点配置加入：

```yaml
etcd-s3: true
etcd-s3-config-secret: k3s-etcd-snapshot-s3-config
```

三个controller一次只重启一个，先恢复Ready再继续。必须独立保管server token以及灾难恢复时可取得的S3凭据；不能把唯一恢复钥匙只放在已经损坏的etcd里。[S18]

### 14.5 ClickHouse备份

在独立S3前缀验证ClickHouse官方BACKUP/RESTORE。必须使用其原生参数和受保护凭据，不在本教程编造供应商key。恢复到**新数据库／新实例**核对表和时间范围。

示意SQL（需替换真实受保护的S3配置，不能把凭据发聊天）：

```sql
-- 通过ClickHouse支持的受保护存储配置提供真实目的地后执行。
-- BACKUP DATABASE <获准数据库> TO S3(<专用备份地址及原生认证配置>);
-- RESTORE DATABASE <源库> AS <新的恢复测试库> FROM S3(...);
```

这是需要环境参数的恢复任务，不是一段可以原样复制的SQL。当前没有业务历史表时，先用隔离测试表验证；备份作业真实可恢复后才允许删除唯一历史源。[S21]

<a id="security"></a>
## 15. NetworkPolicy与权限验证

### 15.1 应用入站隔离

各软件基本可用后，在维护窗口：

```bash
kubectl apply --dry-run=server -f manifests/60-network-policies.yaml
kubectl apply -f manifests/60-network-policies.yaml
kubectl get networkpolicy -A
```

本包是**默认拒绝入站＋明确必要入口**，不是全出站白名单。DNS/S3/供应商尚未完全确定，不假写一个阻断所有出站的策略后再要求关闭防护才能恢复。

注意Operator可自己创建NetworkPolicy，规则允许是叠加关系，不能一条deny抵消别的allow。hostNetwork/节点端口另外检查。标准NetworkPolicy负责网络可达，不负责plan_id、epoch或用户业务角色。[S22]

### 15.2 正反向都测

| 来源 | 应允许 | 应拒绝 |
|---|---|---|
| 六台之外 | 授权SSH | PG/Kafka/CH/Connect/UI直接公网访问 |
| Temporal namespace | 自己SQL账号访问PG、内部gRPC | 用该账号连接/修改Crawler业务库 |
| Kafka/Connect | 单表CDC、必要Topic | 全库Publication或未授予Topic |
| 未来crawler namespace | Temporal/授权输入/Ingest/本地代理 | 直写PG、任意CH/Business DB |
| console/control | 批准读写API | 直接拥有cluster-admin |

使用诊断Pod和最小账号验收，保留失败证据。TLS不通过先查证书/时间/主机名，不用trust、匿名、`sslmode=disable`或`curl -k`修问题。

本包既不实现自定义加密协议，也不把业务授权遗漏掉；安全职责沿24.8：平台配置成熟安全工具，业务Store校验对象权限、代次和幂等。

<a id="scale"></a>
## 16. KEDA、后续Worker与扩容

KEDA已安装，但没有生产Worker/队列/指标之前，**不创建会实际放量的ScaledObject**。HPA负责副本，业务准入负责总工作量；缺物理资源时Pod Pending，不等于加了机器。

后续新增Collector节点：核对新OS/私网/防火墙 → 使用同K3s版本加入agent → 加批准的节点标签 → 部署本地Proxy Manager → 中心分配IP和有限授权 → 小并发启动 → 检查有效APPLIED与计划成功吞吐，再放量。

不要直接复制本包A1–S3的node-name/IP给新机器；新节点要生成新配置。K3s加入不是自动获得代理资源，不是自动具备采集业务代码。

扩容路径：

| 观察到的瓶颈 | 处理 |
|---|---|
| Worker繁忙、下游有余量 | 增加Worker／新Collector机器 |
| Ingest解码忙、PG有余量 | 扩Ingest但不无约束增加PG连接 |
| PG取连接/锁/WAL等待 | 定位真实SQL/锁/IO，优化或升配，不无限加Worker |
| Kafka消费慢 | 看分区、业务库余量与Consumer处理；无容量不盲扩 |
| CH分析忙 | 独立更多CPU/磁盘，必要副本或分片另行评审 |
| 单机磁盘持续增长 | 扩对应盘/存储池并校验保留；不等于加Pod即可扩盘 |

现有A1/S2/S3可能因混跑先忙，只是需要观察的风险，不是已有压测结论。不能以“组件都装了”宣称支持千万级吞吐。

<a id="handoff"></a>
## 17. 一页检查清单、排障与交接

### 17.1 每个阶段都记录

详细30项在 `DEPLOYMENT-CHECKLIST.md`，全部初始 `NOT_RUN`。最低开发准入：版本/六节点/网络/PG/Temporal执行/Kafka-Outbox/CH读写/基本监控通过；备份和恢复缺项时只允许空数据开发，不带生产数据。

生产准入还要：告警实际送达、独立备份恢复、TLS/ACL正反向、PG切主CDC连续性、故障模型、持续负载/磁盘增长、业务24.8不变量验收。**本手册没有代替这些测试执行。**

### 17.2 常用只读命令

```bash
kubectl get nodes -o wide
kubectl get pods -A -o wide
kubectl get pvc -A
kubectl get pv
kubectl get events -A --sort-by=.lastTimestamp | tail -60
kubectl top nodes
kubectl top pods -A --sort-by=memory
bash scripts/record-cluster.sh
```

| 现象 | 先查什么 | 禁止的捷径 |
|---|---|---|
| Pod Pending | requests、亲和性、PV位置/尺寸、节点实际余量 | 删PVC、降低requests伪造资源 |
| PG写入不动 | 同步副本、锁/事务、磁盘/归档、连接 | 关fsync、偷偷异步 |
| Temporal Job失败 | CA是否在Job挂载、账号、PG同步、Chart字段 | 重建数据库、降到trust |
| Kafka不Ready | KRaft角色、PV、ISR、Operator日志 | 清空元数据和卷 |
| Connect认证错误 | CA、SCRAM、PG密码文件、数据库权限、插件路径 | 全Topic超级用户/全库CDC |
| CH配置失败 | XML、内存、证书SAN/挂载、UID | 关TLS、设目录777 |
| 内网/DNS超时 | 私网路由、WireGuard、Pod网段冲突、NetworkPolicy | 开公网所有端口 |
| 磁盘快满 | 真实新增、WAL/归档/slot、Kafka段、日志、镜像 | 删WAL或未确认业务数据 |

### 17.3 接口交接表

| 接口 | 集群内地址 | 认证／说明 |
|---|---|---|
| PG当前主库 | `crawler-pg-rw.db.svc.cluster.local:5432` | TLS、专用数据库账号 |
| 事务池 | `crawler-pg-pool.db.svc.cluster.local:5432` | TLS、Pooler兼容性与证书SAN验证 |
| Temporal | `temporal-frontend.temporal.svc.cluster.local:7233` | mTLS、namespace crawlsystem |
| Kafka | `crawler-kafka-kafka-bootstrap.kafka.svc.cluster.local:9093` | TLS/SCRAM、Topic/Group ACL |
| Connect维护 | `debezium-connect.kafka.svc.cluster.local:8083` | 只内部/管理员SSH转发 |
| ClickHouse | `clickhouse.analytics.svc.cluster.local:8443 / 9440` | HTTPS / native TLS、专用账号 |
| Grafana | `grafana.monitoring.svc.cluster.local:3000` | 管理员本地转发 |
| S3 | 实际供应商Endpoint | scoped credentials、独立生命周期 |

真正地址以部署后 `kubectl get svc` 为准。业务代码不使用某个PG PodIP或节点公网IP当数据库永久入口。

后续待开发：Control/Query/Clock/Plan、五种Worker、薄Ingest/事务/幂等/回执、本地Proxy与中心分组、Business Consumer、分析投递、业务控制台及错误/容量埋点。外围先搭好能减少造轮子，但不等于复杂业务正确性自动完成。

<a id="validation"></a>
## 18. 版本升级、文件清单与验证范围

### 18.1 安装后的升级纪律

保存版本表、Chart、镜像digest、YAML和必要数据备份。升级先在隔离环境回放，再一次一个副本维护。PG/Kafka存储格式与数据库Schema不保证可通过 `helm rollback` 回退。

`latest`不用于生产；安全补丁在测试后及时受控升级。兼容分支不是永久停留不动，维护者要记录支持到期日期。

### 18.2 包内容

```text
README.md                         本手册
inventory.json                    真实六节点地址（无密钥）
versions.lock.json                软件版本与镜像名
storage-plan.json                 初始目录/PVC逻辑预算
nodes/a1..s3/                    各机K3s配置、身份、空目录准备脚本
scripts/                         只读检查、安装、Secret、DB、证书与验收辅助
manifests/                       按章节应用；不可整个目录一次性递归apply
values/temporal.yaml              固定Chart配套values
examples/                        隔离测试、待填备份、只读网络检查
sql/infra-outbox-insert.sql        专用测试库事件
DEPLOYMENT-CHECKLIST.md           实际验收表
reports/static-validation.json    仅本地静态检查报告
```

### 18.3 当前已经做了什么

本地检查：YAML/JSON解析、Shell语法、Python语法、内嵌XML/YAML、六节点IP/角色一致性、文档链接与脚本文件存在性。官方版本页与兼容范围已重新查询。没把测试密码或集群token打包。

**尚未执行：目标VPS SSH安装、镜像拉取、Helm渲染、Kubernetes CRD服务端校验、TLS握手、PG/Temporal/Kafka/CH实际启动、故障注入、外部备份恢复、真实磁盘增长与吞吐压测。**本地容器环境无外部registry访问，不冒称运行验证已通过。

这是完整步骤与可审阅起始配置，不是未经目标环境测试就保证成功的一键生产安装器。任何关键标签、CRD或密码关系不匹配应停止并定位，不用删掉防护来让界面变绿。

<a id="sources"></a>
## 19. 官方依据

版本与工具行为核对于2026-09-22；live/stable文档会变化，实际安装冻结本包版本并保存下载清单。官方支持某Kubernetes版本，不等于已为本项目的小规格K3s组合做过性能认证。

[S01]: https://github.com/k3s-io/k3s/releases/tag/v1.36.4%2Bk3s1
[S02]: https://cloudnative-pg.io/docs/1.30/supported_releases/
[S03]: https://strimzi.io/downloads/
[S04]: https://docs.k3s.io/installation/requirements
[S05]: https://docs.k3s.io/networking/basic-network-options
[S06]: https://github.com/helm/helm/releases/tag/v4.3.0
[S07]: https://www.postgresql.org/docs/release/18.6/
[S08]: https://cloudnative-pg.io/docs/1.30/replication/
[S09]: https://cloudnative-pg.io/docs/1.30/connection_pooling/
[S10]: https://cloudnative-pg.io/plugin-barman-cloud/docs/usage/
[S11]: https://debezium.io/documentation/reference/stable/connectors/postgresql.html
[S12]: https://kafka.apache.org/community/downloads/
[S13]: https://raw.githubusercontent.com/temporalio/helm-charts/temporal-1.7.0/charts/temporal/values.yaml
[S14]: https://github.com/temporalio/temporal/releases/tag/v1.32.0
[S15]: https://github.com/temporalio/ui/releases/tag/v2.54.1
[S16]: https://github.com/ClickHouse/ClickHouse/releases/tag/v26.8.10.6-lts
[S17]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html
[S18]: https://docs.k3s.io/cli/etcd-snapshot
[S19]: https://kubernetes.io/docs/concepts/storage/volumes/#local
[S20]: https://kubernetes.io/docs/concepts/storage/persistent-volumes/#expanding-persistent-volumes-claims
[S21]: https://clickhouse.com/docs/operations/backup
[S22]: https://kubernetes.io/docs/concepts/services-networking/network-policies/
[S23]: https://cert-manager.io/docs/releases/
[S24]: https://prometheus.io/download/
[S25]: https://grafana.com/grafana/download
[S26]: https://github.com/grafana/loki/releases/tag/v3.7.8
[S27]: https://github.com/grafana/alloy/releases/tag/v1.19.2
[S28]: https://github.com/kedacore/keda/releases/tag/v2.20.2
[S29]: https://www.pgbouncer.org/
[S30]: https://debezium.io/releases/3.6/
[S31]: https://cloudnative-pg.io/plugin-barman-cloud/docs/installation/
[S32]: https://pypi.org/project/temporalio/1.30.0/

**执行入口：A1解压 → 六机只读检查 → 私网与安全组 → K3s → 逐组件安装与验收。磁盘先用现有容量，清理和预警从第一天开启，不把最终容量采购当成起步前置条件。**
