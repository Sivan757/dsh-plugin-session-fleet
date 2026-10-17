# AGENTS.md

Instructions for working in this repository. It ships one DeepSeek Harness plugin: four model-facing tools that let one agent list and search other sessions, create a session, and message a session.

## Layout

```
src/index.ts    the whole plugin: config schema, tool definitions, and the agent-scoped registration
tests/          vitest suites; testkit/ holds the mock agent adapter they share
locale/         en.json and zh.json display metadata for the plugin manager
cordis.patch.yml  the opt-in bundle row the host applies
scripts/        check-host-support.mjs, the host pin gate
```

## Commands

```sh
pnpm run typecheck        # tsc --noEmit
pnpm run lint             # oxlint src tests
pnpm run test             # vitest run; pretest runs check:refactor
pnpm run build            # tsc declarations, then tsdown bundles lib/index.js
pnpm run check:refactor   # host support window + typecheck + lint + prettier
```

## Host compatibility

Every host pin carries the support window `>=0.2.0-rc.2 <0.3.0-0`; only `devDependencies` carry an exact build baseline. The harness evaluates these ranges against the running dsh version and marks a mismatched plugin abnormal in its own manager.

`@deepseek-ai/dsh-brand` must stay a peer, never a dependency. Its `BRAND` is a `unique symbol`, so a second physical copy makes `SessionId` and `WorkspaceId` refuse to satisfy `Branded<string>`, and the type errors name the brand rather than the duplicate install.

## Conventions

- The capability is opt-in: `cordis.patch.yml` carries the row and the profile decides to apply it.
- A tool that reaches another session states that the delivery is peer input, not user input, in both the tool description and the framing note.
- Subagent sessions stay hidden by default and refusing delivery to them stays unconditional.
- A change to a tool name, parameter, output field, or config default updates `README.md` and `README.zh.md` in the same edit.
