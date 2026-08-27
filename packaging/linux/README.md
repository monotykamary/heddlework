# Linux desktop integration

Heddlework does not ship a signed Linux package yet. This directory provides a desktop-entry template and a user-local installer for the current unsigned source preview.

## Install the source preview

Build the standalone executable, then run the installer from the repository root:

```bash
pnpm build
HEDDLEWORK_PI="$(command -v pi)" ./packaging/linux/install-user.sh
```

The installer copies:

- the compiled app to `${XDG_DATA_HOME:-$HOME/.local/share}/heddlework/heddlework`;
- a launcher to `$HOME/.local/bin/heddlework`;
- `io.github.monotykamary.heddlework.desktop` to the user applications directory; and
- the scalable icon to the user hicolor icon theme.

The launcher records an absolute Pi path and only absolute entries from the installation shell's `PATH`. Desktop sessions commonly do not inherit shell initialization, so this also keeps a Pi shim's `node` or `bun` interpreter discoverable. Re-run the installer after moving or upgrading Pi. `HEDDLEWORK_LAUNCH_PATH` can override the captured path.

The desktop launch starts in `$HOME`; choose a repository with Heddlework's project picker. Set `HEDDLEWORK_WORKSPACE` in the desktop session if a different initial directory is required.

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

`StartupWMClass=heddlework` is a best-effort X11 hint. GPUIX 0.5.1 does not expose GPUI's application-ID option, so reliable Wayland dock grouping requires an upstream API addition.
