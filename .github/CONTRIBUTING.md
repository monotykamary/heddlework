# Contributing to Heddlework

Thanks for helping. This is a harness-neutral agent workspace; the contribution model is small
deliberately structured.

## Where changes live
- **Fork** → PR against `main`. This repo stages its own raft of work on the fork until a
  milestone is ready to submit upstream, so a branch may stay here for a while.
- **Native behaviors** go through the GPUIX patch + `native-runtime.json`; read `docs/native-runtime.md`.

## Merging gate
A change is ready when all of these hold:
1. `bun run typecheck` — exit 0
2. `bun test ./tests` — all green
3. `bun run check:native` — no failed capabilities
4. `bun run check:ai-slop` — exit <= 1 (no unresolved markers)
5. `bun run build` (with `HEDDLEWORK_WITHOUT_CEF=1` where CEF is out of scope)

CI runs these automatically; a PR is not ready while the required check is red.

## PR conventions
- Use the PR template. Keep the title and description substantive.
- One logical change per PR; keep diffs reviewable and cohesive.
- Don't commit `.pi/` or agent-runtime state.

## Scope & safety
- Solo project: no CODEOWNERS, no required approvals.
- License is MIT (matches upstream).