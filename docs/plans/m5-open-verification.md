# M5 open verification items

Working notes for acceptance items the oracle plan flagged and PRs #9/#10 did not close.

## 1. Persisted-session settlement path vs harness authority

`#refreshMessages` (src/workbench/controller.ts) has two branches:

- no `sessionFile`: fetches `get_messages` — the authoritative settlement the
  transcript invariant names.
- `sessionFile` present: builds a `PiSessionHistoryPager` over the session file,
  patches `messages` (merged via `mergeTranscriptTail`) and clears
  `liveAssistant` / `liveTools` without a `get_messages` round trip.

The pager reads the same session file the harness writes, so its rows are
harness-authored — but nothing on that branch proves the file had settled the
in-flight turn before the live projection is dropped. If the file lags the RPC
stream, a streaming block could be replaced by shorter file content until the
next settle. Unconfirmed: no repro, no fixture.

Next step: a fixture test that runs `#refreshMessages` on a session file written
to lag the RPC stream (pager reading a truncated turn) and asserts no settled row
regresses and the live block is not dropped mid-turn. Gate it on
`PiSessionHistoryPager` over a temp file; no native renderer needed.

## 2. Reproducible patched runtime in CI

`check:native` now records addon path + SHA-256 and rejects declarations the
loaded addon does not export, but CI still installs the published addon and
verifies declarations only. The plan (oracle consult, 2026-09-10) calls for:

- a CI lane that builds the patched addon from `external/gpuix` pins and runs
  the gates against that installation, or
- a checksummed artifact download keyed by build-input identity.

The stale-binary negative test (`rejects declarations that the loaded addon does
not export`) is the regression class; keep it green while wiring the lane.

## 3. Web paste bracketing (open)

In headless Linux Chromium the browser reports clipboard pastes as beforeinput
`insertText` (not `insertFromPaste`) and no `paste` event reaches the terminal
input, so pasted text reaches the PTY unwrapped even in bracketed-paste mode;
`scripts/web-browser-probe.ts` fails its bracketed-byte assertion on Linux and
the CI lane reports it non-blocking. Fix direction: normalize paste-ish
`insertText` bursts in `src/dom/host.tsx` (or handle the paste event earlier in
the input pipeline) so the web terminal honors bracketed-paste mode like the
native one.

## 4. Deferred by plan

Multi-process session ownership (post-M6, ADR first), broad timeline identity
caching (C3), unthrottling hidden Chromium, and `file:` lockfile consumption.
