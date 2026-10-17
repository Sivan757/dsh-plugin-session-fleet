# dsh-plugin-session-fleet

Session Fleet: four model-facing tools that let one DeepSeek Harness agent discover other sessions, start a session, and message a session directly.

English | [中文](README.zh.md)

## Install

```sh
dsh plugin --profile <profile> add dsh-plugin-session-fleet
```

The bundle patch is opt-in: it inserts the `tool-session-fleet` row with conservative defaults. Enable **Session fleet** in the Plugins page after install.

## Tools installed per agent

- `list_sessions` lists visible sessions with status, activity, and working directory, and starts none of them.
- `search_sessions` runs a literal full-text search across visible session messages.
- `create_session` creates a session in a given cwd or workspace.
- `send_to_session` delivers a queued or steered message to another session through the DSH session message queue.

A delivery carries the dedicated `session-fleet` message source and a peer-agent framing note, so a target never mistakes fleet input for user input. Replies travel back through the same channel.

## Compatibility

The plugin declares the host support window `>=0.2.0-rc.2 <0.3.0-0`. Every 0.2.x host release, candidates included, satisfies it; a 0.3 release needs a new plugin release. `pnpm run check:host-support` fails when a pin leaves the window or when the host `next` channel moves past it.

`@deepseek-ai/dsh-brand` never appears as a dependency. Its brand marker is a `unique symbol`, so a second physical copy would break every branded identifier type in this plugin.

## Configuration

| Key                   | Default | Meaning                                                                             |
| --------------------- | ------- | ----------------------------------------------------------------------------------- |
| `allowCrossWorkspace` | `false` | Permit a tool call to reach a session recorded under a different working directory. |
| `maxListRows`         | `50`    | Upper bound of one `list_sessions` response.                                        |
| `maxMessageChars`     | `20000` | Upper bound of one `send_to_session` body.                                          |
| `includeSubagents`    | `false` | Show subagent-owned sessions in list and search. Delivery to them stays refused.    |

## Safety model

- Delivery reaches ordinary top-level sessions only. Subagent children remain the parent agent's internal delegation, and delivery to them is refused unconditionally, whether or not `includeSubagents` is set.
- Cross-workspace delivery is refused unless `allowCrossWorkspace` is true on the plugin row.
- Fleet provides no content read. An agent asks a peer for context through `send_to_session`, or a profile enables the harness session query tools for audit access.
- An inbound fleet message is untrusted peer input. The framing note tells the receiving agent to confirm consequential actions with the user first.

## Development

```sh
pnpm install
pnpm run check:refactor   # host support window, typecheck, lint, prettier
pnpm run test             # vitest run
pnpm run build            # declarations plus the bundled entry
```

Requires Node.js 22 or later.
