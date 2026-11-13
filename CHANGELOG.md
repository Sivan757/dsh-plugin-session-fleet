# Changelog

## [0.5.0](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.4.0...dsh-plugin-session-fleet-v0.5.0) (2026-11-13)


### Features

* manage pending peer inbox messages ([90cf07f](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/90cf07fd8a41377f2f858e8dd49ec087318782ab))


### Bug Fixes

* deliver coordination feedback within active turns ([719a4e7](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/719a4e7dc40965e4253dfa9fff8e38a9e4b0abfc))


### Documentation

* prepare Session Fleet 0.5.0 release ([17b1b04](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/17b1b040c3e0c13da3d65fd96bcb1479a4dc0e6d))

## [0.4.0](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.3.0...dsh-plugin-session-fleet-v0.4.0) (2026-11-12)

### Upgrade notes

- Keep using the five Fleet tools and existing string messages. Structured `send_to_session` messages add explicit proposals, acceptance, conflict reports, handoffs and release.
- Use `list_sessions.query` for title candidates and session-local literal search when the Host index is disabled. Cross-session full-text search still requires the Host index.
- Use `inspect_session` with `mode: "calls"` and `errors_only: true` to locate native failures, then read the returned input and result event sequences. Follow `next` to keep the captured boundary across pages.
- Coordination is advisory. Message receipts confirm queue admission, and historical acceptance records do not grant authority, guarantee a current owner or implement resource locks.

### Validation

- 123 tests pass with the Host support window, type checking, lint, formatting and production build. Native Loader and AgentLoop tests cover both coordination owner roles, handoff, exact message references and terminating acknowledgement behavior with a scripted model adapter.


### Features

* coordinate scoped work with structured peer messages ([67ffac9](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/67ffac9a3515062ba3f3938ce15601903a9a6044))
* improve session retrieval and coordinated work ([2dcdd37](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/2dcdd37150800166c5f6a2280d05ca4dceb64afb))
* navigate native tool calls and failures ([a6fd33e](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/a6fd33e44892a94d617cd6bbdd067b0bf124f713))
* retrieve session evidence without a full-text index ([81e4e7f](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/81e4e7fcc5c0a97683ba0246ff874e43026b3470))


### Bug Fixes

* distinguish recorded workspace from command cwd ([a722d9c](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/a722d9cb715a62adf709eecf3be8456d0844a05e))

## [0.3.0](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.2.2...dsh-plugin-session-fleet-v0.3.0) (2026-11-11)

### Upgrade notes

- List and search results are paginated. Follow `hasMore` and `nextCursor` to traverse the current authorized scope.
- Inspection defaults to a compact outline. Set `transcript: true` explicitly to create a bounded private text export.
- Delivery acceptance confirms queue admission. Keep `messageId` and inspect the target before retrying an unknown persistence result.

### Features

- Add `inspect_session` as the fifth Fleet tool, with `outline`, native event `search`, and exact-event `read` modes. Return executable detail calls and backend-provided source locations when available.
- Return complete selected events, including tool results, with bounded neighboring summaries. Inspect stored sessions without activating an Agent.
- Continue authorized discovery across model tool calls while preserving hidden-subagent and delivery restrictions.
- Return stable delivery IDs and explicit persistence receipts from the native queue and steer paths.

### Fixes and validation

- Honor explicit creation locations, bound list sizes, and count ownership exclusions separately from cwd filtering.
- Retain the Host search provider and tokenizer. This release adds no separate CJK index.
- Pass 82 tests, including Loader, SQLite, archived-session reads, and actual AgentLoop calls with a test model adapter. Verify the built JavaScript bundle and package contents.

## [0.2.2](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.2.1...dsh-plugin-session-fleet-v0.2.2) (2026-10-17)


### Bug Fixes

* assert the build order without needing a build ([f6cb892](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/f6cb8929b567dff58e03d4a147e70b25e738c617))


### Miscellaneous Chores

* **release:** pin this release to 0.2.2 ([a90a439](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/a90a439bb9c0a56f338ad696fa1c3a21ffb5c77b))

## [0.2.1](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.2.0...dsh-plugin-session-fleet-v0.2.1) (2026-10-17)


### Bug Fixes

* keep the published declarations and skip a duplicate publish ([ec54c3d](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/ec54c3db198b4f0bd09b771e7f554d5ab9302430))

## [0.2.0](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.1.0...dsh-plugin-session-fleet-v0.2.0) (2026-10-17)


### Features

* auto-assign new sessions to caller workspace (fixes ungrouped issue) ([1124331](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/11243315b995848f3569da3bc7ad1c8e08ea62bf))
* bound read_session token cost with per-message truncation and after_seq incremental reads ([5f1c9e0](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/5f1c9e0598af1418b7812d65aea700eb61adb54e))
* hide subagent-owned sessions behind an includeSubagents opt-in ([13705e6](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/13705e63872e0846c2eaca37ef659b2a0c53f88b))


### Bug Fixes

* decide the native build scripts so CI can install ([e7dbf30](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/e7dbf3002f60c6230371f581ead4906fbfff2b78))
* restore bundle stub module ([2ab5b5e](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/2ab5b5eb043df055b85b308a9b8cd78045100255))
* wire the local gate and the release chain ([4f53daa](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/4f53daa47460b7a1b986a7bda3d2b08eb4f48946))
