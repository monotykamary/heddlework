# Native runtime contract

Heddlework consumes GPUIX — the React reconciler (`@gpuix/react`), a Rust/N-API
host (`@gpuix/native`), and GPUI built from GPUIX's pinned Zed fork. The
application depends on a small set of GPUIX APIs added by
`patches/gpuix-0.7.0-heddlework.patch`, which spans two trees:

- the GPUIX repository root (`packages/native`, `packages/react`), and
- the `crates/gpui` section inside the checked-out Zed submodule.

`native-runtime.json` is the machine-readable contract between Heddlework and
that runtime. It records:

- the patch file and its SHA-256,
- the pinned GPUIX commit (tag `@gpuix/react@0.7.0`,
  `a24b4a42eb516c7b940eb8d34ecebb077df623bd`) and the Zed submodule commit it
  pins (`8b94defe56992b3ca4ffd4853ace741d8168111a`),
- the platform addon targets, and
- the capabilities the application requires, each marked `required: true` or
  `false` with a note on how the runtime degrades without it.

## Verify an installed runtime

```sh
bun run check:native
```

This checks the patch checksum, the installed `@gpuix/*` version against the
manifest, the platform addon, and each capability. Required failures exit
nonzero; missing optional capabilities are reported as `degraded` with a
remediation line. CI runs it on both the macOS and Linux jobs.

At startup in a development checkout, `src/main.tsx` runs the same verification
and logs degradations before the first render. Packaged builds skip the probe
(the addon is bundled and there is no `node_modules` to inspect).

## Reproduce the patched runtime from source

```sh
bun scripts/build-native-runtime.ts           # fetch pins, apply-check both patch sections
bun scripts/build-native-runtime.ts --apply   # also apply them to the checkouts
bun scripts/build-native-runtime.ts --build   # also build the native addon and react package
```

The checkouts live in `external/gpuix` (override with `HEDDLEWORK_GPUIX_DIR`).
Both sections have been verified to apply cleanly at the pinned commits. The
build stage needs Rust plus GPUI's Linux system packages (Wayland, Vulkan,
`xkbcommon`); errors from missing system libraries surface there with the full
command output.

To consume the built packages locally, the script prints a `bun install
--force @gpuix/react@file:…` command. Treat that as a development convenience:
record any runtime switch in `native-runtime.json` before it becomes the
committed contract.

## Updating the runtime

1. Bump `@gpuix/react` / `@gpuix/native` in `package.json` (`bun install`).
2. Update `native-runtime.json`: versions, `sourceCommit` (the matching
   upstream tag), the Zed submodule commit it pins, and `patchSha256` after
   regenerating `patches/gpuix-0.7.0-heddlework.patch` against those commits.
3. Drop patch hunks upstream has absorbed; the patch set should shrink.
4. `bun scripts/build-native-runtime.ts` to confirm both sections still apply,
   then `bun run check` and `bun run check:native`.

## Capability semantics at runtime

- Terminal frames: `terminal-view.tsx` feature-detects
  `supportsNativeTerminal()` / `setTerminalFrame` and falls back to base64
  frame props when absent.
- Embedded browser: `browser-host.tsx` probes `supportsNativeBrowser()` and
  renders the unavailable-engine state otherwise; the browser render options
  are consumed only by a runtime that declares them.
- Motion padding/flexGrow keys: unknown keys are ignored by the published
  runtime, so animated insets simply do not animate.
- Test renderer: terminal test fixtures register only when
  `hasTestGpuixRenderer()` is true, which is why the suite reports skips on
  runtimes without it.
