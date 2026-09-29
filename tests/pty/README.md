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
- `custom-endpoint-basic` — an endpoint behind HTTP Basic auth: the probe
  authenticates with the username and password, `models.json` gets the
  `Basic` `Authorization` header and the placeholder `apiKey` instead of an
  `auth.json` entry, and a passed API key is reported as ignored.
- `custom-endpoint-basic-prompt` — the same credential collected interactively:
  the password goes through the hidden prompt, reaches the endpoint, and is
  never echoed to the terminal.
- `endpoint-roundtrip` — after the write, Pi itself is asked for a one-word
  answer with the provider and model the installer configured: the mock `pi`
  records the exact argv (provider, model, `--print`, and the flags that keep a
  session, tools, and startup network out of the request) and the case asserts
  the reply it reported. Then the tool check: the recorded argv shows
  `--mode json` and `--exclude-tools bash,edit,write`, and the answer is only
  accepted because it carries the token from the probe file, which no chat-only
  model could know. Then the agent turn: the recorded argv shows `--mode json`
  and only `--exclude-tools bash`, the prompt names the agent probe file, and
  the mock — which plays the model and its tools — really edits that file in the
  scratch working directory, so the installer reports it as read and edited.
  Also proves the stub's streaming path, which is what a real Pi asks for, and
  that `HEDDLEWORK_OPENAI_CHECK=off` skips every round trip.
- `endpoint-tool-call-no-file` — the shape a pi-fabric session produces: the
  endpoint returns a tool call, but the session's only tool cannot read the
  probe file. The install has to succeed on that weaker evidence, or the check
  would refuse a working endpoint; the case also asserts it is not reported as a
  failure.
- `endpoint-tool-roundtrip-fail` — a model that only chats (exit 0, no tool call
  anywhere in the stream) and an endpoint that rejects the `tools` field, both
  failing the install with the reason; `HEDDLEWORK_OPENAI_TOOL_CHECK=warn`
  installs anyway and names the knob, `off` skips the check while the chat round
  trip still runs, and a Pi whose `--help` lacks `--mode json` skips the check
  instead of failing an endpoint it cannot observe.
- `endpoint-agent-turn-fail` — the agent turn's other shapes: a turn that wrote
  the probe file without the contents it read passes as the write half alone, a
  turn that never edits anything fails in `require` mode (with the tool calls it
  did make acknowledged) while `HEDDLEWORK_OPENAI_AGENT_CHECK=warn` installs and
  names that knob, and `off` skips the turn while the tool call check still
  runs. The turn also follows the tool call check: with
  `HEDDLEWORK_OPENAI_TOOL_CHECK=off` and no agent knob nothing edits a file,
  and an explicit `HEDDLEWORK_OPENAI_AGENT_CHECK=require` runs it anyway.
- `endpoint-roundtrip-fail` — Pi's own error, a clean exit with no answer, and a
  Pi that never answers (bounded by `HEDDLEWORK_OPENAI_ANSWER_TIMEOUT`), each
  reported after the configuration was written: `require` refuses the endpoint
  while leaving the config, `warn` explains and installs.
- `endpoint-check` — the connectivity check on its passing paths, against the
  stub endpoint in `mock-endpoint.py`: a model listing that serves every
  requested id, a credential the endpoint accepts, and a server with no listing
  at all, which the probe verifies through a one-token chat completion.
- `endpoint-check-fail` — every failing path: a model id the server does not
  serve, a closed port, a base URL with no scheme, an unknown model id on a
  listing-less server, a rejected key, a rejected username/password pair, and
  half a pair each abort before `models.json` is written;
  `HEDDLEWORK_OPENAI_CHECK=warn` writes it anyway and says why.
- `desktop-launcher` — `packaging/linux/install-user.sh` completes on a PTY,
  stages binary/web/icon/launcher/desktop entry correctly, and the produced
  launcher executes through to the installed binary in the chosen workspace.

The PTY transcript for each case lands in `/tmp` and the runner asserts on it
(see `run-case.sh`). Cases that exercise the endpoint check start the stub server
in `mock-endpoint.py` on an ephemeral port and point `HEDDLEWORK_OPENAI_BASE_URL`
at it, so the check is verified against real HTTP rather than a mock of the
probe. The stub also streams server-sent events, the way a real endpoint answers
a streaming request.

The round trip through Pi uses the mock `pi` on the case's PATH. It answers a
`--print` run from the environment instead of a model:

```bash
PI_MOCK_ARGV_LOG=/path/to/argv.log   # append the argv it was called with
PI_MOCK_REPLY='pong'                 # what the "model" answers (empty is empty)
PI_MOCK_STDERR='No API key ...'      # text to write to stderr
PI_MOCK_EXIT=1                       # exit status
PI_MOCK_SLEEP=3                      # stall before answering
```

A run the installer makes with `--exclude-tools` is answered as a JSON event
stream instead, the way Pi streams one, and the prompt tells the two runs apart:
the tool check names `heddlework-tool-probe.txt`, the agent turn names
`heddlework-agent-probe.txt`. The tool check (a read-only run) with no knob set
reads the probe file back, so a case about something else still gets an endpoint
that works:

```bash
PI_MOCK_TOOL_READ=heddlework-tool-probe.txt  # tool call, answer is the file
PI_MOCK_TOOL_CALL=1                          # tool call, but nothing read
PI_MOCK_TOOL_REPLY='I cannot read it'        # no tool call: chat-only model
PI_MOCK_TOOL_STDERR='400: tools unsupported' # text to write to stderr
PI_MOCK_TOOL_EXIT=1                          # exit status for the run
PI_MOCK_LEGACY_HELP=1                        # --help missing --mode/--exclude-tools
```

The agent turn with no knob set plays the whole session: the mock emits a read
call and an edit call and performs the edit on the probe file in the working
directory, the way Pi would on the model's behalf. A case can narrow that:

```bash
PI_MOCK_AGENT_NO_EDIT=1                # a read-only turn: no edit at all
PI_MOCK_AGENT_BLIND=1                  # write the edit line over the file
PI_MOCK_AGENT_LINE='...'               # what the edit adds
PI_MOCK_AGENT_REPLY='...'              # what the turn answers (default: done)
PI_MOCK_AGENT_PROBE_FILE=...           # the file it edits, if a case renames it
```

Only the newest run of a case is left in the transcript, because the
runner truncates the log per invocation.

Extra arguments let a case build the stub it needs:

```bash
python3 tests/pty/mock-endpoint.py --port-file /tmp/port --models a,b \
  [--require-key KEY] [--require-basic USER:PASSWORD] [--no-models]
```
