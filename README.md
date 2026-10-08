# dsh-plugin-session-fleet

Session Fleet: a DeepSeek Harness plugin whose five model-facing tools let one agent discover, read, create, and message other DSH sessions.

English | [中文](README.zh.md)

## Tools installed per agent

- list_sessions: list visible sessions with status, activity, and working directory, without starting any of them.
- search_sessions: literal full-text search across visible session messages.
- read_session: read one session transcript, newest messages last.
- create_session: create a session in a given cwd or workspace.
- send_to_session: deliver a queued or steered message to another session through the DSH session message queue.

Deliveries carry the dedicated session-fleet message source and a peer-agent framing note, so targets never mistake fleet input for user input.

## Install

From the Web sidebar's Plugins page, install one of:

- a local checkout: an absolute path to this directory
- the repository once pushed: github:USER/dsh-plugin-session-fleet

Then enable Session fleet.

## Safety model

- Delivery targets ordinary sessions only. Subagent children stay on subagent routing.
- Cross-workspace delivery is refused unless allowCrossWorkspace is true on the plugin row.
- List and search bounds (maxListRows, maxReadMessages, maxMessageChars) ship conservative defaults.

## Development

    pnpm install
    pnpm test
    pnpm build
    pnpm lint
    pnpm typecheck

Requires Node 22.19+ or 24+. Peer dependencies pin DeepSeek Harness 0.2.0-rc.2 packages; keep them aligned with the installation you target. During development you can point peer packages at a harness checkout with pnpm overrides.
