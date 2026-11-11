# Session Fleet 执行结果

工作分支：improve-session-fleet。实施基点：d74ead6。最终代码验收提交：4c5096f。持续目标：goal-21640920-7202-4718-a56b-f8087f5dbf10。实现继续留在独立仓库，未修改 Harness 源码。

## 任务结果

| 顺序 | 结果 | 验收依据 |
| --- | --- | --- |
| 创建与列表缺陷 | 完成。显式 cwd 不再继承 workspace；默认列表数量遵守配置；隐藏计数只统计子会话；数字配置校验正安全整数 | 回归用例先在旧代码失败，再通过；真实 Loader/workspace 创建验证 |
| 发现与搜索 | 完成。列表快照游标、宿主授权 ID 集合前置过滤、有界已返回 ID 续页、目录与时间范围、命中 seq 和已有标题提示 | 真实 SQLite provider 续页、实际模型连续调用无重复/遗漏，子会话过滤、请求绑定与授权重查验证 |
| 按需转录 | 完成。概览默认不写文件；单次统计与有界预览；显式异步分块导出；快照位置、类型覆盖、字节与截断状态；TTL、容量与卸载回收 | 私有文件、多字节、完整行字节上限、过期、容量、取消和卸载验证 |
| 投递收据 | 完成。消息 ID、已接纳状态、持久化 acknowledged/unknown、不可安全盲重试；入队异常也标明消息 ID 和未知结果 | 正常 queue/steer、flush=false、flush 异常、已入队后抛错验证 |
| 中文检索复用核查 | 核查与适配决定完成，未实现中文两字召回修复。保留宿主检索，将完整服务接入条件记录到双语说明 | 查阅 Sessiongraph 0.3.3 公共接口，列完当前 242 个插件条目及 Inspect 目录；未发现其已挂载服务 |

实现入口：[工具与配置](/Users/sivan/workspace/dsh-session-fleet-plugin/src/index.ts)、[列表游标](/Users/sivan/workspace/dsh-session-fleet-plugin/src/discovery.ts)、[转录生命周期](/Users/sivan/workspace/dsh-session-fleet-plugin/src/transcript.ts)。使用说明：[English](/Users/sivan/workspace/dsh-session-fleet-plugin/README.md)、[中文](/Users/sivan/workspace/dsh-session-fleet-plugin/README.zh.md)。

额外修复了真实组合验证发现的问题：Fleet 的提示框会占满最近输入的 200 字符预览。概览现在显示实际正文并保留 source、senderSessionId、messageId；原始提示框仍保留在日志与导出中。工具说明明确声明对等输入，插件管理器两种语言的旧“四个工具”描述也已校正。

## 行为变化与使用

默认 inspect 不再生成文件。需要 grep 时显式传入 transcript: true。默认导出最多 8 MiB、保留 20 份、TTL 一小时、每块 1024 个 UTF-16 代码单元。这些值可通过插件 Config 调整。TSV 列为 seq、ISO 时间、角色、来源、分块号、消息 ID、转义文本，工具调用的消息 ID 列为空。

accepted 仅表示目标接纳，不代表完成；persistence=unknown 不代表消息未送达。重试前在概览或显式导出中按 messageId 核对。每次调用生成新消息，尚无幂等接纳、自动 ACK 或完成回执。向子会话投递仍无条件拒绝。

## 实际模型分页修正

最初直接复用宿主原生搜索游标的建议被实际 AgentLoop 验证否定：provider 将整个会话事件日志纳入全局代际，调用者自己的工具日志就能使下一页失效。原来的组合测试直接执行工具，未覆盖这一层。现已补上模型连续调用的回归，用每页重新查询并排除已返回会话 ID 的有界状态替代原生游标。状态只记 ID 与请求指纹，每页重新检查宿主授权，不缓存消息或授权决定。

搜索现在明确采用动态遍历，不冻结整个语料代际，可能看到新匹配，但不会重复返回同一会话。默认保留 100 个句柄、有效 300 秒，单次遍历最多记住 10000 个已返回会话 ID。过期项在请求时清理，卸载时全部释放；达到匹配上限需缩小目录或时间范围。

## 中文检索决定

[Sessiongraph 0.3.3 的服务类型](https://github.com/CC19990113/dsh-plugin-sessiongraph/blob/main/packages/service/src/types.ts) 已支持中文 bigram、时间和条目类型过滤。它的 search 接受单个 sessionId、limit/offset，没有授权 ID 集合输入或显式的当前消息视图过滤。完整接入需要明确历史/当前语义、限制授权过滤的扫描工作量，以及处理索引版本和新鲜度。当前 profile 没有可供实测调用的已挂载服务，因此本轮不宣称完成运行时集成。

本轮没有部分复制索引，没有另建数据库、扫描用户历史正文或重建用户索引。当前 Fleet 的中文两字子串召回仍受宿主 provider 限制。长期首选宿主 CJK 索引改进，近期若接入 Sessiongraph，应作为明确的历史检索能力复用完整服务。

## 验证证据

最终本地运行环境为 Node.js v24.21.0，宿主开发依赖基线 0.2.1-rc.2。允许安装窗口仍为 >=0.2.0-rc.2 <0.3.0-0；该范围不等于逐版本实测。未运行远程 CI，也未声称当前 GUI 或所有 Node 22 构建已经验证。

- 59 个测试、五个测试文件通过，包含实际 YAML Loader、workspace registry、Session Controller、JSON 存储和 SQLite 检索。模型与未使用的图片/GUI 传输为替身。
- check:refactor 通过：支持窗口检查、TypeScript、lint、Prettier。最终无 warning/error。
- build 通过：JS bundle 与声明文件输出完整。
- pnpm pack 完整生命周期通过，产物包含运行入口、三个声明文件、双语说明、locale、图标、许可证与 bundle patch。临时包只用于本地验证，没有发布。

## 测量与边界

同为 50,000 条、每条 500 字符的合成事件，默认概览单次约 6.2 ms、1353 字节 输出且不写文件；显式导出在测试配置的 1 MiB 上限停止，约 49.2 ms，预先调度的事件循环回调约 5.4 ms 得到执行。旧实现对应探针曾同步生成约 27 MB，单次约 127.4 ms。导出输出量不同，不能把 127.4/49.2 当作等量吞吐加速比。

Fleet 的工具 schema JSON 从 2220 增至 3286 个 UTF-8 字节，静态策略从 1121 降至 739 字节，合计增加 684 字节。工具仍为五个，新增成本来自分页、范围和按需详情参数。这里只测插件贡献的 schema 与策略字节，不是实际模型 tokenizer 或整轮 prompt token；没有声称 token 总数下降或测得 KV-cache 命中收益。

探针不含冷会话解码、真实并发和内存峰值，宿主完整事件读取仍存在。文件路径针对本地可读文件环境，跨远端读取仍需额外验证。改变运行中的 profile、发布版本和推送远端均未执行。
