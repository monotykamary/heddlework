# Installer PTY harness

`install.sh` prompts through a real terminal, so its interactive paths need a
PTY to exercise. Run this harness from a real Linux shell (a Windows host
shell cannot allocate one, so Git Bash users go through WSL):

```bash
wsl.exe -e bash -c 'cd /mnt/c/path/to/heddlework && tests/pty/run-case.sh <case-name>'
```

Cases (each drives `install.sh` through `tests/pty/pty-run.py`):

- `menu-default` — Enter at the harness menu selects the Heddlework path.
- `menu-pi` — option 2 selects the Pi + Fabric harness and runs its install.
- `hidden-input` — a configured provider key is never echoed to the terminal.
- `already-configured` — detection works when only Node is installed.
- `ctrl-c` — interrupt during hidden input restores terminal echo.
- `eof-default` — EOF at the menu falls back to the default harness.
- `bun-prompt-decline` — declining the Bun install stops without installing.
- `bun-install-accept` — accepting runs the installer (curl is mocked).
- `bun-missing` — non-interactive builds stop with the required version when Bun is absent.
- `bun-unsupported` — old, prerelease, and invalid versions stop before dependency installation.
- `bun-supported` — stable 1.4.0 and newer versions reach dependency installation and build.
- `bun-upgrade-decline` — an old Bun never triggers an upgrade without consent.
- `bun-upgrade-failed` — a failed installer, unchanged Bun, or installed old version cannot reach the build.
- `bun-upgrade-accept` — an explicitly accepted upgrade is rechecked and the supported binary builds.
- `auth-write` — real Node writes auth.json with mode 0600. Skipped when no
  real Node is resolvable outside the case's PATH shim; set
  `PTY_REAL_NODE=/abs/path/to/node` to enable it (e.g. a Node that is not on
  `PATH` at all).
- `custom-endpoint` — `--write-model-config` writes `models.json` from the
  `HEDDLEWORK_OPENAI_*` variables, keeps an unrelated provider that is already in
  the file, stores the key in `auth.json`, and references it from the environment
  instead of inlining it.
- `custom-endpoint-prompt` — the same endpoint collected interactively: every
  provider prompt declined, the default provider id and API flavor accepted, and
  the key never echoed to the terminal.
- `desktop-launcher` — `packaging/linux/install-user.sh` completes on a PTY,
  stages binary/web/icon/launcher/desktop entry correctly, and the produced
  launcher executes through to the installed binary in the chosen workspace.

The harness isolates `HOME`, `PATH`, and the installer's environment. Only
allowlisted utilities and explicit mocks are available: a real Bun on the host
cannot bypass a missing-Bun case, downloads are mocked, and provider credentials
are not inherited. The Bun cases mock dependency installation and compilation;
they test the prerequisite gate, not a real native build.

The PTY transcript for each case lands in `/tmp` and the runner asserts on it
(see `run-case.sh`).
