# dsh-plugin-session-fleet

Session Fleet 为 DeepSeek Harness 智能体提供六个工具，用于定位相关会话历史、读取原始证据，以及创建会话或向其他会话发消息。

[English](README.md) | 中文

## 安装

```sh
dsh plugin --profile <profile> add dsh-plugin-session-fleet
```

bundle patch 是可选开启的：它插入一行 `tool-session-fleet`，使用保守默认值。安装后在插件页启用「会话舰队」。

## 从 0.4.0 升级

0.5.0 新增待处理消息管理与可读检查结果。结构化协作消息默认在下一步骤投递（`steer`），字符串保持下一轮投递（`queue`）。显式 `delivery` 覆盖默认值。读取模式新增有界的顶层 `text` 和截断元数据，同时保留完整原始 `event`。`manage_session_inbox` 新增待处理对等消息的检查、版本校验更新和撤回。发送收据新增 `revision`，队列预览显示类型、发送者提示与摘要。已发布的 0.4.0 对所有消息默认使用 `queue`，不含这些可读字段或待处理消息管理。

## 从 0.3.0 升级

0.4.0 新增标题筛选、全文索引停用时的单会话字面检索，以及支持失败过滤和固定边界分页的工具调用清单。结构化对等消息与每个 Agent 的计划策略，帮助它们在重叠修改前商定 owner 和工作范围。

五个工具名称与原有字符串消息保持兼容。跨会话全文搜索仍需要宿主索引。协作记录表示双边约定，不提供资源锁或自动释放所有权。消息格式与冲突规则见主动协作一节。

## 从 0.2.2 升级

0.3.0 在已发布 0.2.2 的四个工具基础上新增 `inspect_session`。列表与搜索的调用方需按 `hasMore` 和 `nextCursor` 继续读取后续页。投递被接受只表示进入原生队列，不代表任务完成。请保留 `messageId`，持久化结果未知时先检查目标再决定是否重发。

检查默认返回概览与原生详情调用。需要临时文本导出时显式传 `transcript: true`。原始存储位置取决于宿主与后端，有索引的全文搜索保留既有宿主分词器。

## 每个智能体安装的工具

- `list_sessions`：列出可见会话及状态、活跃时间与工作目录，不会激活任何目标。可选 `query` 按标题做不区分大小写的字面子串匹配，接受 1–500 个 UTF-16 代码单元，不依赖全文索引。默认数量取 20 与 `maxListRows` 的较小值；`hiddenSubagentSessions` 只统计所有权隐藏，与 cwd 过滤无关。
- `search_sessions`：先限定 Host 允许访问的会话，再搜索有索引的当前用户与助手消息。全文搜索被停用时，错误提供 `list_sessions` 标题查询示例。支持 `cwd`、ISO 8601 时间 `after`/`before`、`limit` 和 `cursor`；命中包含有界片段、事件 `seq`、目录、状态、活跃时间及已有标题提示。
- `inspect_session` 默认 `mode: "outline"`，返回截断概览、宿主可提供的原始 `source.location` 和可执行的 `detailAccess` 示例。用 `mode: "search"` 与 `query` 查询会话内事件，再用 `mode: "read"` 与 `seq` 读取顶层正文、完整原始事件及有界相邻摘要。用 `mode: "calls"` 在不加载正文的情况下定位工具输入、结果和失败项。原有私有文本投影仅在概览模式显式传 `transcript: true` 时导出。
- `manage_session_inbox`：不激活目标即可查看待处理的对等输入，也可按原生 ID 与期望版本原位更新或撤回一条待处理消息。普通用户输入与已消费历史受到保护，详见待处理消息管理。
- `create_session`：创建独立的普通对话，接受显式 `cwd` 或 `workspace_id`，两者互斥。只有两者都省略时才继承调用者 workspace，找不到时使用调用者记录的工作目录。
- `send_to_session`：经原生收件箱投递对等输入，返回实际 `delivery`、稳定 `messageId`、对应 `revision`、`accepted`、`persistence`（`acknowledged` 或 `unknown`）及 `retrySafe: false`。收据的 `accepted` 只表示进入队列，不是另外一条协作接受决定，也不代表处理完成。flush 未确认或失败时仍可能已经送达，因此返回带检查提示的未知收据。入队异常也会在错误中提供消息 ID 并明确结果未知。

