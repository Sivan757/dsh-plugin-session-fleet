# Session Fleet 功能、同类方案与优化评估

> 本文保留修复前的评估快照。当前实现、验证结果和保留限制见 [执行记录](/Users/sivan/workspace/dsh-session-fleet-plugin/research/session-fleet-implementation-2026-11-11.zh.md)。

评估日期：2026-11-11。对象为独立仓库 [Session Fleet](https://github.com/Sivan757/dsh-plugin-session-fleet) 的本地 main，提交 d74ead6，包声明版本 0.2.2。评估开始时工作树干净，本地领先 origin/main 四个提交。本文评估本地实现，未把它等同于 npm 已发布内容。

## 结论与评估口径

建议把产品定位固定为“DSH 普通顶层会话的发现、辨认、创建与通信”。保留五个小工具和渐进披露，以宿主会话日志与消息队列为事实来源。近期收益最大的工作是修复已证实的创建和列表缺陷、让搜索结果能够继续获取、拆开概览与昂贵的详情导出，然后补消息关联与兼容性验证。

中文检索确实有底层缺口，但并不需要把 Fleet 变成第二个历史索引项目。优先选择宿主修复，或完整复用 Sessiongraph 的服务。此前已否决的部分移植方案不作为默认建议。独立维护的完整索引、自动多轮对话、共享任务板、文件租约和向量数据库均没有现成需求证据支撑。

主模型采用 ATAM 的质量属性场景思路，辅以技术权衡矩阵：用“触发条件 → 可观察行为 → 成本与保证”比较选项。软件架构属于这一模型的直接适用领域，方法置信度高；本次为轻量评估，未执行完整的多方 ATAM 工作坊。框架出处：[CMU SEI 对 ATAM、场景和优先级的说明](https://www.sei.cmu.edu/library/how-to-address-the-problem-of-poorly-defined-requirements-in-software-system-design/)。

既定约束包括独立插件、复用 DSH 排队能力、默认排除子智能体会话、渐进披露、静态工具策略文本与尽量少的维护负担。当前 Host 的一次列表快照包含 859 个普通会话、1,339 个隐藏子会话；这说明分页与过滤已有实际使用价值。该快照不代表固定规模，也不说明每次搜索都会命中这些会话。

置信度指“对该路径能改善本问题的判断把握”，不是统计成功概率：高表示有当前代码、一手接口或隔离验证支撑；中表示机制成熟但本项目尚未集成或测量；低表示依赖较大的宿主演进、适配或尚未证实的使用需求。推荐程度与置信度分别表达，技术上可行的方案也可能不适合当前项目。

成本只列低、中、高相对投入，不虚构工期、token 节约百分比或真实负载的 P95。除现有测试和注明的探针外，其他方案均为设计建议。

## 当前功能与优势

| 功能 | 当前行为 | 已有价值 | 当前限制 |
| --- | --- | --- | --- |
| list_sessions | 读取宿主会话摘要，过滤子会话，可按 cwd 字符串前缀过滤 | 不启动目标智能体，返回状态与目录 | 只返回前部结果，无翻页；缺少可辨认的标题或目的；边界与计数存在已证实问题 |
| search_sessions | 通过 sessionController 搜索，同时获取全部摘要，再过滤并补 cwd、running、updatedAt | 每会话一条命中，便于先选择候选 | 字面量词项/短语搜索不等于任意子串；无范围参数与继续读取入口 |
| inspect_session | 返回计数、最近三条输入和最后回复，正文分别截到 200/300 个 UTF-16 代码单元；每次写转录文件 | 模型接收的信息有界，深读可以使用 grep | 宿主完整事件快照、重复扫描、同步文件写入；导出不是完整原始日志 |
| create_session | 接受 cwd 或 workspace_id；缺省查调用者所属 workspace | 可以复用已有 workspace 关系 | 自动补 workspace 与显式 cwd 的组合会出错 |
| send_to_session | resolveAgent 后 followup/steer，等待 flush，再返回 accepted | 复用原生队列；来源包含 senderSessionId；拒绝自身目标与子会话 | 跨目录限制只检查 cwd；无请求级关联、去重或完成回执 |

事实来源：[工具与执行入口](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:300)、[概览与导出](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:375)、[创建与投递](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:437)。

现有优点值得保留：读取不会激活目标；工具按 Agent 注册并在卸载时清理；消息来源写入日志；排队与 steer 复用宿主；响应 schema 清晰；策略 section 是静态文本。工具数量少本身有利于发现与学习，但静态文本并不自动意味着总 prompt token 已最优。本轮没有测首轮 prompt token 或缓存命中率。

## 同类方案及可借鉴部分

严格说，下面只有 Sessiongraph 是同生态的相邻插件；另外四项用于比较机制，不视为可直接安装的 DSH 替代品。比较范围是相关产品的已核实能力，不是全市场穷举。

| 方案 | 优点与证据 | 相对 Fleet 的局限或代价 | 建议借鉴 |
| --- | --- | --- | --- |
| [Sessiongraph](https://github.com/CC19990113/dsh-plugin-sessiongraph) | DSH 本机历史检索、中文重叠二元词、磁盘增量索引、Rust 内核与 TypeScript 回退；有 query 服务和 status/index 操作 | 解决历史召回，不负责唤醒、创建与向顶层会话排队；独立索引需要刷新与额外存储，原生模块有分发成本 | 复用完整服务、索引新鲜度和命中定位信息；避免复制半套实现 |
| [OpenClaw Session tools](https://docs.openclaw.ai/concepts/session-tool) | 接近 Fleet 的独立会话创建、列表、搜索、历史与发送；区分可见性、目标输入接纳、后续回复；支持输入身份与重试核对 | 依赖完整 Gateway 运行时、权限与存储体系，不能作为一个 DSH 小插件替换进来 | 过滤先于详情补齐，返回字节界限与截断标记，明确 accepted、persisted 与 completed 的区别 |
| [MCP Agent Mail Rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) | 跨客户端消息身份、thread_id、ack_required、read/ack 回执、联系策略、Git/SQLite 归档 | 新服务、身份与邮件归档增加维护；邮箱收件不等于启动 DSH turn；大量工具与文件租约超出 Fleet 当前任务 | 线程关联、回复关联和显式确认，不整体引入第二套队列 |
| [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search) | 多种编码智能体历史统一搜索；提供 robot/JSON、字段选择、输出预算、workspace/时间筛选、按命中扩展上下文 | 以历史读取为主，不负责 DSH 会话创建和投递；未核实当前原生 DSH connector，接入成本不能当作零 | 搜索结果预算、直接携带命中位置、输出索引新鲜度；本轮不建议迁入搜索引擎 |
| [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) | 团队内消息、任务依赖与协调由运行时承担；官方明确报告协调和 token 开销 | 主要服务一位 lead 管理的团队，不能替代普通长期主会话间的 Fleet；引入任务管理会重叠职责 | 保留所有权规则，区分“当前不运行”和“工作已完成”，避免默认自动拉起多轮互答 |

Sessiongraph 的基准数值来自其作者特定语料，未在本项目复测，因此本文不据此预测速度。其 README 对宿主搜索范围与存储方式的描述也不作为当前宿主事实：本次另查宿主实现与当前 API。Sessiongraph 源码声明了可复用 [query 服务](https://github.com/CC19990113/dsh-plugin-sessiongraph/blob/main/packages/service/src/index.ts)，但当前运行时 Inspect 没有编目该 Service，仍需安装/服务拓扑集成验证。

外部代码复用需按实际许可证评估：Sessiongraph 的仓库许可证为 MIT；Agent Mail Rust 与 CASS 的 README 标明 MIT 加附加条款，GitHub API 返回 Other/NOASSERTION，不能当作无条件标准 MIT 直接复制。这里借鉴设计，不给出许可适用的法律结论。

## 缺点一：显式 cwd 创建在真实 workspace 中失败，工作目录与工作区概念混用

**证据与影响。** [创建分支](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:452) 仅检查输入参数互斥，随后无条件尝试填入调用者 workspace。输入只有 cwd 且调用者已关联 workspace 时，最终请求同时含 cwd 与 workspaceId。[宿主创建接口](/Users/sivan/workspace/deepseek-harness/packages/api/session-controller/src/commands.ts:111) 明确拒绝这一组合。隔离探针捕获了这样的请求并收到相同错误。另一个事实是 [跨工作区投递判断](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:513) 实际比较原始 cwd 字符串，不比较 workspace 身份。

| 路径 | 技术方案与验收方式 | 代价与局限 | 置信度与建议 |
| --- | --- | --- | --- |
| A：单一位置解析，最小修复 | 显式 cwd、显式 workspace_id、缺省调用者 workspace、缺省调用者 cwd 四个分支只产出一个位置；只有两个参数都省略才继承 workspace。补“已有 workspace + 显式 cwd”用例，并明确当前投递规则按 cwd 比较 | 低；保留现有参数，仍需承认 cwd 与 workspace 的差异 | 高；优先实施 |
| B：用判别联合表达位置 | 工具接受 location 的 cwd/workspace 两种互斥类型，解析为统一目的地；创建和投递共享 workspace 解析结果 | 中；公共参数变化，需同步工具指引、文档和测试 | 高；接口确需升级时采用 |
| C：宿主负责解析位置与访问范围 | 宿主提供唯一的位置解析/授权入口，Fleet 传递显式选择与调用者身份；按 workspace 身份控制创建和投递 | 高；依赖宿主改动，适合多个插件复用同样规则 | 中；长期路径 |

同目录、同 workspace 和允许读取三个概念应分别陈述。当前跨目录保护只作用于发送，列表、检索和 inspect 并不因此变成“仅同目录读取”。对当前单用户 Host，这是一项需要明确的产品策略，不据此认定已发生权限漏洞。未来若面向多用户，读与发必须在执行入口分别授权，不能依赖提示词。

## 缺点二：列表上限与隐藏计数不可信

**证据与影响。** [列表实现](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:310) 对显式 limit 做检查，却把省略值固定成 20，忽略 maxListRows 小于 20 的配置；hiddenSubagentSessions 使用 items.length - filtered.length，把 cwd 过滤掉的普通会话也算进去。[Config](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:56) 的两个数字字段没有正整数约束。两个隔离探针分别得到“配置最大 5，返回 20”和“实际子会话 0，报告隐藏 33”。

| 路径 | 技术方案与验收方式 | 代价与局限 | 置信度与建议 |
| --- | --- | --- | --- |
| A：显式解析有效上限与独立计数 | Config 校验正安全整数；省略 limit 时取 min(20, maxListRows)，显式值按边界拒绝；先统计因 origin 隐藏的行，再做 cwd 筛选；用边界与真实返回值验收 | 低；需要同时维护 Config 和参数约束的一致性 | 高；立即修复 |
| B：Schema 驱动的规范化 | Config 与工具参数 schema 统一产出已解析请求，业务层只消费 effectiveLimit；统计采用分阶段结果，分别输出 eligibleTotal、scopeFiltered、hiddenSubagents | 中；增加 schema 规范化工作，但有利于模型看见准确范围与默认值 | 高；多工具都需要预算时采用 |
| C：宿主提供有界会话清单 | 宿主查询接受 scope、origin、limit、cursor，返回过滤后的页、nextCursor 与定义清楚的计数；Fleet 不再先取全部行再 slice | 高；涉及宿主 API 与读模型，仍需解析插件配置上限 | 中；与发现分页一起设计 |

## 缺点三：中文子串召回不足，字面量全文搜索容易被误解

**证据与影响。** [宿主 query](/Users/sivan/workspace/deepseek-harness/packages/session-query/session-query-sqlite/src/query.ts:218) 将查询作为一个 FTS5 短语，而 [索引定义](/Users/sivan/workspace/deepseek-harness/packages/session-query/session-query-sqlite/src/schema.ts:126) 没有所需的中文二元词处理。独立 SQLite 实验中，正文“广告点击率优化方案”在普通 FTS 中查“广告”得到 0 行，查全文得到 1 行；trigram MATCH 查两字也是 0，四字得到 1；trigram LIKE 查询两字可以返回 1 行。该实验验证 SQLite 机制，不是对用户实际索引的召回率测量。

| 路径 | 技术方案与验收方式 | 代价与局限 | 置信度与建议 |
| --- | --- | --- | --- |
| A：宿主增加 CJK 二元词索引 | 写入和查询使用同一 CJK bigram 处理，Latin 保留适当词项；采用独立检索字段/索引或多路融合，保留原文用于 snippets；版本化 schema 并重建派生索引；用两字、混合语言与短语样本验证 | 中到高，需宿主协作；bigram AND 会牺牲部分短语精度，词序需位置约束或原文复核 | 机制可行性：高；本项目迁移实现：中；长期首选 |
| B：完整复用 Sessiongraph 服务 | 将 Sessiongraph 作为可选 provider；调用其 query 获取命中与新鲜度，然后按 Fleet 当前可见范围和普通会话规则过滤，再用宿主核对目标身份 | 中；多一个插件与索引，需核实服务依赖、索引初建和刷新行为；不能把非当前索引命中当作当前授权 | 中；若近期必须改善中文，优先验证这一条，不再部分复制 |
| C：trigram 与短词子串混合 | 三字及以上走 trigram，短词走已授权候选集合上的 LIKE/instr；先用目录或时间缩小候选，输出扫描范围、完整性和 work budget | 中到高；两字查询会扫描，缩小范围会降低全库召回；需要宿主/provider 支持，不能仅改 Fleet 的 query 文本 | SQLite 行为：高；本项目整体收益：中；只适合范围明确的小语料查询 |

[SQLite 官方文档](https://sqlite.org/fts5.html#the_trigram_tokenizer) 明确短于三个 Unicode 字符的全文 MATCH 不命中，并说明 LIKE/GLOB 的扫描回退。此前“trigram 两字完全无解”应更正为“两字不能由它的 MATCH 索引直接解决”；此前“不同 tokenizer 不能共存”也过强，完全可以使用多个索引或独立列/字段组合，具体由 provider 设计。

## 缺点四：搜索与列表缺少继续获取和精准辨认能力

**证据与影响。** [search_sessions](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:334) 只接收 query，取宿主的有界结果后再过滤子会话，原样返回 hasMore，没有 cursor、limit 或范围参数。[宿主 search](/Users/sivan/workspace/deepseek-harness/packages/api/session-controller/src/list.ts:278) 也只公开前部 items 与布尔值。若这些命中主要是子会话，普通会话可能被挤到后面而不可达。列表只给最前若干行且没有继续入口。已有 API 的底层 sessionQuery 支持 searchSessions 的过滤与 cursor；复用时必须保留 Host 的可见性与访问检查，不能为分页绕过它们。

| 路径 | 技术方案与验收方式 | 代价与局限 | 置信度与建议 |
| --- | --- | --- | --- |
| A：插件接入已有 query 分页服务 | 单次解析授权与普通会话候选，使用支持 cursor 的底层 searchSessions；能前推的范围条件在检索前应用，其余候选过滤后继续取页，直到填满本页或达到 work budget；nextCursor 绑定 query、scope 与 generation | 中；新增显式依赖与授权复用，必须处理 stale cursor、空页和补页上限；不能直接裸调服务暴露更多结果 | 现有 API 可行性：高；实际集成：中；优先技术验证 |
| B：宿主扩展安全搜索 API | sessionController.search 公开 limit、scope、cursor 和 nextCursor，宿主在授权过滤之后定义 hasMore；摘要批量返回当前标题/目的与命中 seq，Fleet 保持薄工具 | 中到高；依赖上游，但多个 UI/插件可共同收益 | 中；架构首选 |
| C：可选检索 provider 保留原生回退 | 检索服务统一返回 sessionId、命中 seq、标题、scope、freshness 和 opaque cursor；Sessiongraph 等 provider 管召回，Fleet 管当前授权与投递 | 高于单修分页；需明确排序与 stale 结果，不默认合并多套排名 | 中；仅在确定使用第二检索源时采用 |

最小模型体验改进是添加可复用的当前标题/目的、命中位置与完整性标记，让“找错会话”的代价降低。current running 只表示当前运行状态，不能据此判定任务完成。不要为标题对每条命中执行一次完整 inspect，应复用已存在的摘要投影或批量服务。

## 缺点五：概览虽小，生成开销仍随历史规模增长

**证据与影响。** [宿主 inspect](/Users/sivan/workspace/deepseek-harness/packages/api/session-controller/src/index.ts:253) 返回完整事件前缀。[插件](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:398) 多次遍历事件，连只显示末尾输入的分支也先处理全部历史；[导出函数](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:271) 先构造所有行，再 join，并用 mkdirSync/writeFileSync 写盘。隔离进程中，10,000 条各含 500 字符的合成事件生成 5,408,890 字节，单次约 33.5 ms；50,000 条生成 27,088,890 字节，单次约 127.4 ms。两次概览约 1.3 KB。预先调度的 setImmediate 分别在约 38.5/135.2 ms 才运行，显示该执行路径阻塞事件循环。

这些是单次合成探针，未测冷读、zstd、真实会话形态、内存峰值或磁盘竞争，不能当作生产延迟、P95 或磁盘速度结论。

| 路径 | 技术方案与验收方式 | 代价与局限 | 置信度与建议 |
| --- | --- | --- | --- |
| A：概览与导出拆开，异步顺序写出 | 概览默认只返回有界信息与详情句柄；需要 grep 时才导出。对已拿到的 events 单次统计、逆向选择末尾消息，用异步 stream、backpressure 与分批 yield 写文件 | 低到中；消除不必要导出与主线程同步 I/O，但宿主仍可能一次加载完整 events，CPU 文本处理也需让出或卸载 | 高；近期首选，保留用户偏好的 grep 工作流 |
| B：投影与按 revision 缓存 | 将 counts、末尾输入/回复存入宿主 sessionProjections；使用可验证的 checkpoint 与增量事件推进；导出按 sessionId、revision/asOfSeq、exportVersion 缓存，限制数量与 TTL | 中；首次回填仍可能全量，冷 checkpoint 新鲜度需明确；缓存挂在插件 Context/服务上，不能用全局单例 | 中；反复 inspect 或大历史时采用 |
| C：宿主流式读取与后台导出 | 宿主提供固定 asOfSeq 的 AsyncIterable 事件/投影读取；按帧顺序解码，必要时把解码和文本处理放 worker；真正需要快速随机定位时再加 seq/frame offset 索引 | 高；涉及持久化/租约/取消语义；worker 的全量对象拷贝可能抵消收益 | 中；规模与冷读测量证明必要后采用 |

这里应纠正上一轮判断：异步 I/O、流式处理和随机访问是三件独立的事。插件现在确实使用同步 fs API，所以“fs 本来都是异步、插件不能优化”不成立；顺序流式解码压低内存也不必先改存储格式。当前分页 [history.page](/Users/sivan/workspace/deepseek-harness/packages/api/session-controller/src/history.ts:77) 先取得 source.events 再切片，单纯换一个分页方法不保证消除宿主全量读取。是否需要新格式或随机定位索引，需要测量后决定。

## 缺点六：转录是选择性文本投影，缺少内容与文件生命周期说明

**证据与影响。** [transcriptLine](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:256) 只导出 user/message、assistant/message 的 text 与 tool/call 参数，跳过 tool/result、图片和其他事件；“full transcript、one line per event”的文档描述不准确。隔离探针给定一条 tool/result，返回 eventCount=1、transcriptLines=0。文件用固定 sessionId 命名，后续 inspect 会覆盖同一路径；结果没有 asOfSeq、类型遗漏清单或过期时间；每个事件是一整行，单个巨大正文仍可能让 grep 返回巨大匹配行。当前代码没有回收导出文件的逻辑。0600 是新文件权限设置，目录权限、既有文件、同名路径与生命周期仍需单独处理。

| 路径 | 技术方案与验收方式 | 代价与局限 | 置信度与建议 |
| --- | --- | --- | --- |
| A：保留文件，做准确且受控的导出 | 返回 includedTypes/omittedTypes、asOfSeq、bytes、truncated；私有目录、唯一快照名、原子发布、TTL/容量清理；按 seq 和 chunk 分段长文本，默认仍精简，按需包含有界 tool/result | 低到中；需要定义可检索投影格式，但不增加完整原始会话读取 API | 高；近期首选 |
| B：使用宿主管理的详情资源 | 用宿主已有 spill/附件/可读资源服务承载导出、权限、回收与文件路径映射，Fleet 只返回资源身份和覆盖范围 | 中；先核实适用服务的生命周期和跨本地/远端可读性，不能假定任意宿主路径都可被 agent 读取 | 中；多个工具都需要文件导出时优先复用 |
| C：有界事件窗口读取 | 按 sessionId、seq、上下文窗口和 maxBytes 返回命中附近的事件，长结果返回分段资源；可替代“整段日志写文件后 grep” | 中到高；改变此前选定的文件工作流与读取接口取舍，默认不能重新开放完整 transcript dump；也不自动解决底层全量载入 | 技术可行性：中；当前产品适配：低；作为备选 |

默认省略工具结果与图片本身不是错误，错误在于没有明确披露覆盖范围或将其称作完整原日志。只有用户任务需要时才扩展导出内容。

## 缺点七：接受投递不等于完成，失败重试存在不确定性

**证据与影响。** [发送路径](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts:518) 先调用 followup/steer，再等待 flush。若 flush=false，工具报错，但消息可能已经进入或被目标读取。[现有测试](/Users/sivan/workspace/dsh-session-fleet-plugin/tests/session-fleet.spec.ts:356) 也明确断言该失败路径里目标日志已含 Fleet 消息。当前输出只有 accepted，没有 messageId、requestId、threadId、replyTo、目标接收 seq 或状态查询入口。自动回复并未由插件代码保证，接收者需要主动再发一条消息；说明文字不应让人误以为回复会自动关联回来。

| 路径 | 技术方案与验收方式 | 代价与局限 | 置信度与建议 |
| --- | --- | --- | --- |
| A：最小投递收据与诚实失败 | 返回创建消息的稳定 messageId、目标身份、已确认的接纳/持久化信息；在 flush 失败时报告“结果未知，可能已投递”并提供检查线索，不提示盲目重发 | 低到中；改善可诊断性但不承诺 exactly-once、处理完毕或自动回复 | 高；近期首选 |
| B：应用层线程和显式 ACK | 在现有队列消息来源/内容里增加 threadId、requestId、replyTo；可选 ackRequired，由接收侧在已有日志中记录并回传 ACK，重复请求按持久身份处理；限制自动往返次数 | 中；ACK 只证明声明的接收阶段，不证明业务完成；插件本地“先查再发”有并发竞态，不能冒充原子去重 | 中；确有多会话协作需求时加入 |
| C：宿主原子幂等接纳 | 宿主按 sender、target、requestId 原子接纳并保存去重收据，重启后可核对同一请求；通过日志/事件订阅报告 consumed、turn ended 或失败，继续复用原生队列 | 高；依赖宿主，目标执行外部副作用的 exactly-once 仍需业务自身保证 | 中；可靠协作的长期路径 |

[OpenClaw](https://docs.openclaw.ai/concepts/session-tool) 明确区分目标接纳与后续回复，并按同一输入身份核对重试；[Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) 的线程、ACK 与投递收据是相邻先例。保留不可信 peer 来源标记，它表明来源，不能单独保证模型绝不误解，也不能替代执行权限检查。

## 缺点八：兼容性承诺大于验证范围，文档有冲突

**证据与影响。** [支持声明](/Users/sivan/workspace/dsh-session-fleet-plugin/package.json:77) 覆盖 0.2.x，但构建依赖锁定单一 baseline；[质量 CI](/Users/sivan/workspace/dsh-session-fleet-plugin/.github/workflows/quality.yml:16) 使用单个 Node 22 作业，未展示多宿主组合。[行为测试](/Users/sivan/workspace/dsh-session-fleet-plugin/tests/session-fleet.spec.ts:58) 使用真实 Agent，但 sessionController 和 workspaceRegistry 是替身，后者固定为空；[bundle 测试](/Users/sivan/workspace/dsh-session-fleet-plugin/tests/bundle.spec.ts:9) 仅解析 patch，不是真实 Loader 启动验证。本轮 31 个测试全通过，仍未覆盖前述真实 workspace 组合。[英文说明](/Users/sivan/workspace/dsh-session-fleet-plugin/README.md:3) 与 [中文说明](/Users/sivan/workspace/dsh-session-fleet-plugin/README.zh.md:3) 都还称四个工具；英文已有 inspect 条目却同时写“no content read”，中文还缺 inspect。独立插件不直接继承 Harness packages 的全部测试制度，但这些缺口影响它自己的承诺可信度。

| 路径 | 技术方案与验收方式 | 代价与局限 | 置信度与建议 |
| --- | --- | --- | --- |
| A：缩小承诺，补一条真实组合 smoke | 标明已验证宿主版本与允许安装窗口的区别；用 Loader 加载实际 bundle 与测试 workspace，经过工具 executor 验证 create/queue/inspect/dispose；从工具元数据同步两份 README 的功能清单 | 低到中；覆盖一个真实组合，不等于验证全部 0.2.x | 高；近期首选 |
| B：兼容矩阵与输出快照 | 选择支持下界、当前版本与最新候选的真实组合，执行安装包 smoke、持久化/卸载/失败路径和工具 schema 快照；测首轮 prompt token，核对双语工具清单 | 中；CI 成本增加，矩阵选择与变更需维护 | 方法：高；各版本兼容结果待测；公开分发时采用 |
| C：收敛到宿主稳定能力入口 | 将易变的 Agent 恢复、peer enqueue、位置解析收敛到明确版本的宿主 service；插件在激活时校验所需能力并明确失败，保留有证据支持的兼容层 | 高；宿主尚未稳定时不能靠包版本区间推导语义兼容；不建议预造一层无使用者的抽象 | 中；多个插件共同需要时推动 |

文档修正至少包括五个工具、inspect 的读取与导出覆盖范围、跨 cwd 发送的精确含义、accepted 的保证、回复是否需要对端主动发送，以及已验证版本。品牌类型转换的绕过不应代替包实例与公共类型兼容验证。

## 推荐实施顺序与验收

1. **先修确定性问题。** 采用缺点一 A、缺点二 A、缺点八 A 中的文档与真实 workspace smoke。验收显式 cwd 只发送 cwd、省略 limit 也不超限、隐藏子会话数与目录过滤无关、双语功能清单一致。这一批不需要更换索引或重建队列。
2. **补齐发现与深读。** 缺点四先验证现有 query 服务分页能否在保持授权下复用；缺点五 A 与缺点六 A 配套，把概览和导出分开、详情覆盖范围和快照身份说清楚。用户既有 grep 取舍可以保留。
3. **再增强协作可靠性。** 先落缺点七 A，区分拒绝、已接纳、已确认持久化和结果未知；实际需要再加线程与 ACK。不要把 wait/whenIdle 等同于某条输入的完成回执，也不要默认引入自动多轮互答。
4. **中文检索作为独立决策。** 长期优先宿主 CJK 索引改进；若近期中文检索是硬需求，先做完整 Sessiongraph 服务适配验证。当前不恢复被否决的部分复制，不默认新增独立索引。

建议跟踪五个指标：找对目标的成功率与工具调用次数；有标注答案的中英混合查询 Recall@K；当前/冷会话 inspect 的 wall time、事件循环停顿和内存峰值；包含遗漏标记的实际输出字节/模型 token；同 requestId 在失败重试后产生的入站消息数。先建立基线再设门槛，本轮不凭空指定 SLO。

## 已完成验证与边界

- 运行现有 Vitest：两个测试文件、31 个测试通过，耗时约 0.88 秒。命令直接运行 Vitest，没有重新运行带联网兼容门禁的完整 pretest、build 或发布流程。
- 通过当前构建产物的工具 execute 与隔离替身验证显式 cwd + 调用者 workspace 冲突、默认列表超配置上限、隐藏计数误标。未在真实 Host 创建额外会话。
- 在内存 SQLite 中验证普通 FTS、trigram MATCH 与 LIKE 的中文短词差异；没有扫描或重建用户历史索引。
- 在单独 Node 进程运行两种规模的合成 inspect，确认概览字节大小、同步路径的调度延迟，以及 tool/result 的导出缺失；探针生成的自有转录文件已移除，未改动已有会话导出。
- 读取本地代码、当前 Host 的 Inspect 方法/类型，以及上述官方文档与 GitHub 一手资料。未安装竞品、发起会话消息、改插件代码、提交或推送；仅增加本文评估文件。

未验证：真实冷会话 profile、长时间并发、跨远端文件可读性、所有支持宿主版本、模型误投率、实际 prompt token 与缓存收益。关键风险是把历史索引新鲜度当作实时状态，或把 accepted/报错当作“已完成/绝未送达”；优化时需保留这两组区别。
