# dsh-plugin-session-fleet

让 DeepSeek Harness 的一个智能体发现、读取、创建其他 DSH 会话并直接向它们发消息的模型工具插件。

[English](README.md) | 中文

## 包结构

- packages/session-fleet：Cordis 函数插件。每个智能体五个作用域工具：list_sessions、search_sessions、read_session、create_session、send_to_session。
- packages/session-fleet-bundle：可选 profile bundle，以保守默认值插入插件行。

## 安装

在 Web 侧边栏的插件页安装以下任一来源：

- 本仓库：github:sivanzheng/dsh-session-fleet-plugin
- 本地检出：本目录的绝对路径

然后启用 Session fleet。存活的根智能体随即获得五个工具。投递复用 DSH 的会话消息队列（排队回合走 followup，运行中回合走 steer），并携带专用的 session-fleet 消息来源，目标会话不会把舰队输入误认为用户输入。

## 安全模型

- 投递仅面向普通会话。subagent 子会话仍走 subagent 路由。
- 未设置 allowCrossWorkspace 为 true 时拒绝跨 workspace 投递。
- 投递以“对等智能体输入”落地并带显式来源说明，绝不冒充用户输入。

## 开发

    pnpm install
    pnpm --filter dsh-plugin-session-fleet test
    pnpm --filter dsh-plugin-session-fleet build

需要 Node 22.19+ 或 24+。工具包基于已发布的 DeepSeek Harness 包构建；保持 peerDependencies 范围与目标安装一致。