两个发现工具均返回 `hasMore`，还有结果时提供不透明的 `nextCursor`。保持过滤参数与 limit 不变，将它作为 `cursor` 继续调用。列表按活跃时间排序，列表变化时拒绝旧游标。搜索采用动态遍历，每页重新经过宿主授权并排除已返回的会话 ID，新匹配可能出现，不承诺整个结果集来自同一冻结快照。搜索句柄会过期，也可能因容量或卸载失效，最多记住 `searchCursorMaxSessions` 个已返回 ID；达到上限时缩小目录或时间范围。标题只是可选提示。搜索保留宿主 provider 的分词与页大小限制。

投递消息携带专用的 `session-fleet` 来源标识与对等输入提示，用于向目标表明这是对等智能体输入。确实需要响应时，对端主动调用 `send_to_session` 回复发送者。插件不会自动转发最终回答或生成确认消息。

## 待处理消息管理

以 `session_id` 调用 `manage_session_inbox`，默认 `action: "list"`。它直接读取原生投影，不恢复或激活 Agent。条目分开显示原生 ID、版本、发送者、owner、投递边界、任务、回复引用、待决下一步、摘要和修改权限。`selfAddressed` 比较真实发送者与收件人，不把任务 owner 当成发送者。摘要预览至多 800 个 UTF-16 单元，传 `message_id` 可查看更完整内容，至多 `maxMessageChars`。手动 UI 编辑造成正文与结构化来源记录不同时，带 `bodyEdited` 并显示实际正文。

分页使用 `limit`、`hasMore` 和不透明 `nextCursor`，待处理输入变化会使旧游标失效。`completionMessageId` 指向同一发送者、同一精确回复引用的待处理完成通知。撤回早期发现前先核对它的覆盖范围，不能仅凭时间较久或任务名称相似就判定内容过时。

以 `action: "replace"` 传 `message_id`、`expected_revision` 和 `text`，只有原发送者能更新。对结构化消息更新累计摘要，对字符串消息更新正文。原生 ID、发送者、协作类型、任务、owner、scope 和队列位置保持不变。改变约定需发新提案，下一次更新使用本次返回的新版本。

以 `action: "withdraw"` 传 ID 与期望版本，发送者可撤回自己的待处理投递，收件人可移除自己收件箱中的对等输入。普通用户输入和已消费消息不可修改。版本变化或消息已被消费时拒绝操作，不追加另一条消息。修改时可恢复冷 Agent 以访问收件箱，但不启动模型轮次，保留原生事件审计，也不撤销所有权约定。跨工作区修改需要 `allowCrossWorkspace`，对子代理的修改始终拒绝。

更新摘要时保留独立发现，完成通知只有覆盖早期证据时才足以替代旧通知。检查结果不等于撤回待处理输入，撤回后原发送收据仍是历史入队证据。

新预览以 `[Fleet <类型> · <发送者提示>] <摘要>` 开头。加载时会原位刷新已挂载 Agent 的旧 Fleet 前缀，ID、来源记录与正文保持原值，也兼容提示与正文合并在同一文本块的旧输入。不会为刷新预览激活冷 Agent，原生历史仍可查。

## 主动协作

委派审查或有归属的子任务时，若原生 Team/subagent 工具可用且已获授权，优先使用它们。`create_session` 不建立 Team 成员关系或共享任务生命周期。委派不可用或未获授权时，先自行完成工作，除非用户要求独立的普通对话。Fleet 用来协调既有的独立会话。

结构化消息默认 `steer`：忙碌 Agent 的待处理反馈在下一次获准步骤进入模型，不取消正在运行的工具。字符串默认 `queue`，等待当前轮结束；显式 `delivery` 可选择任一边界。可等待的信息才使用 `queue`，在活动轮内等待无法消费下一轮回复。将相关且不阻塞的发现合并为一条 `update` 或 `complete`，及时报告阻塞。通过 `inspect_session` 读取反馈不会使其出队，显式排队的消息后来到达时，应识别已经处理过的任务阶段。

