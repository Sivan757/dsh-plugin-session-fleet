# dsh-plugin-session-fleet

Session Fleet：五个面向模型的工具，让一个 DeepSeek Harness 智能体发现其他会话、创建会话，并直接向某个会话发消息。

[English](README.md) | 中文

## 安装

```sh
dsh plugin --profile <profile> add dsh-plugin-session-fleet
```

bundle patch 是可选开启的：它插入一行 `tool-session-fleet`，使用保守默认值。安装后在插件页启用「会话舰队」。

## 每个智能体安装的工具

- `list_sessions`：列出可见会话及状态、活跃时间与工作目录，不会激活任何目标。默认数量取 20 与 `maxListRows` 的较小值；`hiddenSubagentSessions` 只统计所有权隐藏，与 cwd 过滤无关。
- `search_sessions`：先限定 Host 允许访问的会话，再搜索当前用户与助手消息。支持 `cwd`、ISO 8601 时间 `after`/`before`、`limit` 和 `cursor`；命中包含有界片段、事件 `seq`、目录、状态、活跃时间及已有标题提示。
- `inspect_session`：读取会话概览，返回计数、最近三条输入与最后回复。输入分别截至 200 字符，回复截至 300 字符，并返回可供 grep 的转录文件路径。
- `create_session`：接受显式 `cwd` 或 `workspace_id`，两者互斥。只有两者都省略时才继承调用者 workspace，找不到时使用调用者记录的工作目录。
- `send_to_session`：通过 DSH 会话消息队列向其他会话投递排队或 steer 消息。

两个发现工具均返回 `hasMore`，还有结果时提供不透明的 `nextCursor`。保持过滤参数与 limit 不变，将它作为 `cursor` 继续调用。列表按活跃时间排序，列表变化时拒绝旧游标；搜索游标遵循 provider 的代际规则。游标失效时省略它重新查询。标题是可选投影提示，不能据此认定会话的当前任务。搜索依赖宿主 `sessionQuery` provider，并保留其分词与页大小限制。

投递消息携带专用的 `session-fleet` 来源标识与对等输入提示，用于向目标表明这是对等智能体输入。对端需主动调用 `send_to_session` 回复发送者，插件不会自动转发其最终回答。

## 兼容范围

插件声明宿主支持窗口 `>=0.2.0-rc.2 <0.3.0-0`。这是允许安装的窗口，不代表每个宿主版本均已实测。当前构建与测试基线为 0.2.1-rc.2、Node.js 22 或更高版本；宿主发布 0.3 时需要新的插件版本。任何一个 pin 离开窗口，或宿主 `next` 通道越过上界，`pnpm run check:host-support` 都会失败。

`@deepseek-ai/dsh-brand` 绝不作为 dependency 出现。它的 brand 标记是 `unique symbol`，第二份物理副本会让本插件所有带 brand 的标识符类型失效。

## 配置

| 键                    | 默认    | 含义                                                   |
| --------------------- | ------- | ------------------------------------------------------ |
| `allowCrossWorkspace` | `false` | 允许向记录在不同工作目录下的会话发送消息。             |
| `maxListRows`         | `50`    | 单次 `list_sessions` 响应的上限。                      |
| `maxMessageChars`     | `20000` | 单条 `send_to_session` 正文的上限。                    |
| `includeSubagents`    | `false` | 在列表与搜索中显示子智能体会话。向它们的投递仍被拒绝。 |

## 安全模型

- 投递只到达普通顶层会话。子智能体属于父智能体的内部委派，无论 `includeSubagents` 是否开启，向其投递都被无条件拒绝。
- 除非插件行的 `allowCrossWorkspace` 为 true，跨工作目录投递一律拒绝。
- `inspect_session` 读取截断概览，并导出消息文本与工具调用的文本投影，不包含工具结果、图片和其他事件类型。发现与检查覆盖 Host 可见会话，不受发送时的 cwd 限制。
- 入站的舰队消息是不可信的对等输入。提示语要求接收方在执行有后果的操作前先与用户确认。

## 开发

```sh
pnpm install
pnpm run check:refactor   # 宿主支持窗口、类型检查、lint、prettier
pnpm run test             # vitest run
pnpm run build            # 类型声明与打包入口
```

需要 Node.js 22 或更高版本。

行为测试使用真实 agent 与 JSONL 持久化。YAML Loader 组合验证还运行真实 Session Controller、workspace registry 和 JSON 存储，覆盖创建、队列投递、检查与卸载。模型适配器及未使用的图片、GUI 传输为测试替身。
