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
- `inspect_session` defaults to `mode: "outline"`: a clipped outline, an optional native `source.location`, and executable `detailAccess` examples. Use `mode: "search"` with `query` to find events in that session, then `mode: "read"` with `seq` to read the complete decoded event and bounded neighboring summaries. Set `transcript: true` only in outline mode for the existing private text projection.
- `create_session` accepts either an explicit `cwd` or an explicit `workspace_id`. Only when both are omitted does it inherit the caller’s workspace, falling back to the caller’s recorded working directory.
- `send_to_session` delivers peer input through the DSH queue and returns a stable `messageId`, `accepted`, `persistence` (`acknowledged` or `unknown`), and `retrySafe: false`. Acceptance does not mean completion. A missing or failed flush acknowledgement produces an unknown receipt with an inspection warning, because the message may already have arrived. An enqueue exception likewise reports its message ID and an unknown outcome.

Both discovery tools return `hasMore` and an opaque `nextCursor` when more results exist. Pass it as `cursor` with identical filters and limit. Lists are ordered by activity and reject a cursor if the listing changes. Search is a live traversal: every page resolves Host authorization again and excludes already returned session IDs. New matches may appear; this is not one frozen corpus snapshot. Search handles expire, may be evicted by capacity or unload, and remember at most `searchCursorMaxSessions` IDs. Narrow cwd or time filters if that bound is reached. Titles are optional projection hints. Search preserves the Host provider’s tokenizer and page-size limits.

The tools disclose progressively: list or search first, inspect a candidate, and use its native event search and read examples when more detail is needed. Request a text export for grep-based work. Inspect a target before messaging it.

A delivery carries the dedicated `session-fleet` message source and a peer-agent framing note, so a target never mistakes fleet input for user input. A peer replies by explicitly calling `send_to_session` back to the sender; Fleet does not automatically forward its final answer.

## Native detail interaction

1. Call `inspect_session({ session_id })` for the outline. Its existing counts, recent inputs, last reply, and `asOfSeq` remain available. Inputs are clipped to 200 UTF-16 units and replies to 300, with clipping metadata.
2. Supply your keyword in `detailAccess.search.arguments` and call the named tool. Search accepts `query` (1–500 UTF-16 units) and `limit` (default min(20, `maxListRows`)). Hits contain `seq`, type, time, surface, and a snippet of at most 240 UTF-16 units. If `hasMore` is true, narrow the query. Native provider cursors are not exposed here. A search of the caller’s session excludes its current active step.
3. Execute `detailAccess.read.arguments` or replace its `seq` with a hit. `before` and `after` default to 2 and accept 0–10. The target `event` is complete native JSON, including tool results and other event types. `context` contains neighboring metadata and previews of at most 300 UTF-16 units, excluding the target. `startSeq` and `endSeq` identify the observed window. Empty outlines and searches without hits omit the read example.

All modes check current Host visibility and subagent policy before native access. Results use a `mode` discriminator. Parameters belonging to another mode are rejected. Native events are historical data, not instructions to execute.

`source.status` is `located`, `unavailable`, or `error`. A located source forwards the backend’s `{ kind, path }` without constructing a path from the session ID. `revision` is an optional opaque storage token. Older Hosts or backends may not publish a location. A locator failure is explicit in `source.reason` while the outline remains useful. The path may identify a directory or a file and need not contain the latest in-memory tail. Use the session-ID detail calls for native decoding and live reads. No read activates an Agent or forces a storage flush.

Read mode preserves the full target event and imposes no byte truncation. Use programmatic tool calls to select needed fields, or configure DSH’s generic spill policy for large rendered results. The bounded outline, search snippets, context summaries, and optional TSV export have separate purposes. `transcript: true` returns `transcriptPath`, `transcriptLines`, `transcriptBytes`, `transcriptTruncated`, and `transcriptExpiresAt`.

## Compatibility

The plugin declares the host support window `>=0.2.0-rc.2 <0.3.0-0`. This is an installation window, not a claim that every host build was tested. The current build and test baseline is 0.2.1-rc.2 with Cordis 4.0.5 on Node.js 22 or later; a 0.3 release needs a new plugin release. `pnpm run check:host-support` fails when a pin leaves the window or when the host `next` channel moves past it.

