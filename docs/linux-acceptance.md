# Linux acceptance evidence

M5 separates deterministic CI from claims that only a real compositor can prove.
Fill this table from a patched binary (not TypeScript declarations alone). Record
runtime commit, GPUI commit, patch SHA-256, portal backend versions, compositor,
architecture, and the commands used.

Automated lane:

```bash
bun run typecheck
bun test ./tests
bun run check:native
bun run check:ai-slop
HEDDLEWORK_WITHOUT_CEF=1 bun run build
desktop-file-validate packaging/linux/io.github.monotykamary.heddlework.desktop
```

`bun run check:native` now records the resolved addon path and SHA-256, and
rejects a declaration that the loaded addon does not export. A headless job may
report compositor-dependent rows as not exercised; it must not treat a
declaration match as live behavior.

Live lane (target package blocked until the Omarchy/Hyprland row passes):

| Capability | Omarchy/Hyprland | GNOME Wayland | KDE Wayland | X11 |
| --- | --- | --- | --- | --- |
| app ID / grouping | | | | |
| appearance initial/change | | | | |
| directory select/cancel | | | | |
| theme replacement gap | | n/a | n/a | n/a |
| raw terminal frames | | | | |
| thread-switch confirmation | | | | |
| surface-switch view retention | | | | |
| browser hide/show recovery | | | | |
| clean shutdown | | | | |
| scale/input smoke | | | | |

Omarchy/Hyprland sign-off notes:

- Runtime identity: app commit, GPUIX/Zed pins, patch hash, addon SHA-256, launch command.
- Native paths: `supportsNativeTerminal() === true`, no `gsettings monitor` child when appearance is native, no `gdbus`/`dbus-monitor` child when the directory chooser is native.
- A1: cancelled confirmation leaves the live run; confirmed switch aborts then `switch_session`.
- A2: Chat → Settings → Flows → Chat keeps transcript disclosure, composer draft, and terminal session without a PTY restart.
- A3: hidden embedded tabs keep identity and last logical bounds; animation/timer work may pause. A CEF-free build does not prove browser behavior.
- Teardown: close during streaming, pending picker, resize, and hidden surfaces leaves no child/watcher leak.

GNOME, KDE, and X11 rows stay pending until exercised. First-release support claims are Omarchy-target acceptance, not the whole matrix.
