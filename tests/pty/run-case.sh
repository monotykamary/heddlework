#!/usr/bin/env bash
# Drive install.sh interactive paths under a real PTY and assert on the result.
# The desktop-launcher case drives packaging/linux/install-user.sh instead.
# Usage: tests/pty/run-case.sh <case-name>
set -eu

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
CASE=${1:?usage: run-case.sh <case-name>}
WORK=$(mktemp -d)
LOG="$WORK/transcript.log"
PY=/usr/bin/python3

export PI_CODING_AGENT_DIR="$WORK/pi-agent"
export HEDDLEWORK_SKIP_SETUP=1
export HEDDLEWORK_NONINTERACTIVE=0
export PATH="$REPO/tests/pty:$PATH"
unset ANTHROPIC_API_KEY OPENAI_API_KEY || true
# The WSL sandbox has no Node; `need_node` only checks availability, so a
# mock keeps the pi-harness path reachable. Writing auth.json falls back to
# node, which must therefore also resolve (mock-pi handles any argv).
mkdir -p "$WORK/bin"
ln -sf "$REPO/tests/pty/mock-pi.sh" "$WORK/bin/pi"
ln -sf "$REPO/tests/pty/mock-pi.sh" "$WORK/bin/node"
export PATH="$WORK/bin:$PATH"

# The mocked `node` on PATH keeps `need_node` satisfied on machines that have no
# Node at all, but it cannot evaluate the installer's JSON writer. Resolve one
# real interpreter for the cases that assert on written files; they skip when
# there is none. Set PTY_REAL_NODE=/abs/path/to/node for a Node that is not on
# PATH at all (nvm, an unpacked tarball, ...).
if [ -n "${PTY_REAL_NODE:-}" ]; then
  :
else
  PTY_REAL_NODE=$(PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vx -- "$WORK/bin" | tr '\n' ':' | sed 's/:$//') \
    command -v node 2>/dev/null || true)
  [ -n "$PTY_REAL_NODE" ] && [ -x "$PTY_REAL_NODE" ] && export PTY_REAL_NODE || PTY_REAL_NODE=''
fi

need_real_node() { # need_real_node <case>
  if [ -z "${PTY_REAL_NODE:-}" ]; then
    printf 'SKIP(%s): no real JavaScript runtime outside the PATH shim (set PTY_REAL_NODE to enable)\n' "$1"
    exit 0
  fi
  ln -sf "$PTY_REAL_NODE" "$WORK/bin/node"
}

fail() { printf 'FAIL(%s): %s\n' "$CASE" "$*" >&2; exit 1; }
pass() { printf 'PASS(%s): %s\n' "$CASE" "$*"; }
CASE_HARNESS_ARGS=()
# One of: menu-default menu-pi hidden-input already-configured ctrl-c
#         eof-default bun-prompt-decline bun-install-accept auth-write
#         custom-endpoint custom-endpoint-prompt custom-endpoint-basic
#         custom-endpoint-basic-prompt endpoint-check endpoint-check-fail
#         endpoint-roundtrip endpoint-roundtrip-fail
#         endpoint-tool-roundtrip-fail endpoint-tool-call-no-file
#         endpoint-agent-turn-fail desktop-launcher

run_steps() { # steps-file extra-env...
  local steps=$1; shift
  env "$@" "$PY" "$REPO/tests/pty/pty-run.py" "$LOG" "$steps" -- \
    sh "$REPO/install.sh" "${CASE_HARNESS_ARGS[@]}"
}

# Start the OpenAI-compatible stub endpoint on an ephemeral port and resolve
# $ENDPOINT_URL from it. The installer's connectivity check talks to this
# instead of a real model server, so both the passing and failing paths can be
# asserted exactly. Stop it with stop_endpoint (or leave it to the EXIT trap).
start_endpoint() { # start_endpoint <models> [extra-mock-endpoint-args...]
  local models=$1; shift
  ENDPOINT_PORT_FILE="$WORK/endpoint-port"
  ENDPOINT_LOG="$WORK/endpoint.log"
  rm -f "$ENDPOINT_PORT_FILE"
  "$PY" "$REPO/tests/pty/mock-endpoint.py" \
    --port-file "$ENDPOINT_PORT_FILE" --models "$models" "$@" > "$ENDPOINT_LOG" 2>&1 &
  ENDPOINT_PID=$!
  for _ in $(seq 1 50); do
    [ -s "$ENDPOINT_PORT_FILE" ] && break
    sleep 0.1
  done
  [ -s "$ENDPOINT_PORT_FILE" ] || fail "mock endpoint did not report a port"
  ENDPOINT_PORT=$(cat "$ENDPOINT_PORT_FILE")
  ENDPOINT_URL="http://127.0.0.1:$ENDPOINT_PORT/v1"
}

stop_endpoint() {
  [ -n "${ENDPOINT_PID:-}" ] && kill "$ENDPOINT_PID" 2>/dev/null
  ENDPOINT_PID=''
}

# Capture the exit status of a run that is expected to fail.
run_failing_steps() { # steps-file extra-env...
  set +e
  run_steps "$@"
  RUN_STATUS=$?
  set -e
  [ "$RUN_STATUS" -ne 0 ] || fail "expected a non-zero exit, got 0"
}

# A port that nothing is listening on: bind the stub, keep its number, stop it.
dead_port() {
  start_endpoint "unused-model"
  DEAD_PORT=$ENDPOINT_PORT
  stop_endpoint
  ENDPOINT_URL="http://127.0.0.1:$DEAD_PORT/v1"
}