每个 Agent 的策略会在共享写入、独占资源使用或明显昂贵的重复工作之前提示发现相关会话，并在范围、owner、依赖变化、冲突或交接时重新核对。独立短只读工作无需扫描或广播。发现与跨工作区授权使用会话记录目录，它可能不同于命令执行目录。策略提供该记录目录，目录列表为空仍不能排除其他目录中的相关任务或共享资源。原生 Team 内仍使用其任务与归属工具。

协作时，`send_to_session.message` 也接受结构化对象，原有字符串继续可用。TypeScript 使用方可导入 `CoordinationRecord` 读取原生消息来源元数据。最小握手是 `propose → accept` 或 `block`。提案明确一个 `task`、显式 `owner`、1–16 个含访问方式的精确 `scope` 标识、简短 `summary`，以及 `next` 中所求的决定和检查点。例如：

```ts
await tools.send_to_session({
  session_id: peerSession,
  message: {
    kind: 'propose',
    task: '协调认证输入校验与既有测试工作',
    owner: yourSessionId,
    scope: ['write:/repo/src/auth'],
    summary: '我的任务修改校验。我负责实现，你继续负责原有测试范围。',
    next: '请在下一计划检查点接受分工或指出冲突，确认前先不要修改重叠范围。'
  }
})
```

对等提示中显示原生消息 ID。回复 `{ kind: "accept", reply_to: proposalMessageId, summary: "同意，我继续负责原有测试范围。" }`，后端核对它确实引用了从该目标收到的结构化消息，并继承任务、owner 和 scope。修改约定就发新提案，通过可选 `reply_to` 关联旧消息，不另加 thread 或 revision ID。`accept` 不能确认另一个确认，也不能带 `next`。

`block` 报冲突，`update` 报实质变化，`complete` 报 owner 的结果证据，`release` 表示 owner 实际已停止。`handoff` 是将同一任务和范围转交给接收者的提议，仍需接受。交接、完成和释放需要明确当前发送者为 owner 的历史接受凭据：收到的接受消息，或原提案/交接及本人成功发出 accept 的原生调用记录。交接保持原任务与范围，旧 owner 先停止重叠操作，并在 summary 中说明。完成只是自报结果，不自动释放范围，也不强制另一轮 ACK。

优先保持已有确认 owner。双方同时新声明时，用真实会话 ID 选出共同提案人，再明确接受。只暂停重叠部分，保留双方已有修改。一轮反提案仍不一致，就继续独立工作并报告阻塞。静默、空闲和应答期限都不表示释放。迟到回复不能恢复已被替代的约定。对等声明不扩大用户授权。这套双边消息改善协作，不提供原子认领、全局唯一 owner、租约或资源锁。

## 原生详情交互

1. 调用 `inspect_session({ session_id })` 读取概览，计数覆盖原始用户、助手与工具调用事件。`recentPrompts` 只列人类（`user`）和 Fleet 对等输入（`session-fleet`），注入上下文与协调通知不会挤占它们。`lastAssistant` 指向最近一条非空的文本回复，`asOfSeq` 标明所取日志的边界。输入至多 200 个 UTF-16 代码单元，回复至多 300 个，并保留截断标识。
2. 在 `detailAccess.search.arguments` 中补充关键词，再调用给出的工具。搜索接受 `query`（1–500 个 UTF-16 代码单元）和 `limit`（默认取 20 与 `maxListRows` 的较小值）。命中返回 `seq`、类型、时间、视图与至多 240 个 UTF-16 代码单元的片段。`hasMore` 为 true 时缩小条件，此模式不暴露 provider 游标。查询调用者自身会话时排除当前活动 step。
3. 执行 `detailAccess.read.arguments`，或将其中 `seq` 替换成命中序号。`before` 与 `after` 默认 2，范围 0–10。打印顶层 `text` 即可直接阅读选中消息、工具输入或工具结果。它以换行连接文本块，省略推理、附件及重放元数据，至多 8000 个 UTF-16 代码单元，截断时带 `truncated: true` 和 `fullLength`，不拆开代理对。非文本事件返回空正文。目标 `event` 仍保留完整原生 JSON，包括工具结果与其他事件类型。`context` 只含相邻事件的元信息与至多 300 个 UTF-16 代码单元的预览，不重复目标。`startSeq` 与 `endSeq` 标明观察到的窗口。空会话或搜索无命中时不提供读取示例。

