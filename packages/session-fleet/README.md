---
description: "Scoped model-facing tools for discovering, reading, creating, and messaging DSH sessions."
kind: "package"
---

# @deepseek-ai/dsh-experimental-session-fleet

English | [中文](README.zh.md)

## Summary

Session Fleet gives one Agent five scoped tools over the Host Session surface: `list_sessions` and `search_sessions` discover visible sessions without activating them, `read_session` reads a transcript, `create_session` starts a session, and `send_to_session` delivers a queued or steered peer message. Deliveries carry the dedicated `session-fleet` message source and a peer-agent framing reminder, so a target never mistakes fleet input for user input.

## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The plugin is a function plugin (`name` / `inject` / `Config` / `apply`) that installs per-Agent scoped tools through `agent/created` and unwinds through `agent/disposed` and its effect disposer. Discovery and reading call `ctx.sessionController` list, search, and inspect, so no target Agent resumes. Delivery resolves the target through `ctx.sessionController.resolveAgent`, rejects subagent-owned targets and cross-workspace targets unless `allowCrossWorkspace` is on, then appends through `agent.steer` or `agent.followup` with `source.kind: 'session-fleet'` declared by this package's `MessageSourceMap` augmentation, and awaits `ctx.sessions.flush` before reporting acceptance. Delivery reuses DSH's existing session message queue; this package owns no queue state.

No runtime invariant companion is published: the owned relation (tools present exactly while the Agent scope lives) is observable only through the registry itself and is covered by the disposal test.

</details>

## Model Experience

<details>
<summary>What the model sees — click to expand</summary>

### Tools

`list_sessions`, `search_sessions`, `read_session`, `create_session`, and `send_to_session` join the calling Agent's scope with JSON results. The prompt gains one policy section describing discovery, delivery semantics, and the untrusted-peer-input rule.

### Token effect

Five schemas and one policy section load only in scopes where the plugin installed. Transcripts truncate to `maxReadMessages` rows, lists to `maxListRows` rows.

</details>

## Known Limitations and Deferred Work

- Delivery covers ordinary sessions only; subagent children stay on subagent routing.
- Search requires the deployment to mount a session-query provider; list and read work without one.
- Fleet messages land as one user-role turn; the target sees no structured fleet envelope beyond the source note.

## Dev Note

- The optional bundle lives in [session-fleet-bundle](../session-fleet-bundle/README.md).
