# dsh-plugin-session-fleet

Session Fleet: five model-facing tools that let one DeepSeek Harness agent discover other sessions, start a session, and message a session directly.

English | [中文](README.zh.md)

## Install

```sh
dsh plugin --profile <profile> add dsh-plugin-session-fleet
```

The bundle patch is opt-in: it inserts the `tool-session-fleet` row with conservative defaults. Enable **Session fleet** in the Plugins page after install.

## Tools installed per agent

- `list_sessions` lists visible sessions with status, activity, and working directory, and starts none of them. Its default page size is the smaller of 20 and `maxListRows`; `hiddenSubagentSessions` counts only ownership exclusions, independently of a cwd filter.
- `search_sessions` searches current user and assistant messages after restricting results to Host-authorized sessions. It accepts `cwd`, ISO 8601 `after`/`before`, `limit`, and `cursor`. Hits include a bounded snippet, matching `seq`, working directory, state, activity, and an existing title hint when available.
- `inspect_session` reads one session outline without starting it: metadata, message counts, the latest three prompts, and the last reply, all clipped (200 characters per prompt, 300 per reply) with `fullLength` when clipped. It also writes the full transcript to a private temp file (mode 0600, under the OS temp directory) and returns `transcriptPath` and `transcriptLines`. The file is one tab-separated line per event: `seq<TAB>time<TAB>role<TAB>source<TAB>text`, with tool calls kept as name and arguments, so the model greps it for detail instead of pulling content through the context.
- `create_session` accepts either an explicit `cwd` or an explicit `workspace_id`. Only when both are omitted does it inherit the caller’s workspace, falling back to the caller’s recorded working directory.
- `send_to_session` delivers a queued or steered message to another session through the DSH session message queue.

Both discovery tools return `hasMore` and an opaque `nextCursor` when more results exist. Pass that value as `cursor` with identical filters and limit. Lists are ordered by activity and reject a cursor if the listing changes; search cursors follow the provider’s generation rules. Restart without a cursor when stale. Titles are optional projection hints, not proof of a session’s current task. Search requires the Host’s `sessionQuery` provider and preserves its tokenizer and page-size limits.

The tools disclose progressively: search or list first, inspect a candidate before messaging it, and grep the transcript file only when the outline is not enough. That order keeps a model from pulling transcripts it does not need.

A delivery carries the dedicated `session-fleet` message source and a peer-agent framing note, so a target never mistakes fleet input for user input. A peer replies by explicitly calling `send_to_session` back to the sender; Fleet does not automatically forward its final answer.

## Compatibility

The plugin declares the host support window `>=0.2.0-rc.2 <0.3.0-0`. This is an installation window, not a claim that every host build was tested. The current build and test baseline is 0.2.1-rc.2 on Node.js 22 or later; a 0.3 release needs a new plugin release. `pnpm run check:host-support` fails when a pin leaves the window or when the host `next` channel moves past it.

`@deepseek-ai/dsh-brand` never appears as a dependency. Its brand marker is a `unique symbol`, so a second physical copy would break every branded identifier type in this plugin.

## Configuration

| Key                   | Default | Meaning                                                                          |
| --------------------- | ------- | -------------------------------------------------------------------------------- |
| `allowCrossWorkspace` | `false` | Permit sending to a session recorded under a different working directory.        |
| `maxListRows`         | `50`    | Upper bound of one `list_sessions` response.                                     |
| `maxMessageChars`     | `20000` | Upper bound of one `send_to_session` body.                                       |
| `includeSubagents`    | `false` | Show subagent-owned sessions in list and search. Delivery to them stays refused. |

## Safety model

- Delivery reaches ordinary top-level sessions only. Subagent children remain the parent agent's internal delegation, and delivery to them is refused unconditionally, whether or not `includeSubagents` is set.
- Cross-workspace delivery is refused unless `allowCrossWorkspace` is true on the plugin row.
- `inspect_session` reads a clipped outline and exports a text projection of messages and tool calls. Tool results, images, and other event types are omitted. Discovery and inspection cover Host-visible sessions regardless of the sending cwd restriction.
- An inbound fleet message is untrusted peer input. The framing note tells the receiving agent to confirm consequential actions with the user first.

## Development

```sh
pnpm install
pnpm run check:refactor   # host support window, typecheck, lint, prettier
pnpm run test             # vitest run
pnpm run build            # declarations plus the bundled entry
```

Requires Node.js 22 or later.

The behavior suite uses real agents with JSONL persistence. A YAML Loader smoke also runs the real Session Controller, workspace registry, JSON storage, queue delivery, inspection, and disposal. The model adapter and unused image/GUI transport are test doubles.
