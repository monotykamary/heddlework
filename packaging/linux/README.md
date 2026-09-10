# Linux desktop integration

Heddlework does not ship a signed Linux package yet. This directory provides a desktop-entry template and a user-local installer for the current unsigned source preview.

## Install the source preview

Build the standalone executable, then run the installer from the repository root:

```bash
bun run build
HEDDLEWORK_PI="$(command -v pi)" ./packaging/linux/install-user.sh
```

The installer copies:

- the compiled app to `${XDG_DATA_HOME:-$HOME/.local/share}/heddlework/heddlework`;
- the built companion web shell beside the executable when present (remote access remains off by default);
- a launcher to `$HOME/.local/bin/heddlework`;
- `io.github.monotykamary.heddlework.desktop` to the user applications directory; and
- the scalable icon to the user hicolor icon theme.

The launcher records an absolute Pi path and only absolute entries from the installation shell's `PATH`. Desktop sessions commonly do not inherit shell initialization, so this also keeps a Pi shim's `node` or `bun` interpreter discoverable. Re-run the installer after moving or upgrading Pi. `HEDDLEWORK_LAUNCH_PATH` can override the captured path.

The desktop launch starts in `$HOME`; choose a repository with Heddlework's project picker. Set `HEDDLEWORK_WORKSPACE` in the desktop session if a different initial directory is required.

The source installer selects GPUix's CEF-enabled native build only on Darwin (`scripts/install-gpuix.ts` delegates through `nativeBuildCommand`). Linux uses the non-CEF release build, so this Linux preview does not yet provide embedded CEF browser surfaces.

To remove the preview:

```bash
rm -f "$HOME/.local/bin/heddlework"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/heddlework"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/io.github.monotykamary.heddlework.desktop"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps/io.github.monotykamary.heddlework.svg"
```

## GNOME launcher caching

The installer runs `update-desktop-database` when it is available. GNOME Shell can still retain the first-seen `Exec` value. On Wayland, log out and back in after replacing a cached entry; on X11, restarting GNOME Shell also refreshes it. A temporary desktop-file ID is useful while testing, but released packages should keep the stable `io.github.monotykamary.heddlework` ID so favorites and permissions survive upgrades.

## Diagnostics and privacy

The launcher does not redirect output into a file. Run it from a terminal when diagnostics are needed. Pi stderr can include repository paths, prompts, and tool context; any future package that captures it must create logs with mode `0600`, cap or rotate them, and ask users to review logs before sharing.

## Notes for distribution packagers

Install `io.github.monotykamary.heddlework.desktop` after replacing `@HEDDLEWORK_EXEC@` with the package's absolute launcher path. Install `media/heddlework-icon.svg` as `io.github.monotykamary.heddlework.svg` in the platform icon theme.

`StartupWMClass=heddlework` is a best-effort X11 hint. The pinned native runtime receives Heddlework's application ID directly for reliable Wayland shell grouping.

## Native compositor smoke validation

The Linux CI job builds the pinned Heddlework GPUix runtime with release features, selects Mesa lavapipe explicitly, and runs the same rendered smoke window against three real compositor slices:

- Mutter as a headless Wayland display server with a virtual monitor;
- Sway/wlroots with headless and pixman backends; and
- Mutter managing an Xvfb X11 server.

Both client-side and server-side decoration requests run as separate matrix cases. CI sets `NAPI_RS_NATIVE_LIBRARY_PATH` to the just-built pinned addon so an installed optional native package cannot mask the source under test. Each case starts `scripts/smoke-linux-window.tsx` through GPUIX's stdio automation protocol and requires applicable renderer, protocol, and compositor checks plus a clean native close. Reports distinguish `passed` from `complete`: a compositor limitation can leave an otherwise successful case incomplete, while missing required evidence fails the case. The harness checks the configured application ID and effective decoration mode at the Wayland protocol, Sway IPC, or X11 window-manager layer rather than accepting process survival as a pass. Mutter's Wayland server intentionally validates GNOME's server-request-to-client-decoration fallback.

The X11/Mutter cases additionally require `_NET_WM_STATE_HIDDEN` after minimize and observable geometry changes from real XTEST pointer drag/resize gestures. The harness waits for Mutter's window-manager and `_GTK_FRAME_EXTENTS` capabilities before the X11 client starts, so GPUI observes the compositor when it selects decoration support. The first X11 automation-tree read tolerates cold software-Vulkan startup by retrying only the native automation-bounds timeout within a 30-second readiness deadline; reports record the attempt count and elapsed time, and production RPC timeouts are unchanged. Sway cases compile the vendored wlroots virtual-pointer protocol helper and require real serial-backed `xdg_toplevel.move` and `xdg_toplevel.resize` requests, no second move during the resize gesture, and corresponding compositor geometry changes. All Wayland cases require `xdg_toplevel.set_minimized` in `WAYLAND_DEBUG`; xdg-shell defines no minimized-state event, so compositor acceptance cannot be observed by the client. Mutter headless Wayland also has no supported virtual pointer injector in Ubuntu 24.04. These protocol limitations are listed under `unvalidated` and force `complete: false`; they are never represented as passed compositor-state checks. Weston remains available as an optional baseline but is not a substitute for the GNOME and wlroots CI slices.

Run a case on an x86_64 Ubuntu 24.04 host after installing the packages listed in `.github/workflows/linux.yml` and installing the pinned native runtime:

```bash
bun install --frozen-lockfile
bun scripts/install-gpuix.ts
./scripts/linux-compositor-smoke.sh mutter-wayland client
./scripts/linux-compositor-smoke.sh sway-wayland server
./scripts/linux-compositor-smoke.sh mutter-x11 server
```

Set `HEDDLEWORK_SMOKE_ARTIFACTS` to retain reports and compositor logs outside `/tmp/heddlework-linux-smoke-results`.