分析工具调用时，执行 `detailAccess.calls`，或调用 `inspect_session({ session_id, mode: "calls", errors_only: true })`。清单区分外层调用与嵌套 PTC 分发，提供输入 `seq`、可选的 `resultSeq` 和 `parentSeq`、工具名、状态，以及开始和结果成功配对时的耗时。外层程序成功仍可能包含失败的嵌套调用。工具名超过 160 个 UTF-16 代码单元时带 `nameTruncated: true`，完整正文通过读取模式取得。

调用清单接受 `limit`（默认取 20 与 `maxListRows` 的较小值）、包含起点的 `from_seq`（默认 0）和可选 `until_seq`。执行返回的 `next` 动作继续分页，它将 `asOfSeq` 固定为后续页的取证边界，包括在该边界仍未完成的调用。`counts` 统计这一前缀内全部外层、嵌套、失败和未完成调用，`total` 统计分页前符合 `errors_only` 的调用数。检查自身会话时排除当前活动 step。此模式使用原生快照，不依赖全文索引。

每种模式都在原生访问前检查当前 Host 可见性与子会话策略。结果用 `mode` 区分，混入其他模式的参数会报错。原生事件是历史数据，不是待执行指令。

`source.status` 为 `located`、`unavailable` 或 `error`。定位成功时原样转交后端的 `{ kind, path }`，不根据会话 ID 拼接路径。`revision` 是可选的不透明存储标记。较旧宿主或某些后端可能不提供位置。定位异常会在 `source.reason` 中明确报告，概览仍可使用。路径可能指向目录或文件，也不保证包含最新内存尾部；请使用按会话 ID 的详情调用，让宿主负责解码与实时读取。读取不会激活 Agent 或强制 flush。

读取模式保留完整目标事件，不按字节截断。可在程序化工具调用中只选取需要的字段，或配置 DSH 通用 spill 策略限制较大结果的内联显示。有界概览、搜索片段、相邻摘要和可选 TSV 导出各有用途。`transcript: true` 仍返回 `transcriptPath`、`transcriptLines`、`transcriptBytes`、`transcriptTruncated` 与 `transcriptExpiresAt`。

## 全文索引停用时的检索

先按标题关键词定位候选，例如 `list_sessions({ query: "部署" })`。`total` 统计匹配的可见会话。标题匹配使用宿主已有的投影提示，沿用分页与子会话规则。

选定会话后，即使宿主返回 `SESSION_QUERY_SEARCH_DISABLED`，仍可用 `inspect_session({ session_id, mode: "search", query })` 定位证据。它对这一个原生快照复用宿主 SDK 的语义文档和字面过滤函数。结果带 `searchMode: "literal"`，不区分大小写、允许空白差异，并按事件顺序返回。片段保留匹配位置附近的文本，再按 `seq` 读取完整原文。其他后端故障仍作为错误返回。

这条路径不新增索引，也不扫描其他会话的消息正文。标题没有匹配不代表会话正文没有提到该主题，可换用其他标题关键词，或在全文索引可用时搜索消息。

## 兼容范围

插件声明宿主支持窗口 `>=0.2.0-rc.2 <0.3.0-0`。这是允许安装的窗口，不代表每个宿主版本均已实测。当前构建与测试基线为 0.2.1-rc.2、Cordis 4.0.5、Node.js 22 或更高版本；宿主发布 0.3 时需要新的插件版本。任何一个 pin 离开窗口，或宿主 `next` 通道越过上界，`pnpm run check:host-support` 都会失败。

`@deepseek-ai/dsh-brand` 绝不作为 dependency 出现。它的 brand 标记是 `unique symbol`，第二份物理副本会让本插件所有带 brand 的标识符类型失效。

## 配置