# ---------------------------------------------------------------------------
case "$CASE" in
  menu-default)
    CASE_HARNESS_ARGS=()
    printf 'WAIT:Choose [1/2\nENTER\n' > "$WORK/steps"
    # Bun is absent in WSL, so the heddle path continues into the Bun prompt;
    # the selection itself is proven by the harness line.
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=1 || true
    grep -aq 'harness: .*heddle' "$LOG" || fail "menu default did not select heddle"
    pass "Enter selected the heddle harness"
    ;;

  hidden-input)
    CASE_HARNESS_ARGS=(pi)
    printf 'WAIT:Configure anthropic\ny\nWAIT:input hidden\nsk-ant-SECRET-VALUE-123\n' > "$WORK/steps"
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=0 || true
    if grep -q 'sk-ant-SECRET-VALUE-123' "$LOG"; then
      fail "API key echoed to the terminal"
    fi
    grep -q 'anthropic key written' "$LOG" || fail "key was not accepted"
    pass "key hidden during input and accepted"
    ;;

  already-configured)
    CASE_HARNESS_ARGS=(pi)
    mkdir -p "$PI_CODING_AGENT_DIR"
    printf '{"anthropic":{"type":"api_key","key":"sk-existing"}}\n' > "$PI_CODING_AGENT_DIR/auth.json"
    printf 'WAIT:Configure anthropic\nENTER\n' > "$WORK/steps"
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=0 || true
    grep -q 'anthropic API key? \[already in' "$LOG" || fail "existing key not detected (node fallback)"
    pass "existing auth.json entry detected without bun"
    ;;

  # This case proves write_auth_entry against real Node (when available): the
  # mocked pi answers prompts, real node writes auth.json.
  #
  # The PATH shim above fakes node only so `need_node` passes, so look for a
  # real interpreter outside it. Set PTY_REAL_NODE=/abs/path/to/node to point
  # at one that is not on PATH at all (nvm, a tarball under /tmp, ...).
  auth-write)
    CASE_HARNESS_ARGS=(pi)
    need_real_node auth-write
    mkdir -p "$PI_CODING_AGENT_DIR"
    printf 'WAIT:Configure anthropic\ny\nWAIT:input hidden\nsk-ant-AUTHWRITE-1\nWAIT:Configure openai\nENTER\n' > "$WORK/steps"
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=0 || true
    grep -q 'anthropic key written' "$LOG" || fail "key was not accepted"
    grep -q '"type": "api_key"' "$PI_CODING_AGENT_DIR/auth.json" || fail "auth.json not written"
    grep -q 'sk-ant-AUTHWRITE-1' "$PI_CODING_AGENT_DIR/auth.json" || fail "auth.json missing the key"
    stat -c '%a' "$PI_CODING_AGENT_DIR/auth.json" | grep -Eq '^600$' || fail "auth.json is not 0600"
    pass "node fallback wrote auth.json with 0600"
    ;;

  # Custom OpenAI-compatible endpoint, environment-driven: --write-model-config
  # is the mode the container entrypoint uses, and it must leave an unrelated
  # provider that is already in models.json untouched.
  #
  # Nothing listens on 127.0.0.1:11434 here, which is the case the entrypoint
  # meets when the server it points at has not started yet: HEDDLEWORK_OPENAI_CHECK
  # =warn is exactly what it passes, so the config is still written (the passing
  # check is covered by endpoint-check and custom-endpoint-prompt).
  custom-endpoint)
    CASE_HARNESS_ARGS=(--write-model-config)
    need_real_node custom-endpoint
    mkdir -p "$PI_CODING_AGENT_DIR"
    printf '{"providers":{"existing":{"baseUrl":"http://example.test/v1","api":"openai-completions","models":[{"id":"keep-me"}]}}}\n' \
      > "$PI_CODING_AGENT_DIR/models.json"
    printf 'WAIT:custom-openai -> http://127.0.0.1:11434/v1\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="http://127.0.0.1:11434/v1" \
      HEDDLEWORK_OPENAI_MODEL="qwen2.5-coder:7b,llama3.1:8b" \
      HEDDLEWORK_OPENAI_KEY="sk-custom-ENV-1" \
      HEDDLEWORK_OPENAI_CHECK=warn || fail "--write-model-config exited non-zero"
    grep -q 'writing the endpoint anyway' "$LOG" \
      || fail "warn mode did not report the unreachable endpoint"

    models="$PI_CODING_AGENT_DIR/models.json"
    grep -q '"baseUrl": "http://127.0.0.1:11434/v1"' "$models" || fail "baseUrl missing from models.json"
    grep -q '"api": "openai-completions"' "$models" || fail "api flavor missing from models.json"
    grep -q '"id": "qwen2.5-coder:7b"' "$models" || fail "first model id missing"
    grep -q '"id": "llama3.1:8b"' "$models" || fail "second model id missing"
    grep -q '"id": "keep-me"' "$models" || fail "existing provider was dropped from models.json"
    grep -q '"apiKey": "${CUSTOM_OPENAI_API_KEY}"' "$models" || fail "endpoint key should be read from the environment, not inlined"
    [ "$(stat -c '%a' "$models")" = "600" ] || fail "models.json is not 0600"
    grep -q '"key": "sk-custom-ENV-1"' "$PI_CODING_AGENT_DIR/auth.json" || fail "endpoint key not stored in auth.json"
    pass "env endpoint wrote models.json, kept the existing provider, and stored the key"
    ;;

  # The same endpoint collected interactively: decline every provider prompt,
  # then accept the defaults for provider id and API flavor. The key is entered
  # through the hidden prompt, so it must never reach the terminal. The URL typed
  # at the prompt points at the stub endpoint, which also proves the connectivity
  # check runs on the interactive path (a closed port would abort the install).
  custom-endpoint-prompt)
    CASE_HARNESS_ARGS=(pi)
    need_real_node custom-endpoint-prompt
    trap 'stop_endpoint' EXIT
    start_endpoint "qwen2.5-coder:7b"
    mkdir -p "$PI_CODING_AGENT_DIR"
    {
      for provider in anthropic openai google xai openrouter groq cerebras mistral deepseek; do
        printf 'WAIT:Configure %s\nENTER\n' "$provider"
      done
      printf 'WAIT:Use a custom OpenAI-compatible base URL\ny\n'
      printf 'WAIT:Base URL\n%s\n' "$ENDPOINT_URL"
      printf 'WAIT:Model ID\nqwen2.5-coder:7b\n'
      printf 'WAIT:Provider ID\nENTER\n'
      printf 'WAIT:API flavor\nENTER\n'
      printf 'WAIT:Basic auth\nENTER\n'
      printf 'WAIT:API key\nsk-custom-PROMPT-1\n'
    } > "$WORK/steps"
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=0 || fail "interactive run exited non-zero"

    grep -q "endpoint check: ok" "$LOG" || fail "the prompted endpoint was not checked"
    grep -q "$ENDPOINT_URL serves all 1 requested model id" "$LOG" \
      || fail "the prompted endpoint was not reported as verified"
    grep -q "custom-openai -> $ENDPOINT_URL (api: openai-completions" "$LOG" \
      || fail "prompt did not fall back to the default provider id and API flavor"
    grep -q 'sk-custom-PROMPT-1' "$LOG" && fail "endpoint key echoed to the terminal"
    models="$PI_CODING_AGENT_DIR/models.json"
    grep -q '"id": "qwen2.5-coder:7b"' "$models" || fail "prompted model id missing from models.json"
    grep -q '"key": "sk-custom-PROMPT-1"' "$PI_CODING_AGENT_DIR/auth.json" || fail "prompted key not stored in auth.json"
    grep -q 'HEDDLEWORK_PROVIDER=custom-openai HEDDLEWORK_MODEL=qwen2.5-coder:7b' "$LOG" \
      || fail "next steps did not show how to launch the custom endpoint"
    pass "prompt collected the endpoint, checked it, kept the key hidden, and printed the launch hint"
    ;;

  # The connectivity check on its passing paths: the model listing answers, a
  # server without a listing is verified through a one-token chat completion, and
  # a credential the endpoint accepts is not mistaken for a failure.
  endpoint-check)
    CASE_HARNESS_ARGS=(--write-model-config)
    need_real_node endpoint-check
    trap 'stop_endpoint' EXIT
    start_endpoint "qwen2.5-coder:7b,llama3.1:8b"
    models="$PI_CODING_AGENT_DIR/models.json"

    printf 'WAIT:endpoint check: ok\nWAIT:custom-openai ->\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL="qwen2.5-coder:7b,llama3.1:8b" \
      HEDDLEWORK_OPENAI_KEY="sk-check-OK-1" || fail "a reachable endpoint was rejected"
    grep -q "$ENDPOINT_URL serves all 2 requested model id" "$LOG" \
      || fail "the model listing was not verified"
    grep -q 'GET /v1/models' "$ENDPOINT_LOG" || fail "the probe did not request the model listing"
    grep -q '"id": "llama3.1:8b"' "$models" || fail "models.json missing the verified model ids"
    grep -q '"key": "sk-check-OK-1"' "$PI_CODING_AGENT_DIR/auth.json" || fail "auth.json missing the key"

    # A key the endpoint rejects must be a failure, not a false pass.
    stop_endpoint
    start_endpoint "qwen2.5-coder:7b" --require-key sk-right-1
    printf 'WAIT:endpoint check: ok\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-right-1 || fail "an accepted credential failed the check"

    # No listing at all: the probe falls back to the route Pi will use.
    stop_endpoint
    start_endpoint "qwen2.5-coder:7b" --no-models
    printf 'WAIT:answered a chat completion\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-check-OK-1 || fail "the chat fallback did not verify the endpoint"
    grep -q 'trying a one-token chat completion instead' "$LOG" \
      || fail "the probe did not fall back to a chat completion"
    grep -q 'POST /v1/chat/completions -> 200' "$ENDPOINT_LOG" || fail "no chat completion was attempted"
    pass "listing, credential, and listing-less endpoints all verified"
    ;;

  # An endpoint behind HTTP Basic auth: Pi cannot send Basic through an API key,
  # so the credential becomes an Authorization header in models.json. A proxy
  # asking for Basic rejects a bearer token, so the probe authenticates the same
  # way, and half a credential pair is refused before anything is written.
  custom-endpoint-basic)
    CASE_HARNESS_ARGS=(--write-model-config)
    need_real_node custom-endpoint-basic
    trap 'stop_endpoint' EXIT
    start_endpoint "qwen2.5-coder:7b" --require-basic ops:secret
    models="$PI_CODING_AGENT_DIR/models.json"
    expected=$("$PY" -c 'import base64; print(base64.b64encode(b"ops:secret").decode())')

    # A key is also passed to prove it loses to the Basic credential.
    printf 'WAIT:endpoint check: ok\nWAIT:custom-openai ->\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_USERNAME=ops \
      HEDDLEWORK_OPENAI_PASSWORD=secret \
      HEDDLEWORK_OPENAI_KEY=sk-ignored-1 || fail "basic-auth endpoint failed its check"

    grep -q "GET /v1/models -> 200 auth=basic(ops:secret)" "$ENDPOINT_LOG" \
      || fail "the probe did not authenticate with HTTP Basic"
    grep -q "\"Authorization\": \"Basic $expected\"" "$models" \
      || fail "models.json is missing the Basic Authorization header"
    grep -q '"apiKey": "local"' "$models" \
      || fail "the placeholder apiKey that keeps the model selectable is missing"
    grep -q 'sk-ignored-1' "$models" && fail "the ignored API key leaked into models.json"
    grep -q 'HTTP Basic auth is configured, so the API key is ignored' "$LOG" \
      || fail "the ignored API key was not reported"
    if [ -f "$PI_CODING_AGENT_DIR/auth.json" ]; then
      grep -q 'custom-openai' "$PI_CODING_AGENT_DIR/auth.json" \
        && fail "basic auth should not store an auth.json entry"
    fi
    grep -q "HTTP Basic auth for 'ops' is an Authorization header" "$LOG" \
      || fail "the stored credential was not explained"
    pass "the endpoint was verified with HTTP Basic and written as a header"
    ;;

  # The Basic credential collected interactively: the password goes through the
  # hidden prompt, so it must never reach the terminal.
  custom-endpoint-basic-prompt)
    CASE_HARNESS_ARGS=(pi)
    need_real_node custom-endpoint-basic-prompt
    trap 'stop_endpoint' EXIT
    start_endpoint "qwen2.5-coder:7b" --require-basic "ops:pw-BASIC-PROMPT-9"
    expected=$("$PY" -c 'import base64; print(base64.b64encode(b"ops:pw-BASIC-PROMPT-9").decode())')
    mkdir -p "$PI_CODING_AGENT_DIR"
    {
      for provider in anthropic openai google xai openrouter groq cerebras mistral deepseek; do
        printf 'WAIT:Configure %s\nENTER\n' "$provider"
      done
      printf 'WAIT:Use a custom OpenAI-compatible base URL\ny\n'
      printf 'WAIT:Base URL\n%s\n' "$ENDPOINT_URL"
      printf 'WAIT:Model ID\nqwen2.5-coder:7b\n'
      printf 'WAIT:Provider ID\nENTER\n'
      printf 'WAIT:API flavor\nENTER\n'
      printf 'WAIT:Basic auth\ny\n'
      printf 'WAIT:Username\nops\n'
      printf 'WAIT:Password\npw-BASIC-PROMPT-9\n'
    } > "$WORK/steps"
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=0 || fail "interactive run exited non-zero"

    grep -q 'GET /v1/models -> 200 auth=basic(ops:pw-BASIC-PROMPT-9)' "$ENDPOINT_LOG" \
      || fail "the prompted credential did not reach the endpoint"
    grep -q 'pw-BASIC-PROMPT-9' "$LOG" && fail "the password was echoed to the terminal"
    models="$PI_CODING_AGENT_DIR/models.json"
    grep -q "\"Authorization\": \"Basic $expected\"" "$models" \
      || fail "models.json is missing the Basic header"
    pass "prompt collected username and password, kept the password hidden, and verified it"
    ;;

  # The round trips through Pi: after writing the configuration, the installer
  # asks the actual CLI for a one-word answer with the provider and model it just
  # wrote, then for a tool call, then for a whole agent turn, so a configuration
  # Pi cannot use is reported here, with the model's words, instead of at the
  # first prompt. The mock pi answers from the environment and records the argv
  # it was handed.
  endpoint-roundtrip)
    CASE_HARNESS_ARGS=(--write-model-config)
    need_real_node endpoint-roundtrip
    trap 'stop_endpoint' EXIT
    start_endpoint "qwen2.5-coder:7b"
    : > "$WORK/pi-argv.log"

    printf 'WAIT:and read the file back\nWAIT:custom-openai ->\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-roundtrip-1 \
      PI_MOCK_ARGV_LOG="$WORK/pi-argv.log" \
      PI_MOCK_TOOL_READ=heddlework-tool-probe.txt || fail "the round trips failed"
    grep -q 'asking Pi for a one-word answer through custom-openai/qwen2.5-coder:7b' "$LOG" \
      || fail "the chat round trip was not announced"
    grep -q 'Pi answered "pong"' "$LOG" || fail "the answer was not reported"

    # The chat check must ask for the provider and model it wrote, without
    # touching sessions, tools, or the network beyond the endpoint.
    argv=$(cat "$WORK/pi-argv.log")
    printf '%s\n' "$argv" | grep -q -- '--provider custom-openai --model qwen2.5-coder:7b' \
      || fail "the round trips did not use the configured provider and model: $argv"
    printf '%s\n' "$argv" | grep -q -- '--print Reply with the single word: pong' \
      || fail "the chat round trip did not ask the one-word question: $argv"
    printf '%s\n' "$argv" | grep -q -- '--no-session' || fail "--no-session was not passed: $argv"
    printf '%s\n' "$argv" | grep -q -- '--no-tools' || fail "--no-tools was not passed: $argv"
    printf '%s\n' "$argv" | grep -q -- '--offline' || fail "--offline was not passed: $argv"
    [ -s "$PI_CODING_AGENT_DIR/models.json" ] || fail "the configuration was not written"

    # The tool check asks Pi to read a scratch file — in JSON mode, so the tool
    # call is observable, and with the effectful built-ins excluded, so the probe
    # cannot modify anything — and accepts the answer only when it carries the
    # token that file holds, which no chat-only model could know.
    printf '%s\n' "$argv" | grep -q -- '--mode json' \
      || fail "the tool check did not ask for JSON mode: $argv"
    printf '%s\n' "$argv" | grep -q -- '--exclude-tools bash,edit,write' \
      || fail "the tool check did not exclude the effectful tools: $argv"
    printf '%s\n' "$argv" | grep -q -- '--print Read the file heddlework-tool-probe.txt' \
      || fail "the tool check did not name the probe file: $argv"
    grep -q 'asking Pi to read a file with its read-only tools through custom-openai/qwen2.5-coder:7b' "$LOG" \
      || fail "the tool check was not announced"
    # The token the mock answered with can only have come from the probe file the
    # installer created in its scratch directory, so its presence is the proof.
    grep -q 'Pi called a tool and read the file back — it answered "heddlework-tool-check-' "$LOG" \
      || fail "the tool call answer was not reported:" "$(tr -d '\r' < "$LOG" | grep -a 'tool' | head -3)"

    # The agent turn is the session an editor actually runs — read a file, then
    # edit it — so this time the shell alone stays excluded and the mock, which
    # plays the model and its tools, really edits the probe file in the scratch
    # working directory. The file changing is the proof, and the token it had to
    # read surviving the edit is what proves the read half too.
    printf '%s\n' "$argv" | grep -q -- '--mode json --exclude-tools bash --' \
      || fail "the agent turn did not run in JSON mode with only the shell excluded: $argv"
    printf '%s\n' "$argv" | grep -q -- '--print Read the file heddlework-agent-probe.txt' \
      || fail "the agent turn did not ask for the probe file to be read: $argv"
    grep -q 'asking Pi to read a file and edit it through custom-openai/qwen2.5-coder:7b' "$LOG" \
      || fail "the agent turn was not announced"
    grep -q 'Pi read the file and edited it back — it answered "done"' "$LOG" \
      || fail "the agent turn did not report the file as read and edited"

    # A real Pi asks for a server-sent-event stream, which is why the stub answers
    # one; prove that route streams and terminates the way Pi expects.
    curl -sS -N -H 'Content-Type: application/json' \
      -d '{"model":"qwen2.5-coder:7b","messages":[{"role":"user","content":"hi"}],"stream":true}' \
      "$ENDPOINT_URL/chat/completions" > "$WORK/stream.out" || fail "the stub refused a streaming request"
    grep -q '"object": "chat.completion.chunk"' "$WORK/stream.out" || fail "the stub did not stream chunks"
    grep -q 'data: \[DONE\]' "$WORK/stream.out" || fail "the stub stream did not end with [DONE]"

    # off skips the round trip along with the HTTP probe.
    : > "$WORK/pi-argv.log"
    printf 'WAIT:without testing it\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_CHECK=off \
      PI_MOCK_ARGV_LOG="$WORK/pi-argv.log" || fail "off mode exited non-zero"
    [ -s "$WORK/pi-argv.log" ] && fail "off mode still ran Pi"
    pass "Pi answered, then read a file through a tool call, then read and edited a file — with the written provider and model"
    ;;

  # A pi-fabric session registers one tool (fabric_exec) that cannot read the
  # probe file, so the strongest evidence is out of reach there even though the
  # endpoint does return tool calls. The weaker evidence — a tool call Pi
  # dispatched and carried a result back for — has to be enough, or the check
  # would refuse a working endpoint. This is the shape the container's seeded
  # agent directory produces.
  endpoint-tool-call-no-file)
    CASE_HARNESS_ARGS=(--write-model-config)
    need_real_node endpoint-tool-call-no-file
    trap 'stop_endpoint' EXIT
    start_endpoint "qwen2.5-coder:7b"
    : > "$WORK/pi-argv.log"

    printf 'WAIT:returned a tool call and Pi carried its result back\nWAIT:custom-openai ->\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-tool-2 \
      PI_MOCK_ARGV_LOG="$WORK/pi-argv.log" \
      PI_MOCK_TOOL_CALL=1 \
      PI_MOCK_TOOL_REPLY='I cannot read files.' || fail "a tool call without a file read should still install"
    grep -q 'the endpoint returned a tool call and Pi carried its result back' "$LOG" \
      || fail "the tool call was not reported as the proof"
    grep -q 'no tool of this Pi could read the probe file' "$LOG" \
      || fail "the check did not explain why the file itself was not read"
    grep -q 'never returned a tool call' "$LOG" && fail "a dispatched tool call was reported as a failure"
    [ -s "$PI_CODING_AGENT_DIR/models.json" ] || fail "the configuration was not written"
    pass "a tool call that could not read the probe file still proved tool support"
    ;;

  # An endpoint that answers chat but never returns a tool call: an agent session
  # would stall on the first thing it needs to do. HEDDLEWORK_OPENAI_TOOL_CHECK is
  # the narrow escape for an endpoint deliberately run chat-only.
  endpoint-tool-roundtrip-fail)
    CASE_HARNESS_ARGS=(--write-model-config)
    need_real_node endpoint-tool-roundtrip-fail
    trap 'stop_endpoint' EXIT
    start_endpoint "qwen2.5-coder:7b"
    common_url="HEDDLEWORK_OPENAI_BASE_URL=$ENDPOINT_URL"
    : > "$WORK/pi-argv.log"

    # A model that only chats: Pi exits 0 with an answer, no tool call anywhere
    # in the stream, and the tools it was offered unused.
    printf 'WAIT:never returned a tool call\n' > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-tool-1 \
      PI_MOCK_ARGV_LOG="$WORK/pi-argv.log" \
      PI_MOCK_TOOL_REPLY='I cannot read files.'
    grep -q 'answered without calling any tool — "I cannot read files."' "$LOG" \
      || fail "an answer with no tool call was not reported as such"
    grep -q 'a model that only chats cannot run an agent session' "$LOG" \
      || fail "the consequence was not explained"
    # The chat check still has to pass first, or this failure would be its own.
    grep -q 'Pi answered "pong"' "$LOG" || fail "the chat round trip did not run before the tool check"

    # The escape hatch: warn reports the same thing and installs.
    printf 'WAIT:HEDDLEWORK_OPENAI_TOOL_CHECK=warn\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-tool-1 \
      HEDDLEWORK_OPENAI_TOOL_CHECK=warn \
      PI_MOCK_TOOL_REPLY='I cannot read files.' || fail "tool check warn mode should still install"
    grep -q 'continuing anyway (HEDDLEWORK_OPENAI_TOOL_CHECK=warn)' "$LOG" \
      || fail "warn mode did not name the knob that controls it"
    [ -s "$PI_CODING_AGENT_DIR/models.json" ] || fail "warn mode should have written the config"

    # off skips the tool check while the chat round trip still runs.
    : > "$WORK/pi-argv.log"
    printf 'WAIT:not proving that the endpoint answers tool calls\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-tool-1 \
      HEDDLEWORK_OPENAI_TOOL_CHECK=off \
      PI_MOCK_ARGV_LOG="$WORK/pi-argv.log" || fail "tool check off mode exited non-zero"
    grep -q 'Pi answered "pong"' "$LOG" || fail "off mode should still run the chat round trip"
    grep -q -- '--mode json' "$WORK/pi-argv.log" && fail "off mode still ran the tool check"

    # A Pi build too old for JSON mode or --exclude-tools cannot be judged: the
    # check skips itself rather than failing an endpoint it cannot observe.
    printf 'WAIT:skipped the tool call check\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-tool-1 \
      PI_MOCK_LEGACY_HELP=1 || fail "a Pi without --mode json should still install"
    grep -q 'has no --mode json to observe tool calls with' "$LOG" \
      || fail "the skip was not explained"

    # An endpoint that rejects the tools field outright: Pi's own error is what
    # the user needs, since the listing and plain chat both worked.
    printf 'WAIT:request with tools failed\n' > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-tool-1 \
      PI_MOCK_TOOL_EXIT=1 \
      PI_MOCK_TOOL_STDERR='400: tools are not supported by this deployment'
    grep -q "Pi's request with tools failed through custom-openai: 400: tools are not supported by this deployment" "$LOG" \
      || fail "the endpoint's own tools error was not reported"
    grep -q 'a server that rejects the tools field cannot drive an agent session' "$LOG" \
      || fail "the consequence of rejecting tools was not explained"
    pass "a chat-only model and a rejected tools field both failed the install, and the escape hatches worked"
    ;;

  # The agent turn's other shapes. Proving a whole turn must not invent failures:
  # a turn that wrote the file but lost the contents it read still shows the
  # endpoint can edit, an endpoint that never edits is caught, and the knobs have
  # to line up — the turn follows the tool call check, which is what makes an
  # edit meaningful, and HEDDLEWORK_OPENAI_AGENT_CHECK can ask for it anyway.
  endpoint-agent-turn-fail)
    CASE_HARNESS_ARGS=(--write-model-config)
    need_real_node endpoint-agent-turn-fail
    trap 'stop_endpoint' EXIT
    start_endpoint "qwen2.5-coder:7b"
    common_url="HEDDLEWORK_OPENAI_BASE_URL=$ENDPOINT_URL"
    argv_log="$WORK/pi-argv.log"

    # A blind write: the file changed, so the endpoint edits files, but the token
    # the turn had to read back did not survive — the write half alone, which is
    # not a failure.
    printf 'WAIT:only the write half\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-agent-1 \
      PI_MOCK_AGENT_BLIND=1 || fail "a write-only turn should still install"
    grep -q 'Pi edited the probe file' "$LOG" || fail "the write was not reported"
    grep -q 'did not survive that edit, so only the write half of the turn is proven' "$LOG" \
      || fail "the lost read was not reported"

    # A turn that never edits anything: the session an editor runs would do
    # nothing at all, so require mode refuses the endpoint.
    printf 'WAIT:without editing the probe file\n' > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-agent-1 \
      PI_MOCK_AGENT_NO_EDIT=1
    grep -q 'Pi finished the turn without editing the probe file — "I have not changed the file."' "$LOG" \
      || fail "a turn that never edited was not reported"
    grep -q 'a session that has to change a file would do nothing' "$LOG" \
      || fail "the consequence was not explained"
    grep -q 'it did return tool calls, so the endpoint drives tools; it just never wrote this file' "$LOG" \
      || fail "the tool calls the turn did make were not acknowledged"
    grep -q 'the endpoint could not finish a turn that edits a file' "$LOG" \
      || fail "require mode did not refuse the endpoint"
    [ -s "$PI_CODING_AGENT_DIR/models.json" ] || fail "the agent turn should run after the write, not instead of it"

    # warn reports the same thing and installs, naming the knob it takes.
    printf 'WAIT:HEDDLEWORK_OPENAI_AGENT_CHECK=warn\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-agent-1 \
      HEDDLEWORK_OPENAI_AGENT_CHECK=warn \
      PI_MOCK_AGENT_NO_EDIT=1 || fail "agent check warn mode should still install"
    grep -q 'continuing anyway (HEDDLEWORK_OPENAI_AGENT_CHECK=warn)' "$LOG" \
      || fail "warn mode did not name the knob that controls the agent turn"

    # off skips the turn while the tool call check still runs.
    : > "$argv_log"
    printf 'WAIT:not proving that the endpoint can read a file and edit it\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-agent-1 \
      HEDDLEWORK_OPENAI_AGENT_CHECK=off \
      PI_MOCK_ARGV_LOG="$argv_log" || fail "agent check off mode exited non-zero"
    grep -q 'asking Pi to read a file and edit it' "$LOG" && fail "off mode still ran the agent turn"
    grep -q -- '--exclude-tools bash,edit,write' "$argv_log" \
      || fail "off mode should still run the tool call check: $(cat "$argv_log")"

    # The turn follows the tool call check, because an edit is only meaningful
    # once a tool call has been proven: with that check off and no agent knob,
    # nothing asks for a file to be edited.
    : > "$argv_log"
    printf 'WAIT:not proving that the endpoint answers tool calls\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-agent-1 \
      HEDDLEWORK_OPENAI_TOOL_CHECK=off \
      PI_MOCK_ARGV_LOG="$argv_log" || fail "tool check off mode exited non-zero"
    grep -q 'asking Pi to read a file and edit it' "$LOG" \
      && fail "the agent turn ran although the tool call check was off"

    # ... unless the agent knob asks for the turn by name.
    printf 'WAIT:read the file and edited it back\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-agent-1 \
      HEDDLEWORK_OPENAI_TOOL_CHECK=off \
      HEDDLEWORK_OPENAI_AGENT_CHECK=require \
      PI_MOCK_ARGV_LOG="$argv_log" || fail "an explicit agent check should run the turn"
    grep -q 'Pi read the file and edited it back' "$LOG" \
      || fail "an explicit agent check did not prove the turn"

    # A Pi build too old for --mode json is not judged on a turn it cannot
    # observe, the same way the tool call check is not.
    printf 'WAIT:skipped the agent turn check\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-agent-1 \
      HEDDLEWORK_OPENAI_AGENT_CHECK=require \
      PI_MOCK_LEGACY_HELP=1 || fail "a Pi without --mode json should still install"
    grep -q 'has no --mode json to observe the turn with' "$LOG" \
      || fail "the agent turn skip was not explained"
    pass "a write-only turn passed, a turn that never edited failed, and the agent knob gated the turn"
    ;;

  # What the round trip reports when Pi cannot use the endpoint: its own error,
  # an empty answer, and an endpoint that never answers at all. All of them come
  # after the write, so require mode refuses the endpoint while the report keeps
  # the configuration that the HTTP probe already accepted.
  endpoint-roundtrip-fail)
    CASE_HARNESS_ARGS=(--write-model-config)
    need_real_node endpoint-roundtrip-fail
    trap 'stop_endpoint' EXIT
    start_endpoint "qwen2.5-coder:7b"
    models="$PI_CODING_AGENT_DIR/models.json"
    common_url="HEDDLEWORK_OPENAI_BASE_URL=$ENDPOINT_URL"

    # Pi exits non-zero with a credential error of its own.
    printf 'WAIT:could not complete a request\n' > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-roundtrip-2 \
      PI_MOCK_EXIT=1 \
      PI_MOCK_STDERR='No API key for provider: custom-openai'
    grep -q 'Pi could not complete a request through custom-openai: No API key for provider: custom-openai' "$LOG" \
      || fail "Pi's own error was not reported"
    grep -q 'the endpoint answered but Pi could not complete a request through it' "$LOG" \
      || fail "require mode did not refuse the endpoint"
    [ -s "$models" ] || fail "the round trip should run after the write, not instead of it"

    # warn reports the same failure and installs anyway.
    printf 'WAIT:continuing anyway\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-roundtrip-2 \
      HEDDLEWORK_OPENAI_CHECK=warn \
      PI_MOCK_EXIT=1 \
      PI_MOCK_STDERR='No API key for provider: custom-openai' || fail "warn mode should still install"
    grep -q 'continuing anyway (HEDDLEWORK_OPENAI_CHECK=warn); Pi will fail at the first prompt while this persists' "$LOG" \
      || fail "warn mode did not explain the consequence"

    # A clean exit with nothing to say is not an answer either.
    printf 'WAIT:returned no answer\n' > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-roundtrip-2 \
      PI_MOCK_REPLY=''
    grep -q 'Pi completed the request but returned no answer' "$LOG" \
      || fail "an empty answer was taken for success"

    # An endpoint that accepts the connection and never answers is bounded by the
    # answer timeout instead of hanging the install.
    printf 'WAIT:did not answer within 1s\n' > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      "$common_url" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-roundtrip-2 \
      HEDDLEWORK_OPENAI_ANSWER_TIMEOUT=1 \
      PI_MOCK_SLEEP=3
    grep -q 'raise HEDDLEWORK_OPENAI_ANSWER_TIMEOUT' "$LOG" \
      || fail "the timeout did not point at the knob that raises it"
    pass "Pi's error, an empty answer, and a stalled endpoint were all reported without losing the config"
    ;;

  # Every way the check fails: a model id the server does not serve, a closed
  # port, and a rejected credential all abort a require-mode install before any
  # configuration is written, while warn mode writes it and explains. The chat
  # fallback catches an unknown model id on a server with no listing.
  endpoint-check-fail)
    CASE_HARNESS_ARGS=(--write-model-config)
    need_real_node endpoint-check-fail
    trap 'stop_endpoint' EXIT
    start_endpoint "qwen2.5-coder:7b"
    models="$PI_CODING_AGENT_DIR/models.json"

    # An unknown model id is the failure the check exists for: nothing may be
    # written, so the file must not even exist yet.
    printf 'WAIT:does not serve: mistral-small:24b\nWAIT:it offers: qwen2.5-coder:7b\n' > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b,mistral-small:24b
    grep -q 'refusing to write an endpoint' "$LOG" || fail "the failure was not explained"
    [ -f "$models" ] && fail "a refused endpoint still wrote models.json"

    # warn is the escape hatch used by the container entrypoint: write it and
    # say what is wrong.
    printf 'WAIT:writing the endpoint anyway\nWAIT:custom-openai ->\n' > "$WORK/steps"
    run_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b,mistral-small:24b \
      HEDDLEWORK_OPENAI_CHECK=warn || fail "warn mode should still write the config"
    grep -q '"id": "mistral-small:24b"' "$models" || fail "warn mode did not write the config"

    # A port with nothing behind it, after the stub bound it and stopped.
    dead_port
    printf 'WAIT:cannot reach %s/models\n' "$ENDPOINT_URL" > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b
    grep -q "cannot reach $ENDPOINT_URL/models" "$LOG" || fail "the unreachable endpoint was not reported"
    grep -q "$ENDPOINT_URL" "$models" && fail "an unreachable endpoint overwrote models.json"

    # A base URL without a scheme is the same mistake a user makes by hand.
    printf "WAIT:endpoint check: '127.0.0.1:11434/v1' has no http\n" > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="127.0.0.1:11434/v1" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b
    grep -q "endpoint check: '127.0.0.1:11434/v1' has no http:// or https:// scheme" "$LOG" \
      || fail "a schemeless base URL passed the check"

    # A listing-less server: only the chat completion proves the model id, and
    # its error message is the one a user would otherwise see inside Pi.
    start_endpoint "qwen2.5-coder:7b" --no-models
    printf 'WAIT:refused a chat completion\n' > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=nope-1:7b
    grep -q 'The model `nope-1:7b` does not exist' "$LOG" \
      || fail "the endpoint's own model error was not surfaced"

    # A key the endpoint rejects is reported as such rather than as a bad URL.
    stop_endpoint
    start_endpoint "qwen2.5-coder:7b" --require-key sk-right-1
    printf 'WAIT:rejected the credential\n' > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_KEY=sk-wrong-1
    grep -q 'HTTP 401' "$LOG" || fail "the rejected credential was not reported"
    grep -q 'invalid api key' "$LOG" || fail "the endpoint's own auth error was not surfaced"

    # The same for a username and password the endpoint rejects, and for half a
    # pair, which cannot authenticate at all and is refused before the probe.
    stop_endpoint
    start_endpoint "qwen2.5-coder:7b" --require-basic ops:secret
    printf 'WAIT:rejected the username and password\n' > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_USERNAME=ops \
      HEDDLEWORK_OPENAI_PASSWORD=wrong-secret
    grep -q 'GET /v1/models -> 401 auth=basic(ops:wrong-secret)' "$ENDPOINT_LOG" \
      || fail "the probe did not try the given credentials"
    grep -q 'invalid username or password' "$LOG" \
      || fail "the endpoint's own auth error was not surfaced for Basic auth"
    grep -q 'wrong-secret' "$models" && fail "a refused credential still wrote models.json"

    printf 'WAIT:HEDDLEWORK_OPENAI_PASSWORD is required\n' > "$WORK/steps"
    run_failing_steps "$WORK/steps" \
      HEDDLEWORK_OPENAI_BASE_URL="$ENDPOINT_URL" \
      HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b \
      HEDDLEWORK_OPENAI_USERNAME=ops
    grep -q 'HEDDLEWORK_OPENAI_PASSWORD is required alongside HEDDLEWORK_OPENAI_USERNAME' "$LOG" \
      || fail "half a credential pair was accepted"
    pass "missing model id, closed port, no scheme, a rejected key, a rejected password, and half a pair all aborted before writing"
    ;;

  ctrl-c)
    CASE_HARNESS_ARGS=(pi)
    printf 'WAIT:input hidden\ny-never-sent\nCTRLC\n' > "$WORK/steps"
    set +e
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=0
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then
      fail "installer exited 0 after Ctrl-C"
    fi
    grep -q '^\^\?C' "$LOG" || true # terminal shows the interrupt; no assert needed
    pass "Ctrl-C during hidden input exited non-zero"
    # Invariant: nothing crashed with an unset-variable error.
    if grep -q 'unbound variable\|not found.*stty' "$LOG"; then
      fail "unexpected error during Ctrl-C handling"
    fi
    ;;

  menu-pi)
    CASE_HARNESS_ARGS=()
    # Option 2 selects the pi + fabric harness; SKIP_PROVIDERS keeps the case
    # to the selection itself (fabric install output is the final proof).
    printf 'WAIT:Choose [1/2\n2\nWAIT:pi-fabric\nENTER\n' > "$WORK/steps"
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=1 || true
    grep -aq 'harness: .*pi' "$LOG" || fail "option 2 did not select pi"
    grep -aq 'Installing pi-fabric' "$LOG" || fail "fabric install did not run"
    pass "option 2 selected the pi + fabric harness"
    ;;

  bun-prompt-decline)
    CASE_HARNESS_ARGS=()
    # Decline the Bun install at the heddle path's need_bun prompt.
    printf 'WAIT:Choose [1/2\nENTER\nWAIT:Bun 1.3\nENTER\n' > "$WORK/steps"
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=1 || true
    grep -aq 'install Bun from https://bun.sh' "$LOG" || fail "decline did not warn"
    grep -aq 'Bun is required for the Heddlework harness' "$LOG" || fail "installer did not stop after decline"
    # The prompt itself mentions curl; a real invocation echoes `curl-mock:`.
    grep -aq 'curl-mock:' "$LOG" && fail "installer ran curl after decline"
    pass "declining the Bun prompt stops cleanly without installing"
    ;;

  bun-install-accept)
    CASE_HARNESS_ARGS=()
    # Accept the Bun install with a mocked curl (records the invocation and
    # exits 0); bun remains absent, so the flow then stops with the usual error.
    printf 'WAIT:Choose [1/2\nENTER\nWAIT:Bun 1.3\ny\n' > "$WORK/steps"
    cat > "$WORK/bin/curl" <<'STUB'
