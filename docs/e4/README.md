# E4 第二个采集节点

2026-10-11：第二个采集节点已上线，两个 Worker 分别完成真实采集与业务交付，暂停 / 排空 / 重启及桌面 / 手机验收通过。公开结果见 [evidence.json](evidence.json)，完整运行证据在忽略的 `.runtime/e4/`。Temporal 保留 a1；现场调度程序 `intent-dispatcher` 已在 s1，搬迁并非本项前提。

现有 `execution-worker-0` 在 s2，浏览器身份 PVC 使用 local-path，PV 绑定 s2。增加该 StatefulSet 副本会共用原卷，不能作为跨机器扩容。新增独立 StatefulSet `execution-worker-s3` 和 PVC `execution-browser-state-s3`，Pod 身份 `execution-worker-s3-0` 固定在 s3；保留相同 Worker 标签、ServiceAccount、受众绑定投影令牌、网络策略及 headless Service。每个 Worker 的任务使用稳定身份队列，持久计划分配不因暂停或重启而转移。

新节点复用现网已验收 Worker 镜像 `main-5b4ad4e9dbe8-f97b9862` 与指纹网关 `1ff2fbba98b3c83f`，只向 s3 导入缺少的 Worker 镜像，不重新构建应用。单机计划容量 1、搜索槽位 1；s2 保持计划容量 2、搜索槽位 2。全局配置 v5、schema 37、自动搜索 / 准入 / 更新开关和每日 / Agent / API 预算保持。

s3 原有 Kafka、ClickHouse 和 business-sink，本项是共享节点上的有限扩容。上线前即时样本内存约 2.5 GiB、CPU 约 24%，操作系统可用内存约 5.2 GiB、磁盘剩余 47 GiB；这些只用于部署准入，不代表长期吞吐承诺。新增 Pod 沿用已验证资源边界：Worker 请求 50m / 192Mi、上限 1 CPU / 512Mi；网关请求 25m / 64Mi、上限 500m / 256Mi。

## 代理交接

先选取 12 个近期健康、启用且未退役的订阅代理，s2 保留其余 49 个。通过已有 Control API 的版本检查逐个禁用并解除分配，写入私密交接清单。每次请求前记录至少 330 秒后的启用时间，覆盖中心租约 300 秒和网络宽限；失去响应或进程重入不得缩短等待。截止前不向 s3 启用这些代理。

之后启用并分配给 s3，两节点代理管理器各自重新完成 YouTube 内容探测，至少存在合格出口才创建 Worker。对应订阅的服务器池加入 s3；已有 s2 代理不重新均衡，后续未分配端点按现有算法分配。租用 Service 保持 `internalTrafficPolicy: Local`，避免拿到其他节点代理。免费订阅的长期可用率仍是独立待办。

## 执行入口

所有重检查使用同一个锁、资源边界和单次 300 秒上限；以下命令按顺序运行。交接截止期间可以运行类型及隔离 Worker 检查；不要通过跳过等待提前启用代理。

```bash
npm run check:safe -- typecheck
npm run check:safe -- multinode-deploy prepare
npm run check:safe -- multinode-runtime before
npm run check:safe -- multinode-deploy detach
# 达到 handoff.json 的 not_before 后再继续。
npm run check:safe -- multinode-deploy activate
# s3 代理完成两次内容探测试用后。
npm run check:safe -- multinode-deploy deploy
npm run check:safe -- multinode-plans start
npm run check:safe -- multinode-plans check
npm run check:safe -- multinode-browser
npm run check:safe -- multinode-restart
npm run check:safe -- multinode-runtime after
```

`prepare` 只产生可复核部署清单；原 StatefulSet、配置、镜像身份、代理版本与分配均存于忽略的 `.runtime/e4/`。新对象采用 create，重入只接续属于相同清单的对象；不覆盖同名外来资源。两个小范围真实计划各采两条视频，确认 ABOUT / VIDEO / AGENT、持久回执及旧业务结构的交付版本；检查入口可重入，沿用记录的请求 / 计划，不重复创建。

原有业务与基础设施 Pod、重启次数、workload 配置哈希、全部旧视频身份、在途计划身份、迁移校验值和配置版本在前后验证中比较；旧业务库仍为 64 张原业务表。第二个 Worker 单独做暂停 / 排空 / 恢复、只读拒绝和桌面 / 手机布局验收；排空后重启新 Pod，验证 PVC、控制状态和加密浏览器身份文件保持。现有公网隧道继续运行。

