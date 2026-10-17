# dsh-plugin-session-fleet

Session Fleet：四个面向模型的工具，让一个 DeepSeek Harness 智能体发现其他会话、创建会话，并直接向某个会话发消息。

[English](README.md) | 中文

## 安装

```sh
dsh plugin --profile <profile> add dsh-plugin-session-fleet
```

bundle patch 是可选开启的：它插入一行 `tool-session-fleet`，使用保守默认值。安装后在插件页启用「会话舰队」。

## 每个智能体安装的工具

- `list_sessions`：列出可见会话及状态、活跃时间与工作目录，不会激活任何目标。
- `search_sessions`：跨可见会话消息的字面量全文搜索。
- `create_session`：在指定 cwd 或 workspace 创建会话。
- `send_to_session`：通过 DSH 会话消息队列向其他会话投递排队或 steer 消息。

投递消息携带专用的 `session-fleet` 来源标识与对等输入提示，目标会话不会把舰队输入误认为用户输入。回复经由同一通道返回。

## 兼容范围

插件声明宿主支持窗口 `>=0.2.0-rc.2 <0.3.0-0`。0.2.x 的每个宿主版本（含候选版）都满足该范围；宿主发布 0.3 时需要新的插件版本。任何一个 pin 离开窗口，或宿主 `next` 通道越过上界，`pnpm run check:host-support` 都会失败。

`@deepseek-ai/dsh-brand` 绝不作为 dependency 出现。它的 brand 标记是 `unique symbol`，第二份物理副本会让本插件所有带 brand 的标识符类型失效。

## 配置

| 键                    | 默认    | 含义                                                   |
| --------------------- | ------- | ------------------------------------------------------ |
| `allowCrossWorkspace` | `false` | 允许工具调用触达记录在不同工作目录下的会话。           |
| `maxListRows`         | `50`    | 单次 `list_sessions` 响应的上限。                      |
| `maxMessageChars`     | `20000` | 单条 `send_to_session` 正文的上限。                    |
| `includeSubagents`    | `false` | 在列表与搜索中显示子智能体会话。向它们的投递仍被拒绝。 |

## 安全模型

- 投递只到达普通顶层会话。子智能体属于父智能体的内部委派，无论 `includeSubagents` 是否开启，向其投递都被无条件拒绝。
- 除非插件行的 `allowCrossWorkspace` 为 true，跨工作目录投递一律拒绝。
- 舰队不提供正文读取。智能体通过 `send_to_session` 向对等会话索要上下文，或由 profile 开启宿主的会话检索工具用于审计。
- 入站的舰队消息是不可信的对等输入。提示语要求接收方在执行有后果的操作前先与用户确认。

## 开发

```sh
pnpm install
pnpm run check:refactor   # 宿主支持窗口、类型检查、lint、prettier
pnpm run test             # vitest run
pnpm run build            # 类型声明与打包入口
```

需要 Node.js 22 或更高版本。