#!/bin/sh
echo "curl-mock: $*" >> "${CURL_LOG:?}"
exit 0
STUB
    chmod 755 "$WORK/bin/curl"
    : > "$WORK/curl.log"
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=1 CURL_LOG="$WORK/curl.log" || true
    if [ -s "$WORK/curl.log" ]; then
      pass "accepting the prompt attempted the Bun install (curl mocked)"
    else
      fail "accepting the prompt did not run the Bun installer"
    fi
    ;;

  # The desktop launcher installer is non-interactive, but running it under a
  # PTY proves it completes on a terminal (no hidden prompt) and that its
  # staged inputs (absolute pi path, built binary, web dir) compose with the
  # mock environment install.sh uses. Ends by EXECUTING the produced launcher.
  # This case drives packaging/linux/install-user.sh directly, not install.sh.
  desktop-launcher)
    mkdir -p "$WORK/bin-launch" "$WORK/ws" "$WORK/fake-dist/web"
    cat > "$WORK/fake-dist/heddlework" <<'FAKE'
#!/bin/sh
printf 'fake-heddlework-executed cwd=%s args=%s\n' "$PWD" "$*"
FAKE
    chmod 755 "$WORK/fake-dist/heddlework"
    printf '<!doctype html><title>fake web</title>' > "$WORK/fake-dist/web/index.html"
    printf 'WAIT:Installed Heddlework\nEOF\n' > "$WORK/steps"
    env HEDDLEWORK_BUILD="$WORK/fake-dist/heddlework" \
      XDG_DATA_HOME="$WORK/xdg-data" \
      HEDDLEWORK_BIN_DIR="$WORK/bin-launch" \
      HEDDLEWORK_APP_DIR="$WORK/app" \
      "$PY" "$REPO/tests/pty/pty-run.py" "$LOG" "$WORK/steps" -- \
      sh "$REPO/packaging/linux/install-user.sh" || fail "installer exited non-zero"

    [ -x "$WORK/app/heddlework" ] || fail "binary not installed"
    cmp -s "$WORK/app/heddlework" "$WORK/fake-dist/heddlework" || fail "installed binary differs from build"
    [ -f "$WORK/app/web/index.html" ] || fail "web companion not copied"
    icon="$WORK/xdg-data/icons/hicolor/scalable/apps/io.github.monotykamary.heddlework.svg"
    [ -f "$icon" ] || fail "icon not installed"

    launcher="$WORK/bin-launch/heddlework"
    [ -f "$launcher" ] || fail "launcher missing"
    [ "$(stat -c '%a' "$launcher")" = "700" ] || fail "launcher is not 0700"
    grep -q "export HEDDLEWORK_PI='$WORK/bin/pi'" "$launcher" || fail "launcher did not capture the mock pi path"
    sh -n "$launcher" || fail "launcher is not valid shell"

    desktop="$WORK/xdg-data/applications/io.github.monotykamary.heddlework.desktop"
    [ -f "$desktop" ] || fail "desktop entry missing"
    [ "$(stat -c '%a' "$desktop")" = "600" ] || fail "desktop entry is not 0600"
    grep -q '@HEDDLEWORK_EXEC@' "$desktop" && fail "desktop entry still contains the template placeholder"
    grep -q "Exec=\"$launcher\"" "$desktop" || fail "desktop Exec does not point at the launcher"

    # The chain end-to-end: launcher honors HEDDLEWORK_WORKSPACE (cd) and
    # execs the installed binary with forwarded arguments.
    out=$(HEDDLEWORK_WORKSPACE="$WORK/ws" "$launcher" --flag-one)
    printf '%s\n' "$out" | grep -q "fake-heddlework-executed cwd=$WORK/ws args=--flag-one" \
      || fail "launcher execution chain broken: $out"
    pass "desktop launcher installed, staged, and executes through to the binary"
    ;;

  eof-default)
    CASE_HARNESS_ARGS=()
    # EOF (Ctrl-D) at the menu read returns the default harness. Afterwards
    # the heddle path continues into the Bun prompt, where EOF again exits.
    printf 'WAIT:Choose [1/2\nEOF\nWAIT:Bun 1.3\nEOF\n' > "$WORK/steps"
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=1 || true
    grep -aq 'harness: .*heddle' "$LOG" || fail "EOF at menu did not fall back to heddle"
    pass "EOF at the menu fell back to the default harness"
    ;;

  *)
    fail "unknown case: $CASE"
    ;;
esac

# The transcript directory is kept for post-mortem inspection:
#   /tmp/heddlework-pty-<case>/transcript.log
printf 'transcript: %s\n' "$LOG"