## 回退与边界

需要回退时，先在 Worker 页面排空新 Worker，确认计划和搜索均已结束，再将 `execution-worker-s3` 缩到 0；原 Worker 继续运行。保留新 PVC 与固定队列身份，避免删除仍需恢复的输入。将对应订阅服务器池恢复为部署前值，再通过带版本检查的 API 禁用并解除 s3 的代理，保存旧租约截止，至少等待 330 秒后启用并重新分配到 s2。不要直接改 PG 分配字段或把在途计划改派给另一队列。

本项提供两个机器上的采集执行能力和单节点排空重启验证。s3 永久故障时，其固定计划仍保留在原身份队列，需要恢复该 Worker；没有新增自动跨节点接管。Temporal、MinIO、ClickHouse 的单节点边界仍按既有部署记录；本项未承诺整套系统高可用。以后升级 Worker 时必须覆盖两个独立 StatefulSet，原 `deploy-d2.ts` 是单节点历史升级入口，不能直接用作双节点升级。

## 实际验收

| 项目 | 结果 |
| --- | --- |
| 第二 Worker | `execution-worker-s3-0` 在 s3，固定身份队列、独立 PVC、容量 1；两个 Worker 均为 RUNNING、指纹网关 ready |
| s3 真实全量 | `d731f898-b179-4988-9941-030d2572469e`：ABOUT / VIDEO / AGENT 均 APPLIED，2 个视频、4 个管道步骤、5 个持久单元；交付 `066cd52a-0550-4958-ba46-e7c51c85870e` 为 DELIVERED |
| s2 真实全量 | `433404f9-1316-455f-8ba1-f46264241a81`：同样完成三域、2 个视频、4 个步骤、5 个持久单元；交付 `4b963129-00a7-4abf-b5c9-ce60755effc7` 为 DELIVERED；业务投影版本已核验 |
| 代理 | 12 个健康代理完成旧租约到期交接；启用时间 18:50:57 晚于安全截止 18:50:25。s3 全部通过试用，最终健康 12；对应 2 个订阅加入 s3 |
| 暂停与排空 | 第二 Worker 暂停 / 排空后新增计划分配 0、搜索领取 0；页面恢复接单成功 |
| 重启 | 只重建排空后的新 Pod；PVC、控制版本和 3 份加密浏览器身份文件保持，新进程心跳确认排空状态，再恢复 RUNNING |
| 页面 | Worker / 首页 / IP 三页 × 1920 / 390；横向溢出、浏览器错误及 API 错误均 0；reader 写入 403；公网 `/workers` 200 |
| 检查 | 类型检查、31 项隔离 Worker 集成检查及 Kubernetes 服务端 dry-run 通过 |
| 保留 | 全部原 Pod / 重启次数 / workload 配置、迁移校验值、配置 v5、51,383 个旧视频身份和在途计划身份保持；旧业务库原 64 表保持 |
| 连续采集 | 北京时间 18:44:31 → 18:58:52：视频 51,382 → 51,576，交付 1,858 → 1,868；s2 完成 9 个全量、s3 完成 1 个，交付 pending / failed 0；CDC RUNNING、复制槽 active、PG 评论正文 0 |

期间另有 1 个自动计划在 ABOUT 后按资格规则取消：订阅 734，低于现有 1,000 门槛；后续视频与画像未执行。验收窗口没有新搜索运行，不据此宣称双节点搜索吞吐已验证；搜索槽位已启用，搜索门禁由隔离检查及实际暂停后的领取记录核对。控制台原未提交的密码测试证据 SHA-256 保持 `57b4c57b3d8240d236feb8ec08845f17038adb1895afe9a4ae7e760ae8b4c709`。

后续状态（2026-10-12）：控制台正式部署与业务告警已完成，见 [收尾验收](../finish/README.md)。继续使用现有公网地址，固定域名是可选运营升级，不需要先提供新域名才能完成部署。此处及 `evidence.json` 的 schema 37、镜像和时间窗口仍描述 E4 当次验收；当前 schema 39 与上线版本见收尾记录。
