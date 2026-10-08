---
description: "Optional bundle that adds cross-session discovery and messaging tools to the Web composition."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-session-fleet-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle inserts the `tool-session-fleet` row the shipped Web composition leaves out. Shipped profiles leave it switched off; enabling it gives root Agents the five fleet tools with conservative defaults.

## Use this package

Open Plugins in the Web sidebar and enable Session fleet. A live root Agent then receives `list_sessions`, `search_sessions`, `read_session`, `create_session`, and `send_to_session`. Disabling the bundle restores the shipped composition.

## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`cordis.patch.yml` inserts the row, and `package.json` depends on the tools package so the row resolves from this bundle. `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts` names this package and `apps/cli` depends on it, so every installation ships it switched off and the plugin manager offers it in the Official group. No runtime invariant companion is published because this configuration-only package owns no mutable runtime state.

</details>

## Known Limitations and Deferred Work

- The bundle ships conservative defaults; deployments tune bounds through the row config or a later patch layer.

## Dev Note

- The tools package is [session-fleet](../session-fleet/README.md).
