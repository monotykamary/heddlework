# Native runtime contract

Heddlework consumes GPUIX — the React reconciler (`@gpuix/react`), a Rust/N-API
host (`@gpuix/native`), and GPUI built from GPUIX's pinned Zed fork. The
application depends on a small set of GPUIX APIs added by
`patches/gpuix-0.7.0-heddlework.patch`, which spans two trees:

- the GPUIX repository root (`packages/native`, `packages/react`), and
- the `crates/gpui`, platform backend, `crates/gpui_linux`, and
  `crates/gpui_platform` sections inside the checked-out Zed submodule.

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

## Linux application identity

`createWindowOptions('linux', ...)` sets `appId` to
`io.github.monotykamary.heddlework`, matching the desktop entry filename,
icon name, and `StartupWMClass` in `packaging/linux/`. macOS and Windows keep
 their existing window options unchanged.

The patch exposes `appId?: string` in GPUIX's native `WindowOptions`, inherited
by React's `RenderOptions`. React forwards it to `renderer.init`; N-API maps it
to Rust's `app_id`, which `to_gpui_window_options` forwards to GPUI. GPUI uses
that identity for Wayland `xdg_toplevel.set_app_id` and X11 `WM_CLASS`. Omitting
it preserves GPUI's platform default. Changing only Heddlework's TypeScript
options is insufficient: the native addon must also be rebuilt with this patch.

`check:native` reports a missing `native.window-app-id` declaration as a desktop
degradation, not a startup failure. This static declaration check does **not**
prove that the installed binary or a live compositor uses the value. After
building and installing the patched runtime, launch under Wayland and inspect
`WAYLAND_DEBUG=1 bun start` for a `set_app_id` request containing the ID. On
Hyprland, `hyprctl clients -j` should show the same `class`; under X11, select
the window with `xprop WM_CLASS`. Confirm launcher grouping and the installed
icon visually. Native window-option mapping tests live in the GPUIX patch.

Heddlework's test command is scoped to `./tests` so the ignored `external/gpuix`
source checkout does not contribute upstream tests to `bun run check`.

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

## Native Linux appearance

The optional `native.system-appearance` capability exposes
`subscribeSystemAppearance(listener)`, returning an idempotent disposal handle.
Initialization is asynchronous. Available events carry raw `none`, `light`, or
`dark` preferences; transport failure reports `unavailable`, not `none`.
Non-Linux targets report unsupported availability asynchronously.

The owned Linux Settings task observes changes before reading the initial
snapshot, reconciles buffered changes, suppresses duplicates, and bounds setup
to six seconds. Disposal cancels the task; the N-API delivery trampoline also
fences queued callbacks. This does not change GPUI window-theme policy.

Heddlework uses explicit native preferences without starting gsettings. No
preference keeps native observation while the existing monitor/poll fallback
resolves appearance. Failure or setup timeout retires native observation for
the provider lifetime. Omarchy palettes and explicit theme modes are unchanged.

Native code requires rebuilding and explicitly restarting the app; Bun watch
does not reload an addon. Check the loaded addon path before dogfooding.
Run the controlled private-session probe against an explicitly selected addon:

```sh
dbus-run-session -- bun scripts/probe-system-appearance.ts /path/to/rebuilt-addon.node
```

The fixture requires `/usr/bin/python3` with PyGObject and `gdbus`. The probe
covers raw preference mapping, duplicate suppression, disposal during setup and
stream waiting, queued delivery after disposal, listener self-disposal,
environment teardown, read/change ordering, malformed signal data, and portal
owner loss. It passed against `/tmp/heddlework-m3.node`.

Hyprland acceptance also passed with the rebuilt addon installed at
`node_modules/@gpuix/native/gpuix-native.linux-x64-gnu.node` (SHA-256
`04b047ab332384fd4f3d664d51aaecda0758bcaa3ef4c2a8fa674b885c5ae7ad`).
A fresh app launch created a native window, resolved the initial light preference
through the native backend, received a real light-to-dark settings change with
no gsettings monitor child, and shut down cleanly on SIGTERM. The original
preference was restored. The browser-free executable is `dist/heddlework`.
The complete patch applies to clean pinned GPUIX and Zed source trees.

GNOME and KDE desktop sessions were not exercised; Hyprland and private D-Bus
results must not be presented as acceptance for those desktops. The locally
installed addon must be rebuilt/reinstalled after dependency replacement;
Bun watch alone does not reload it.
