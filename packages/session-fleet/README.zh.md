---
description: "面向模型的会话发现、读取、创建与跨会话消息工具集。"
kind: "package"
---

# @deepseek-ai/dsh-experimental-session-fleet

[English](README.md) | 中文

## 概述

Session Fleet 为单个 Agent 提供五个作用域工具：`list_sessions` 与 `search_sessions` 在不激活目标的前提下发现可见会话，`read_session` 读取会话记录，`create_session` 创建新会话，`send_to_session` 向其他会话投递排队或steer的对等消息。投递消息携带专用的 `session-fleet` 来源标识与对等输入提示，目标会话不会把舰队输入误认为用户输入。

## 实现说明

<details>
<summary>维护者细节 — 点击展开</summary>

本包是函数插件（`name` / `inject` / `Config` / `apply`），通过 `agent/created` 逐 Agent 安装作用域工具，经 `agent/disposed` 与 effect disposer 回收。发现与读取走 `ctx.sessionController` 的 list、search、inspect，不会恢复目标 Agent。投递先经 `ctx.sessionController.resolveAgent` 解析目标，拒绝 subagent 会话；未开启 `allowCrossWorkspace` 时拒绝跨 workspace 目标；随后以 `source.kind: 'session-fleet'`（本包声明的 `MessageSourceMap` 扩展）调用 `agent.steer` 或 `agent.followup`，并在 `ctx.sessions.flush` 确认后才报告接受。投递复用 DSH 现有的会话消息队列，本包不持有队列状态。

本包不发布运行时 invariant 伴随物：“工具恰好随 Agent 作用域存活”这一关系只能透过注册表观察，且已由释放测试覆盖。

</details>

## 模型体验

<details>
<summary>模型看到什么 — 点击展开</summary>

### 工具

`list_sessions`、`search_sessions`、`read_session`、`create_session`、`send_to_session` 以 JSON 结果加入调用方 Agent 作用域；系统提示新增一段策略，说明发现能力、投递语义与不可信对等输入规则。

### Token 影响

五个工具 schema 与一段策略仅在安装了插件的作用域加载。记录读取截断到 `maxReadMessages` 行，列表截断到 `maxListRows` 行。

</details>

## 已知限制与延期工作

- 投递仅覆盖普通会话；subagent 子会话仍走 subagent 路由。
- 搜索依赖部署挂载 session-query provider；list 与 read 不依赖。
- 舰队消息以单条 user 角色回合落地；目标侧除来源标识外没有结构化信封。

## 开发备注

- 可选 bundle 位于 [session-fleet-bundle](../session-fleet-bundle/README.md)。
