# dsh-plugin-session-fleet

Session Fleet：一个 DeepSeek Harness 插件，通过五个面向模型的工具，让一个智能体发现、读取、创建其他 DSH 会话并直接向它们发消息。

[English](README.md) | 中文

## 每个智能体安装的工具

- list_sessions：列出可见会话及状态、活跃时间与工作目录，不激活任何目标。
- search_sessions：跨可见会话消息的字面量全文搜索。
- read_session：读取目标会话记录，最新消息在后。
- create_session：在指定 cwd 或 workspace 创建会话。
- send_to_session：通过 DSH 会话消息队列向其他会话投递排队或 steer 消息。

投递消息携带专用的 session-fleet 来源标识与对等输入提示，目标会话不会把舰队输入误认为用户输入。

## 安装

在 Web 侧边栏的插件页安装以下任一来源：

- 本地检出：本目录的绝对路径
- 推送仓库后：github:USER/dsh-plugin-session-fleet

然后启用 Session fleet。

## 安全模型

- 投递仅面向普通会话；subagent 子会话仍走 subagent 路由。
- 未设置 allowCrossWorkspace 为 true 时拒绝跨 workspace 投递。
- 列表与读取上限（maxListRows、maxReadMessages、maxMessageChars）出厂为保守默认。

## 开发

    pnpm install
    pnpm test
    pnpm build
    pnpm lint
    pnpm typecheck

需要 Node 22.19+ 或 24+。peer 依赖固定 DeepSeek Harness 0.2.0-rc.2 系列包；保持与目标安装一致。开发期可用 pnpm overrides 把 peer 包指向 harness 检出目录。
