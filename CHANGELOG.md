# Changelog

## [0.5.0](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.9.0...dsh-plugin-session-fleet-v0.5.0) (2026-11-20)


### ⚠ BREAKING CHANGES

* search_sessions is no longer registered.
* export bounded session transcripts only on request

### Features

* auto-assign new sessions to caller workspace (fixes ungrouped issue) ([1124331](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/11243315b995848f3569da3bc7ad1c8e08ea62bf))
* bound read_session token cost with per-message truncation and after_seq incremental reads ([5f1c9e0](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/5f1c9e0598af1418b7812d65aea700eb61adb54e))
* coordinate scoped work with structured peer messages ([c0c53bb](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/c0c53bbc65c6b0f656677b3930788f2eeaba391d))
* draw the fleet icon from the WeChat and DeepSeek marks ([#19](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/19)) ([1e24ad8](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/1e24ad8b3d870f857885ae8ef6a6b66d9db83e1f))
* export bounded session transcripts only on request ([4fbf4ec](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/4fbf4ec369e1ebf15bfed6182024f50ba0913897))
* expose native session details through inspect modes ([4f72d51](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/4f72d512b50b18e9830cf36171631befa368dd2d))
* filter and compact view for list_sessions ([747a9e7](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/747a9e79d3abf9092b7bf8caff9c49bddd457672))
* hide subagent-owned sessions behind an includeSubagents opt-in ([13705e6](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/13705e63872e0846c2eaca37ef659b2a0c53f88b))
* improve session retrieval and coordinated work ([036a963](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/036a963549c97171a4eb79288901a27968a0ae00))
* inspect_session outline and workspace-aware search hits ([cf33bd6](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/cf33bd6811cdc183f4389991d36c76a36ff27e40))
* inspect_session writes a grep-able transcript instead of paging messages ([b19a0d2](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/b19a0d25d43057069db6a1e60a95e5b33c322981))
* manage pending peer inbox messages ([ce7751b](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/ce7751b73846f4ebdb2b91939c2ebdc359b8917c))
* navigate native tool calls and failures ([43655d4](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/43655d4a9e101b4a987d2c17c3be6f0be58e5414))
* on-disk full-text session search with CJK bigrams, incremental refresh ([975edb8](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/975edb8b40de1b26e1189b511ae16aa91eab4219))
* own the session search index instead of borrowing the host one ([d36f956](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/d36f956a445fce60358b441d6decba8e674ee6a0))
* paginate authorized session discovery and search ([c1d58bc](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/c1d58bcd27d5b921bf2b5a85e8f8c4b4b3cc32ab))
* redraw the fleet icon as two DeepSeek whales in conversation ([#18](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/18)) ([2e8d131](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/2e8d1310ecba599e6e65a7c9f2f49ed32d0ca484))
* replace the fleet plugin icon with a coordination-hub glyph ([#16](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/16)) ([3da8b3b](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/3da8b3b5fe3af8d55923e0202596c1bd09e783be))
* require peer agreement before shared operations ([#10](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/10)) ([1e00c74](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/1e00c748db28341122775ef431cb92b40846fa00))
* retrieve session evidence without a full-text index ([2432b2f](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/2432b2f2b469c5e6b07546d5d8f63feb142338c2))
* return inspectable delivery persistence receipts ([52c4300](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/52c4300dbd4c9eccf4281f7c9309a46ede6fdccf))
* search the durable session index from a Fleet tool ([c2d663f](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/c2d663fa885eb50e91f933737ba9687708303b1f))
* use the blue-cyan chat search mark as the fleet icon ([#20](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/20)) ([0598f48](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/0598f48380cccef7b9b7116312489fd331eea0d9))


### Bug Fixes

* assert the build order without needing a build ([7772728](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/7772728ac35b065fcfccc941baeb391583f63886))
* decide the native build scripts so CI can install ([e7dbf30](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/e7dbf3002f60c6230371f581ead4906fbfff2b78))
* deliver coordination feedback within active turns ([6ba8ca3](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/6ba8ca332d5f87afe4d5ea8a5c7ce2b8deb10aff))
* distinguish recorded workspace from command cwd ([cb5d286](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/cb5d28666aaadb56d0b43655f236378a6de1e128))
* honor explicit session locations and list bounds ([28e52ac](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/28e52ac282b2a02e292b8243bb1b7f4907c40d43))
* keep the published declarations and skip a duplicate publish ([fbe9495](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/fbe949580de3bdb2d5b02e8c2d3b4bee1f617b35))
* preserve discovery continuation across model tool calls ([1a8fe37](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/1a8fe37579ae0f0286ae23c92b97dd56233f9ac6))
* restore bundle stub module ([2ab5b5e](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/2ab5b5eb043df055b85b308a9b8cd78045100255))
* wire the local gate and the release chain ([4f53daa](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/4f53daa47460b7a1b986a7bda3d2b08eb4f48946))


### Reverts

* remove the demo recording that showed real session titles and paths ([ede5577](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/ede5577fb20e683b2bd0ff4aef4bdc23f890b5c2))


### Documentation

* prepare Session Fleet 0.3.0 upgrade guidance ([7895a09](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/7895a091f621427df9f827e627bf777293f2425b))
* prepare Session Fleet 0.5.0 release ([f008658](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/f0086580cdebae9816dc5c01e7916a621dbfa1da))


### Code Refactoring

* trim Session Fleet to its evidenced surface ([#13](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/13)) ([de74054](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/de74054a6ace4fbcb263a4d3cea9e554798d97e1))

## [0.9.0](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.8.0...dsh-plugin-session-fleet-v0.9.0) (2026-11-20)


### Features

* draw the fleet icon from the WeChat and DeepSeek marks ([#19](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/19)) ([5730a2e](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/5730a2e7ec903ea86f5827ec4dbd01e594c4aee8))
* own the session search index instead of borrowing the host one ([78b6aca](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/78b6aca23dba9eb2258f5f720921c65235bbe584))
* redraw the fleet icon as two DeepSeek whales in conversation ([#18](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/18)) ([28557af](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/28557aff62edda17e6c86dd4df68d3c3b1e87510))
* replace the fleet plugin icon with a coordination-hub glyph ([#16](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/16)) ([5529b06](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/5529b0663e540661ff9309e139eb409e4a0a2639))
* search the durable session index from a Fleet tool ([e7cda39](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/e7cda399e7a5f2f25517cd565c3fb829f18eb9bd))
* use the blue-cyan chat search mark as the fleet icon ([#20](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/20)) ([679cb32](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/679cb324771ee98053e26a297d19fd1f424de3f3))

## [0.8.0](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.7.0...dsh-plugin-session-fleet-v0.8.0) (2026-11-18)


### ⚠ BREAKING CHANGES

* search_sessions is no longer registered.

### Code Refactoring

* trim Session Fleet to its evidenced surface ([#13](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/13)) ([c784ee9](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/c784ee905fde1bae04e5a6b455ed1538f96cd9b7))

## [0.7.0](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.6.0...dsh-plugin-session-fleet-v0.7.0) (2026-11-16)


### Features

* filter and compact view for list_sessions ([5166c15](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/5166c15e4662bf6ac68b456c9557884817ccdf2c))

## [0.6.0](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.5.0...dsh-plugin-session-fleet-v0.6.0) (2026-11-16)


### Features

* require peer agreement before shared operations ([#10](https://github.com/Sivan757/dsh-plugin-session-fleet/issues/10)) ([488bb41](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/488bb415769cc3be80b9257024043bc7d5c6582d))

## [0.5.0](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.4.0...dsh-plugin-session-fleet-v0.5.0) (2026-11-13)

### Upgrade notes

- `manage_session_inbox` is the sixth Fleet tool. List pending peer input without starting the target, then use native message IDs and expected revisions to update cumulative summaries or withdraw covered notifications. Keep independent findings and unresolved requests.
- New structured coordination messages default to next-step delivery (`steer`). String messages retain next-turn delivery (`queue`), and explicit `delivery` overrides the default. Existing pending messages retain their original boundary.
- Send receipts now include `revision`. Only the sender can replace a pending delivery, and the sender or recipient can withdraw pending peer input. Message identity, contract boundaries and queue position stay fixed. Human input and consumed history remain protected.
- `inspect_session` read results include top-level `text`, bounded to 8000 UTF-16 units, with clipping metadata and the complete original `event`. Queue previews identify the kind, sender and summary, including text blocks coalesced by native UI editing.
- Ordinary conversations remain distinct from native Team delegation. Prefer native delegation when it is available and authorized. Queue management is advisory and does not undo ownership agreements or implement resource locks.

### Validation

- 136 tests pass with the Host support window, type checking, lint, formatting and production build. Native Loader/Controller/AgentLoop regressions cover active-turn feedback, stable pending-message identity, revision and consumption races, peer permissions, protected human input, resolved-target identity, and split/coalesced text framing.


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