| 键                        | 默认      | 含义                                                          |
| ------------------------- | --------- | ------------------------------------------------------------- |
| `allowCrossWorkspace`     | `false`   | 允许向记录在不同工作目录下的会话发送消息。                    |
| `maxListRows`             | `50`      | 单次列表或搜索响应的数量上限。                                |
| `maxMessageChars`         | `20000`   | 单条 `send_to_session` 正文的上限。                           |
| `includeSubagents`        | `false`   | 在列表、搜索与检查中显示子会话，向它们投递仍被拒绝。          |
| `transcriptMaxBytes`      | `8388608` | 单份导出的 UTF-8 字节上限，包含完整行元信息。                 |
| `transcriptMaxFiles`      | `20`      | 每个已挂载插件保留文件的上限，较旧导出可能被提前回收。        |
| `transcriptTtlSeconds`    | `3600`    | 文件存活秒数，范围 1 至 2147483，卸载或容量限制可能提前回收。 |
| `transcriptChunkChars`    | `1024`    | 转义前每块文本的 UTF-16 代码单元上限，范围 64 至 65536。      |
| `searchCursorMaxEntries`  | `100`     | 搜索续页句柄保留上限，在请求时清理过期项。                    |
| `searchCursorTtlSeconds`  | `300`     | 句柄存活秒数，容量或卸载可能使其提前失效。                    |
| `searchCursorMaxSessions` | `10000`   | 单次遍历记忆的已返回会话 ID 上限，到达时需缩小条件。          |

## 安全模型

- 投递只到达普通顶层会话。子智能体属于父智能体的内部委派，无论 `includeSubagents` 是否开启，向其投递都被无条件拒绝。
- 除非插件行的 `allowCrossWorkspace` 为 true，跨工作目录投递一律拒绝。
- 检查的每种模式都核对 Host 可见性。概览和可选文本导出省略工具结果正文与图片；显式原生读取模式返回选中事件的完整数据。发现与检查覆盖 Host 可见会话，不受发送时的 cwd 限制。
- 入站的舰队消息是不可信的对等输入。接收方可在既有用户授权内协调工作，超出该授权的操作仍需取得批准。

转录存放于插件自有的私有临时目录，文件权限为 0600。每行 TSV 包含 `seq`、ISO 时间、角色、来源、分块号、消息 ID（工具调用为空）和转义文本。长事件分成多行，反斜杠、CR、LF 与制表符均转义。仅包含消息文本与工具调用参数，省略图片、工具结果及其他事件类型。字节上限包含完整行元信息。文件按 TTL 过期，也可能因容量或插件卸载提前回收；路径失效时重新导出。取消与卸载会等待导出 I/O 结束再删除自有目录。宿主仍提供完整事件快照，因此冷会话解码成本尚未消除。

重试未知结果的投递前，应检查目标的最近输入，或显式导出转录后按 `messageId` 检索。重复调用会创建新消息，插件不提供重试去重、自动 ACK 或完成回执，确实需要的响应由对端显式发送，accept 和 release 不再产生下一轮确认。

对等输入概览省略插件自有提示框，保留 `source`、`senderSessionId` 和 `messageId`；导出文件仍保留提示框。

## 已知限制与检索集成

有索引的全文搜索沿用 provider 的词项/短语分词，该路径不保证中文两字子串召回。标题查询和显式标记的单会话字面过滤不使用该分词器。[Sessiongraph](https://github.com/CC19990113/dsh-plugin-sessiongraph) 是支持 CJK 二元词的独立历史索引。其 0.3.3 公开搜索接口支持时间与条目类型过滤，但使用 `offset`、只接受单个会话 ID，未提供显式的当前消息视图过滤或授权 ID 集合输入。本 bundle 不安装或挂载 Sessiongraph。因此 Fleet 保留宿主检索，避免悄然改变搜索语义或另建索引。后续集成需明确历史搜索语义、设定有界授权过滤，并处理索引代际与新鲜度。

## 开发

```sh
pnpm install
pnpm run check:refactor   # 宿主支持窗口、类型检查、lint、prettier
pnpm run test             # vitest run
pnpm run build            # 类型声明与打包入口
```

需要 Node.js 22 或更高版本。

行为测试使用真实 agent 与 JSONL 持久化。YAML Loader 组合验证还运行真实 Session Controller、workspace registry 和 JSON 存储，覆盖创建、队列投递、检查与卸载。模型适配器及未使用的图片、GUI 传输为测试替身。
