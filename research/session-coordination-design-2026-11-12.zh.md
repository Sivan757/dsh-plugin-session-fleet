# 普通会话 Agent 的主动协作与标准消息

## 决策与目标

多个独立会话 Agent 在进入共享副作用阶段时，先发现相关工作、明确一个任务的 owner 与范围，再执行双方接受的分工。协作信息进入现有原生队列、消息来源和事件日志，不新增消息队列、锁服务、心跳或持久化索引。

本轮由只读顾问选择人类沟通方法，lead 结合现有宿主接口实现并验证。目标是降低重复工作和相互覆盖的机会，不能把文字约定解释为资源互斥。

## 人类方法的依据

| 方法 | 本案采用的部分 | 一手来源 |
| --- | --- | --- |
| 承诺式任务契约，主方法 | 明确目标、执行者、范围与交付条件，主动接受而非仅收到 | [HBR 官方摘要：Promise-Based Management](https://store.hbr.org/product/promise-based-management-the-essence-of-execution/r0704e) |
| Check-back 与 Handoff，辅助 | 回读关键边界，交接明确责任、时机与下一步 | [AHRQ Teamwork，Slides 32–34](https://www.ahrq.gov/hai/cusp/modules/implement/teamwork.html) |
| SBAR，辅助 | 冲突报告压缩为问题、必要背景、影响判断与所求行动 | [IHI SBAR 官方说明](https://www.ihi.org/library/tools/sbar-tool-situation-background-assessment-recommendation) |

顾问读取了 HBR 的完整公开摘要（未购买全文）、AHRQ 相关全文和 IHI 全文。lead 复核 IHI 原文。人类方法的依据置信度高；本项目将其迁移为异步 Agent 协作的效果置信度中。这里使用两步最小承诺握手，不等同于完整的人类 check-back 三步或强制交付验收流程。

## Agent 如何主动知道何时使用

每个 Agent 的短 POLICY 明确触发点：首次进入共享写入、独占资源或昂贵重叠工作；范围、owner、依赖变化；检测到冲突；交接和约定检查点。先按当前工作目录发现，检查可能冲突的会话，然后对确切相交部分协商。独立短只读工作不扫描，不每个工具调用轮询，不向所有会话广播。

工具参数 schema 直接提供标准结构，接收端 frame 显示原生 sender 与 messageId，避免只在 README 中教用法。POLICY 提供当前 Agent 的真实 session id。原生 Team 内继续用已有任务归属和 CAS，Fleet 用于普通会话的双边沟通。

当前 cwd 发现不证明已找到全部竞争者。不同工作树仍可共享端口、profile 或 Git refs；资源标识必须指向实际对象并注明 read/write/exclusive。跨工作区投递继续受配置边界约束。

## 标准与语义

最小握手为 propose → accept，不能接受时 block。accept 是终结答复，不再要求 ACK。complete 是附证据的自报完成，依赖它的消费者应自行核验，不强制增加一轮消息。

| kind     | 含义                                              |
| -------- | ------------------------------------------------- |
| propose  | 明确 task、owner、scope、summary、所求 next 决策  |
| accept   | 接受 exact reply_to 所指的提案或交接，不带 next   |
| block    | 报告冲突、不能承诺的原因和所需决定                |
| update   | 实质变化或检查点进展，双方均可发送                |
| handoff  | 原 owner 提议将同一任务和范围交给接收者，仍须接受 |
| complete | owner 自报结果、验证证据和剩余问题                |
| release  | owner 表示实际已停止并让出，不带 next             |

所有结构化消息包含 kind 与 summary。提案及交接明确 task、owner、scope、next。next 写一个可回答的行动及检查点，可用绝对应答时刻；应答期限不是租约。owner 可以是发送者或接收者，不能靠说话角色推断。scope 接受 1–16 个精确资源标识。字符串消息继续兼容。

回复用 reply_to 引用从同一 peer 收到的原生消息，并从该不可变消息继承 task、owner、scope。修改提案产生新的 messageId，不额外引入 thread 或 rev。handoff 要保持任务与范围，旧 owner 先在安全点停止相交操作，并在 summary 说明，新 owner 明确接受后才开始。

后端核对引用来源，拒绝 accept→accept。完成、释放与再交接可以使用双方各自的历史接受凭据：提议方引用收到的 accept；接受方引用收到的 proposal/handoff，并从原生 tool/call+tool/result 或 PTC 完成记录验证自己成功发出了匹配的 accept。匹配工具名、peer、原提案 id、原生 call id 和成功收据。普通输出、错误 peer、错误提案、失败或 pending 记录不构成凭据。这只是历史声明证明，不是当前有效 owner 或 peer 已处理消息的证明。

## 冲突、超时与收敛

已有可核实 owner 优先。双方同时新声明时，固定真实 sessionId 顺序只用于选共同提案人，仍需对方接受并避让。双方已写入时，在安全点停止相交操作并保留改动。一轮反提案仍未一致就报告阻塞，继续不重叠部分，不反复转派。

静默、空闲、running=false、deadline 和投递收据均不释放范围。到期先检查，必要时发一次关联的状态问询。迟到或重复接受不能恢复已释放或被替代的约定。后端没有全局协议状态机，Agent 恢复上下文时必须核对当前约定。peer 消息不扩大用户授权。

## 验证记录

17 个协议回归通过，完整套件 123 个测试通过，host support window、类型、lint、格式检查和构建通过。协议回归从缺失行为失败开始；顾问复核发现提议方 owner 与接收方 owner 不对称，先复现两个失败，再补齐直接调用与 PTC、proposal 与 handoff 四种角色路径。错误接受凭据不能解锁后续操作。故意删除目标 peer 匹配条件后，错误凭据回归立即失败；恢复后 17 项协议回归重新通过。公开入口导出 CoordinationRecord，确保消息来源类型扩展在生成声明中可达。

真实 YAML Loader、Session Controller、JSONL、队列与 AgentLoop 上，用脚本模型适配器运行双 Agent propose→accept→complete：一个共享文件仅在明确接受后写入一次，最终只有这三条协作消息，无 ACK 循环。另一路验证接收者任 owner 后能 complete、handoff、release。模型适配器是测试替身，不能据此声称自然模型会按某个概率主动触发。

2026-11-12 08:21 UTC，构建后通过 Plugin Manager 重挂载相同本地 source，两次变更均 application=applied。当前 DSH 实时目录已暴露字符串、提案、回复三个 message 分支及七种 kind。真实工具调用验证错误 owner 和未收到的 reply_to 在目标投递前被拒绝，没有向用户的普通会话发送测试消息。

五个实时工具的名称、描述和输入参数规范紧凑 JSON 从 4,781 增至 6,408 个字符，净增 1,627。口径为 Inspect 返回的规范，不包含 POLICY、输出类型或 tokenizer，不能当作 token 测量。

## 能力边界与下一步体验

标准消息不能保证全局唯一 owner、原子认领、未知第三方发现、强制写范围、故障检测、自动释放、停掉正在运行的工具或 exactly-once。需要强互斥的端口、部署或数据变更，必须使用资源侧实际可检查的排他约束。

在两个同工作区普通会话中给相交任务，观察进入共享写入前的发现、精确提案和接受，以及无冲突部分是否继续推进。自然模型主动触发率和长期并发效果尚未做多轮 A/B 测量。
