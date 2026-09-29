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
- `auth-write` — real Node writes auth.json with mode 0600. Skipped when no
  real Node is resolvable outside the case's PATH shim; set
  `PTY_REAL_NODE=/abs/path/to/node` to enable it (e.g. a Node that is not on
  `PATH` at all).
- `custom-endpoint` — `--write-model-config` writes `models.json` from the
  `HEDDLEWORK_OPENAI_*` variables, keeps an unrelated provider that is already in
  the file, stores the key in `auth.json`, and references it from the environment
  instead of inlining it. The endpoint is unreachable (nothing listens on
  `127.0.0.1:11434`), which is the entrypoint's situation, so the case runs with
  `HEDDLEWORK_OPENAI_CHECK=warn` and asserts the warning.
- `custom-endpoint-prompt` — the same endpoint collected interactively: every
  provider prompt declined, the default provider id and API flavor accepted, the
  endpoint verified, and the key never echoed to the terminal.
- `endpoint-check` — the connectivity check on its passing paths, against the
  stub endpoint in `mock-endpoint.py`: a model listing that serves every
  requested id, a credential the endpoint accepts, and a server with no listing
  at all, which the probe verifies through a one-token chat completion.
- `endpoint-check-fail` — every failing path: a model id the server does not
  serve, a closed port, a base URL with no scheme, an unknown model id on a
  listing-less server, and a rejected key each abort before `models.json` is
  written; `HEDDLEWORK_OPENAI_CHECK=warn` writes it anyway and says why.
- `desktop-launcher` — `packaging/linux/install-user.sh` completes on a PTY,
  stages binary/web/icon/launcher/desktop entry correctly, and the produced
  launcher executes through to the installed binary in the chosen workspace.

The PTY transcript for each case lands in `/tmp` and the runner asserts on it
(see `run-case.sh`). Cases that exercise the endpoint check start the stub server
in `mock-endpoint.py` on an ephemeral port and point `HEDDLEWORK_OPENAI_BASE_URL`
at it, so the check is verified against real HTTP rather than a mock of the
probe. Only the newest run of a case is left in the transcript, because the
runner truncates the log per invocation.

Extra arguments let a case build the stub it needs:

```bash
python3 tests/pty/mock-endpoint.py --port-file /tmp/port --models a,b \
  [--require-key KEY] [--no-models]
```
