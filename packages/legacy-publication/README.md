# 旧业务发布逻辑来源

来源：`oldsystem/services/qybullmq/src` 的 Business Publication 接收、连续序号激活、投影和哈希模块。移植时保留严格字段合同、频道归属、不可变证据和业务投影行为。

C1 适配：删除 HTTP/Express 接收入口，仅保留 PostgreSQL store；`crawlObservationStore.js` 仅保留 canonical hash；新增同批任一域拒绝时隔离本事务中新建的其他域，防止后续消息或进程恢复触发部分发布。Kafka 接收和回执在 `apps/business-sink`。

真实数据适配：同一频道重复出现相同类型、URL 的链接时，公共投影保留首个标题和位置，符合旧表的唯一约束；原始重复项仍完整保留在不可变 inbox / revision 中。投影重试耗尽会返回失败回执，重发相同版本可重新排队该版本的失败投影。

历史 Agent 输入视频 ID 列表没有保存在新采集合同中，因此不会从当前视频窗口倒推历史列表。旧合同输入列表设为空并按空列表计算哈希；原 Agent `input_hash` 写入 envelope 的 source provenance。
