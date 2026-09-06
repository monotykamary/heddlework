# Heddlework — agent guidance

Compact, durable context for any agent (Pi, Codex, Claude) working in this repo. Prefer ground truth over this file; these notes encode invariants that are expensive to rediscover.

## What this is

A native, harness-neutral desktop workspace for agent sessions, task graphs, diffs, and durable
work. React + GPUIX (GPU-rendered) on the client; Pi RPC is the first harness adapter. Core
model: **the harness is authoritative for its own execution and transcripts; Heddlework projects
state and never invents a second agent loop.**

## Verification gates (run these, don't guess)
```bash
bun install --frozen-lockfile   # never mutate the lockfile by hand
bun run typecheck               # tsc --noEmit over src, scripts, tests
bun test ./tests                # the real GPUIX unit suite
bun run check:native            # native-runtime capability probe
bun run check:ai-slop           # objective machine-generated-artifact gate
bun run build                   # unsigned executable (set HEDDLEWORK_WITHOUT_CEF=1 for browser-free)
```
`bun run check` == typecheck + tests and is the project's primary quality gate.

## Invariants & traps
- **Harness authority**: never let UI code own harness truth. Streaming replaces transcript rows
  only after the authoritative `get_messages` settles.
- **Cordis composability**: every registration/listener/timer/process an owner attaches must attach
  its inverse to the same plugin/controller/React lifecycle. Unload withdraws effects in reverse.
- **GPUIX patch**: `patches/gpuix-0.7.0-heddlework.patch` is the source of truth for native
  behaviors. Keep `native-runtime.json`'s `patchSha256` in sync — see `docs/native-runtime.md`.
- **appId / Linux identity**: `src/window-options.ts` sets `io.github.monotykamary.heddlework`
  only on Linux; macOS/Windows paths are regression-locked by tests.
- `.pi/` is agent-runtime state and ignored; the `.pi/fabric/mesh/*` handoff files are session-local,
  never commit them.
- `docs/` explains the native terminal/browser, so read the relevant doc before touching those systems.

## Deliverable hygiene
- Run the full `check` suite before pushing. Prefer squash for fork-local review PRs.
- Keep required-check names stable; rulesets match them exactly.