---
description: "把跨会话发现与消息工具加入 Web 组合的可选 bundle。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-session-fleet-bundle

[English](README.md) | 中文

## 概述

这个可选 bundle 插入正式 Web 组合未携带的 `tool-session-fleet` 行。默认关闭；启用后根 Agent 获得五个舰队工具，并使用保守默认值。

## 使用

在 Web 侧边栏打开插件页并启用 Session fleet。存活的根 Agent 随即获得 `list_sessions`、`search_sessions`、`read_session`、`create_session`、`send_to_session`。关闭 bundle 即恢复原组合。

## 实现说明

<details>
<summary>维护者细节 — 点击展开</summary>

`cordis.patch.yml` 负责插入该行，`package.json` 依赖工具包使该行可从本 bundle 解析。`packages/boot/app-boot/src/profile.ts` 的 `OPTIONAL_BUNDLES` 登记本包，`apps/cli` 依赖它，因此每个安装默认携带但关闭，插件管理器在 Official 组中提供开关。本包为纯配置包，无可变运行时状态，不发布 invariant 伴随物。

</details>

## 已知限制与延期工作

- bundle 出厂为保守默认；部署可通过该行 config 或后续 patch 层调整上限。

## 开发备注

- 工具包位于 [session-fleet](../session-fleet/README.md)。
