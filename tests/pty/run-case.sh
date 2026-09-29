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
#         desktop-launcher

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