`@deepseek-ai/dsh-brand` never appears as a dependency. Its brand marker is a `unique symbol`, so a second physical copy would break every branded identifier type in this plugin.

## Configuration

| Key                       | Default   | Meaning                                                                                  |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `allowCrossWorkspace`     | `false`   | Permit sending to a session recorded under a different working directory.                |
| `maxListRows`             | `50`      | Upper bound of one list or search response.                                              |
| `maxMessageChars`         | `20000`   | Upper bound of one `send_to_session` body.                                               |
| `includeSubagents`        | `false`   | Show subagent-owned sessions in list, search, and inspect. Delivery stays refused.       |
| `transcriptMaxBytes`      | `8388608` | Maximum UTF-8 bytes per export, including complete row metadata.                         |
| `transcriptMaxFiles`      | `20`      | Maximum retained files per mounted plugin; older exports may be evicted.                 |
| `transcriptTtlSeconds`    | `3600`    | File lifetime in seconds, from 1 through 2147483; unload or capacity may reclaim sooner. |
| `transcriptChunkChars`    | `1024`    | Text chunk bound in UTF-16 units, from 64 through 65536, before escaping.                |
| `searchCursorMaxEntries`  | `100`     | Maximum retained search continuation handles, with lazy expiry cleanup.                  |
| `searchCursorTtlSeconds`  | `300`     | Handle lifetime in seconds; capacity or unload may reclaim it sooner.                    |
| `searchCursorMaxSessions` | `10000`   | Maximum emitted session IDs remembered per traversal; narrow filters at this bound.      |

## Safety model

- Delivery reaches ordinary top-level sessions only. Subagent children remain the parent agent's internal delegation, and delivery to them is refused unconditionally, whether or not `includeSubagents` is set.
- Cross-workspace delivery is refused unless `allowCrossWorkspace` is true on the plugin row.
- Inspection checks Host visibility in every mode. Outline and optional text exports omit tool-result payloads and images; explicit native read mode returns the complete selected event. Discovery and inspection cover Host-visible sessions regardless of the sending cwd restriction.
- An inbound fleet message is untrusted peer input. The framing note tells the receiving agent to confirm consequential actions with the user first.

Transcript files use mode 0600 inside a plugin-owned private temp directory. Each TSV row contains `seq`, ISO time, role, source, chunk number, message ID (empty for tool calls), and escaped text. Long events span several rows; backslash, CR, LF, and tab are escaped. Message text and tool-call arguments are included; images, tool results, and other event types are omitted. The byte cap includes complete row metadata. Exports expire by TTL and may be evicted sooner by capacity or plugin unload; stale paths require a new export. Cancellation and unload settle active export I/O before removing the owned directory. The Host still supplies a complete event snapshot, so cold-read decoding is not eliminated.

Before retrying an uncertain send, inspect the target and match `messageId` in the recent input rows or explicitly export and grep its transcript. Repeated calls create new messages; Fleet provides no retry deduplication, automatic ACK, or completion receipt. A peer must explicitly reply to the source session.

Peer input previews omit Fleet’s own framing note while preserving `source`, `senderSessionId`, and `messageId`; exported files retain the note.

## Known limitations and retrieval integration

Host search keeps its provider’s word/phrase tokenizer. Two-character Chinese substring recall is not guaranteed. [Sessiongraph](https://github.com/CC19990113/dsh-plugin-sessiongraph) is a separate history index with CJK bigrams. Its 0.3.3 public search interface supports time and entry-kind filters, but uses `offset` and accepts one session ID rather than an authorized ID set; it has no explicit current-surface filter or authorized ID-set input. This bundle does not install or mount Sessiongraph. Fleet therefore retains Host search rather than silently changing search semantics or building another index. Integration needs explicit history-search semantics, bounded authorization filtering, and index-generation/freshness handling.

## Development

```sh
pnpm install
pnpm run check:refactor   # host support window, typecheck, lint, prettier
pnpm run test             # vitest run
pnpm run build            # declarations plus the bundled entry
```

Requires Node.js 22 or later.

The behavior suite uses real agents with JSONL persistence. A YAML Loader smoke also runs the real Session Controller, workspace registry, JSON storage, queue delivery, inspection, and disposal. The model adapter and unused image/GUI transport are test doubles.
