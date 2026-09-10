# Session performance port

## Scope

This port adapts session and streaming performance work from the community
[0xCUB3 Heddlework fork](https://github.com/0xCUB3/heddlework) without importing
its host/session architecture. It is intentionally limited to the Pi session
catalog, the workbench controller, and notification scheduling.

## Acceptance ledger

- [x] Concurrent sidebar page requests share one unbounded catalog scan.
- [x] Unchanged session summaries retain object identity.
- [x] A cwd-scoped scan preserves cached and persisted rows for every other cwd.
- [x] Scoped merges prune rewritten paths rather than duplicating stale summaries under an old cwd.
- [x] Concurrent scoped scans serialize persistence so the latest combined snapshot wins.
- [x] Catalog subscribers share one watcher per root and release it after the final unsubscribe.
- [x] Initial watcher attachment receives one reconciliation, and invalidations use trailing debounce.
- [x] Invalidations received during a scan trigger one awaited follow-up scan.
- [x] Background catalog refreshes do not flicker `sessionsLoading`.
- [x] Foreground load-more joined to a background scan stays loading until dirty replay completes.
- [x] High-frequency assistant/tool updates are batched to one trailing UI notification per frame.
- [x] Structural and settled state changes flush notifications immediately.
- [x] Late transcript and bootstrap responses cannot erase a newer response or running tool, including after that newer turn settles.
- [x] A confirmed-idle bootstrap clears stale live rows even when transcript loading fails.
- [x] A stale idle bootstrap cannot drain queued work into an active turn.
- [x] Existing session pagination, switching, disposal, and queue behavior remains covered.

## Accepted and adapted

### Shared catalog scans and watching

Source: community commit
[`db625548f668f218c23d0790840ddd5d996ae71f`](https://github.com/0xCUB3/heddlework/commit/db625548f668f218c23d0790840ddd5d996ae71f).

`PiSessionCatalog` now removes presentation limits before scanning, coalesces
in-flight work by catalog scope, and applies the caller's limit only to the
shared result. Summary objects are reused when their metadata is unchanged,
which lets the controller preserve the session collection identity and avoid
unnecessary paints.

The fork patch replaced the complete cache after every scan. That is unsafe for
this tree because one controller can move between cwd-scoped catalogs. The
adaptation keeps a cache per resolved cwd, merges refreshed cwd rows into the
persisted catalog, and prunes that scope by both resolved cwd and scanned path.
The path check prevents a rewritten header from preserving a duplicate summary
under its previous cwd. Persistence writes are chained from immutable snapshots,
preventing two completed cwd scans from racing and leaving a partial catalog on
disk. Unchanged results do not rewrite the cache.

`watchPiSessions` uses one native watcher plus one low-frequency root identity
probe. The catalog reference-counts listeners by root. Existing roots attach
synchronously and schedule one trailing reconciliation, closing the initial
subscription gap without polling session contents. Creation, replacement, JSONL
writes, rename, and watcher failure also schedule a trailing invalidation.
Low-frequency retries reattach the watcher. Missing roots do not trigger repeated
catalog scans; existing roots on filesystems without native watch support receive
a bounded fallback refresh at the retry cadence (five seconds by default). The
final unsubscribe closes the native watcher and all timers. An injected watcher
backend regression covers unsupported-watch fallback without globally mocking
filesystem imports or depending on unrelated file changes.

Controller refreshes replay invalidations inside the same in-flight promise.
Consequently, load-more that joins a background scan exposes loading state,
blocks another page increment, and resolves only after the enlarged page is
available.

### Live refresh race handling

Source: community commit
[`d196b0ca043d109a211b1b4edf2958e62da4d336`](https://github.com/0xCUB3/heddlework/commit/d196b0ca043d109a211b1b4edf2958e62da4d336).

Bootstrap and transcript requests carry generations, while stream start/settle
boundaries carry a stream revision. Transcript results are discarded when any
newer stream boundary occurs, including when the newer turn has already settled.
A successful current transcript reconciles live rows, while an unraced idle
`get_state` clears stale live rows immediately even if transcript loading later
fails. A stream that races `get_state` keeps its overlay. Refresh scheduling
keeps the strongest pending refresh, does not postpone continuously under tool
traffic, and ignores events after disposal.

Initial transcript loading and supplementary metadata requests now paint
independently while `start()` and session-switch completion retain their prior
awaited semantics. This gives the useful part of lazy restoration without
introducing the fork's background session runtime.

### Notification batching

Source: community commit
[`1e1239f`](https://github.com/0xCUB3/heddlework/commit/1e1239f).

Assistant, tool, and activity-only updates use a 16 ms trailing notifier.
Changes to the transcript, session, queue, notices, or other structural state
flush immediately. Settle events therefore remain an immediate boundary and
queue draining observes current state, while delta bursts no longer notify
React once per token.

## Deliberately excluded

- [`02b73c6`](https://github.com/0xCUB3/heddlework/commit/02b73c6): lazy inactive-session restoration belongs to the fork's host
  `session-runtime`; this controller has no equivalent bundle lifecycle. Only
  independent transcript/metadata painting was adopted.
- [`5e1091e`](https://github.com/0xCUB3/heddlework/commit/5e1091e) and
  [`2aa7725`](https://github.com/0xCUB3/heddlework/commit/2aa7725): snapshot identity reuse and prepend deltas are protocol/host/client
  work and are owned by the separate host integration.
- [`548ba23`](https://github.com/0xCUB3/heddlework/commit/548ba23): cumulative-to-delta streaming modifies `live-bridge.ts`, which this
  branch does not have as a controller transport. No live attach runtime or
  unauthenticated transport was introduced.

## Verification

`bun run check` runs the functional suite and then `bun run test:performance` in
a fresh process. The existing 2,500/3,000 ms startup and 300 ms scroll budgets are
unchanged; isolating their native heap avoids suite-order contamination. The
functional diff test also verifies that scrolling adds no React commits, with a
nonzero initial Profiler count so the assertion cannot pass vacuously.

The focused tests use counts and identities rather than timing as the primary
claim:

- `tests/session-performance.test.ts` checks one scan for overlapping requests,
  stable row identity, unchanged persistence mtime, cross-cwd retention,
  rewritten-path pruning, initial watcher reconciliation, bounded failed-watch
  retries, watcher refcount behavior, and dirty-refresh replay.
- `tests/notify-batch.test.ts` checks 100 updates become one notification and
  that immediate flush/cancel boundaries are exact.
- `tests/live-refresh.test.ts` checks late-refresh reconciliation before and
  after newer turns settle, failed-transcript idle cleanup, stale idle bootstrap
  behavior, queued-work retention, and a 100-delta controller burst with an
  immediate settled notification.
- Existing `tests/session-loading.test.ts`, `tests/session-switch.test.ts`,
  `tests/session-history-controller.test.ts`, and `tests/controller.test.ts`
  continue to cover paging, switches, transcript history, and queue behavior.
