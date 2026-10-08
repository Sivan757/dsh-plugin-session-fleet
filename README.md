# dsh-plugin-session-fleet

Model-facing tools that let one DeepSeek Harness agent discover, read, create, and message other DSH sessions.

English | [中文](README.zh.md)

## Packages

- packages/session-fleet: the Cordis function plugin. Five scoped tools per agent: list_sessions, search_sessions, read_session, create_session, send_to_session.
- packages/session-fleet-bundle: optional profile bundle that inserts the plugin row with conservative defaults.

## Install

From the Web sidebar's Plugins page, install one of:

- the repository: github:sivanzheng/dsh-session-fleet-plugin
- a local checkout: an absolute path to this directory

Then enable Session fleet. A live root agent receives the five tools. Deliveries reuse the DSH session message queue (followup for queued turns, steer for the running turn) and carry the dedicated session-fleet message source, so targets never mistake fleet input for user input.

## Safety model

- Delivery targets ordinary sessions only. Subagent children stay on subagent routing.
- Cross-workspace delivery is refused unless allowCrossWorkspace is true on the plugin row.
- A delivery lands as peer-agent input with an explicit source note, never as user input.

## Development

    pnpm install
    pnpm --filter dsh-plugin-session-fleet test
    pnpm --filter dsh-plugin-session-fleet build

Requires Node 22.19+ or 24+. The tools package builds against published DeepSeek Harness packages; keep the peerDependencies ranges aligned with the installation you target.
