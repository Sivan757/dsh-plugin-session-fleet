# Changelog

## [0.3.0](https://github.com/Sivan757/dsh-plugin-session-fleet/compare/dsh-plugin-session-fleet-v0.2.2...dsh-plugin-session-fleet-v0.3.0) (2026-11-11)


### ⚠ BREAKING CHANGES

* export bounded session transcripts only on request

### Features

* export bounded session transcripts only on request ([a8880ce](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/a8880ceb2a5d1f6fb8d36e53c67df6800de0884c))
* expose native session details through inspect modes ([29a3767](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/29a3767e0aa62f67ac7e9770f3f2bee956eaaf2b))
* inspect_session outline and workspace-aware search hits ([3bb7ec0](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/3bb7ec0c7ac6c38df2f0257dfe13bac5a0ad29b5))
* inspect_session writes a grep-able transcript instead of paging messages ([d74ead6](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/d74ead6a9f7e520650b89c06618460e164189978))
* on-disk full-text session search with CJK bigrams, incremental refresh ([2b4189e](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/2b4189e2ee1f00ec39eb6b4af4bacef945cdbcc8))
* paginate authorized session discovery and search ([2a14fcc](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/2a14fcc7b06159a2334be215856dd57d713af324))
* return inspectable delivery persistence receipts ([ffab045](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/ffab045194caab145ccb0ea3e18142e7a2df08a6))


### Bug Fixes

* honor explicit session locations and list bounds ([7d39a04](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/7d39a040779a6d150aee6c4d85a8dfbf45c73d4d))
* preserve discovery continuation across model tool calls ([4c5096f](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/4c5096fbccdf95a7415903badfa32ac7de736026))


### Documentation

* prepare Session Fleet 0.3.0 upgrade guidance ([2d9bf3f](https://github.com/Sivan757/dsh-plugin-session-fleet/commit/2d9bf3fe7c59ca9bf275c77baa1f473579b25eef))

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
