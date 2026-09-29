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
export HOME="$WORK/home"
mkdir -p "$HOME"
# The WSL sandbox has no Node; `need_node` only checks availability, so a
# mock keeps the pi-harness path reachable. Writing auth.json falls back to
# node, which must therefore also resolve (mock-pi handles any argv).
mkdir -p "$WORK/bin"
ln -sf "$REPO/tests/pty/mock-pi.sh" "$WORK/bin/pi"
ln -sf "$REPO/tests/pty/mock-pi.sh" "$WORK/bin/node"

# The mocked `node` on PATH keeps `need_node` satisfied on machines that have no
# Node at all, but it cannot evaluate the installer's JSON writer. Resolve one
# real interpreter for the cases that assert on written files; they skip when
# there is none. Set PTY_REAL_NODE=/abs/path/to/node for a Node that is not on
# PATH at all (nvm, an unpacked tarball, ...).
if [ -n "${PTY_REAL_NODE:-}" ]; then
  :
else
  PTY_REAL_NODE=$(command -v node 2>/dev/null || true)
  [ -n "$PTY_REAL_NODE" ] && [ -x "$PTY_REAL_NODE" ] && export PTY_REAL_NODE || PTY_REAL_NODE=''
fi

# Do not inherit a real Bun, package manager, curl, or Pi from the host. Only
# these utilities and the case's explicit mocks are visible to the installer.
for utility in awk bash basename cat chmod cmp cp cut dirname env grep head install ln mkdir sed sh stat stty tr uname; do
  ln -s "$(command -v "$utility")" "$WORK/bin/$utility"
done
export PATH="$WORK/bin"
export BUN_LOG="$WORK/bun.log"
export CURL_LOG="$WORK/curl.log"
: > "$BUN_LOG"
: > "$CURL_LOG"

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
#         custom-endpoint custom-endpoint-prompt desktop-launcher

run_steps() { # steps-file extra-env...
  local steps=$1; shift
  env -i HOME="$HOME" PATH="$PATH" NO_COLOR=1 \
    PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" \
    HEDDLEWORK_SKIP_SETUP=1 HEDDLEWORK_NONINTERACTIVE=0 \
    BUN_LOG="$BUN_LOG" CURL_LOG="$CURL_LOG" \
    "$@" "$PY" "$REPO/tests/pty/pty-run.py" "$LOG" "$steps" -- \
    sh "$REPO/install.sh" "${CASE_HARNESS_ARGS[@]}"
}

mock_bun() { # executable-path version
  cat > "$1" <<'STUB'
#!/bin/sh
if [ "$1" = '--version' ]; then
  cat "$0.version"
else
  printf '%s\n' "$*" >> "${BUN_LOG:?}"
fi
STUB
  printf '%s\n' "$2" > "$1.version"
  chmod 755 "$1"
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
      HEDDLEWORK_OPENAI_KEY="sk-custom-ENV-1" || fail "--write-model-config exited non-zero"

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
  # through the hidden prompt, so it must never reach the terminal.
  custom-endpoint-prompt)
    CASE_HARNESS_ARGS=(pi)
    need_real_node custom-endpoint-prompt
    mkdir -p "$PI_CODING_AGENT_DIR"
    {
      for provider in anthropic openai google xai openrouter groq cerebras mistral deepseek; do
        printf 'WAIT:Configure %s\nENTER\n' "$provider"
      done
      printf 'WAIT:Use a custom OpenAI-compatible base URL\ny\n'
      printf 'WAIT:Base URL\nhttp://127.0.0.1:11434/v1\n'
      printf 'WAIT:Model ID\nqwen2.5-coder:7b\n'
      printf 'WAIT:Provider ID\nENTER\n'
      printf 'WAIT:API flavor\nENTER\n'
      printf 'WAIT:API key\nsk-custom-PROMPT-1\n'
    } > "$WORK/steps"
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=0 || fail "interactive run exited non-zero"

    grep -q 'custom-openai -> http://127.0.0.1:11434/v1 (api: openai-completions' "$LOG" \
      || fail "prompt did not fall back to the default provider id and API flavor"
    grep -q 'sk-custom-PROMPT-1' "$LOG" && fail "endpoint key echoed to the terminal"
    models="$PI_CODING_AGENT_DIR/models.json"
    grep -q '"id": "qwen2.5-coder:7b"' "$models" || fail "prompted model id missing from models.json"
    grep -q '"key": "sk-custom-PROMPT-1"' "$PI_CODING_AGENT_DIR/auth.json" || fail "prompted key not stored in auth.json"
    grep -q 'HEDDLEWORK_PROVIDER=custom-openai HEDDLEWORK_MODEL=qwen2.5-coder:7b' "$LOG" \
      || fail "next steps did not show how to launch the custom endpoint"
    pass "prompt collected the endpoint, kept the key hidden, and printed the launch hint"
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
    printf 'WAIT:Choose [1/2\nENTER\nWAIT:Bun now\nENTER\n' > "$WORK/steps"
    run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=1 || true
    grep -aq 'install Bun 1.4.0 or newer from https://bun.sh' "$LOG" || fail "decline did not warn"
    grep -aq 'Bun is required for the Heddlework harness' "$LOG" || fail "installer did not stop after decline"
    # The prompt itself mentions curl; a real invocation echoes `curl-mock:`.
    grep -aq 'curl-mock:' "$LOG" && fail "installer ran curl after decline"
    pass "declining the Bun prompt stops cleanly without installing"
    ;;

  bun-install-accept)
    CASE_HARNESS_ARGS=()
    # Accept the Bun install with a mocked curl (records the invocation and
    # exits 0); bun remains absent, so the flow then stops with the usual error.
    printf 'WAIT:Choose [1/2\nENTER\nWAIT:Bun now\ny\n' > "$WORK/steps"
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

  bun-missing|bun-unsupported|bun-supported)
    CASE_HARNESS_ARGS=(heddle)
    : > "$WORK/steps"
    case "$CASE" in
      bun-missing) versions='missing' ;;
      bun-unsupported) versions='1.3.14 1.3.99 0.99.0 1.4.0-canary invalid' ;;
      bun-supported) versions='1.4.0 1.4.1 1.10.0 2.0.0' ;;
    esac
    for version in $versions; do
      [ "$version" = missing ] || mock_bun "$WORK/bin/bun" "$version"
      : > "$BUN_LOG"
      status=0
      run_steps "$WORK/steps" HEDDLEWORK_NONINTERACTIVE=1 HEDDLEWORK_SKIP_PROVIDERS=1 || status=$?
      if [ "$CASE" = bun-supported ]; then
        [ "$status" -eq 0 ] || fail "$version was rejected"
        grep -qx 'install --frozen-lockfile' "$BUN_LOG" || fail "$version did not install dependencies"
        grep -qx 'run build' "$BUN_LOG" || fail "$version did not build"
      else
        [ "$status" -ne 0 ] || fail "$version was accepted"
        grep -q 'Bun 1.4.0' "$LOG" || fail "required version not reported"
        [ "$version" = missing ] || grep -q "$version" "$LOG" || fail "detected version not reported"
        [ ! -s "$BUN_LOG" ] || fail "build reached with $version"
        grep -q 'Install.*Bun now' "$LOG" && fail "non-interactive run prompted"
      fi
    done
    pass "Bun version gate: $versions"
    ;;

  bun-upgrade-decline|bun-upgrade-failed|bun-upgrade-accept)
    CASE_HARNESS_ARGS=(heddle)
    mock_bun "$WORK/bin/bun" 1.3.14
    cat > "$WORK/bin/curl" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "${CURL_LOG:?}"
if [ "${UPGRADE_FAIL:-0}" = 1 ]; then
  printf 'exit 1\n'
elif [ -n "${UPGRADE_BUN:-}" ]; then
  cat <<'INSTALL'
mkdir -p "$HOME/.bun/bin"
cp "$UPGRADE_BUN" "$HOME/.bun/bin/bun"
cp "$UPGRADE_BUN.version" "$HOME/.bun/bin/bun.version"
INSTALL
fi
STUB
    chmod 755 "$WORK/bin/curl"
    if [ "$CASE" = bun-upgrade-decline ]; then
      printf 'WAIT:Bun now\nENTER\n' > "$WORK/steps"
      status=0
      run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=1 || status=$?
      [ "$status" -ne 0 ] || fail "declining upgrade exited successfully"
      [ ! -s "$CURL_LOG" ] || fail "upgrade ran without consent"
      [ ! -s "$BUN_LOG" ] || fail "build reached with old Bun"
    else
      printf 'WAIT:Bun now\ny\n' > "$WORK/steps"
      # A successful installer exit alone is not enough: it may leave the old
      # binary in place. Exercise that, a nonzero installer, and an old install.
      if [ "$CASE" = bun-upgrade-failed ]; then upgrades='unchanged failed old'; else upgrades='supported'; fi
      for upgrade in $upgrades; do
        : > "$BUN_LOG"
        : > "$CURL_LOG"
        target=''
        failed=0
        case "$upgrade" in
          failed) failed=1 ;;
          old|supported)
            version=1.3.14
            [ "$upgrade" = old ] || version=1.4.0
            mock_bun "$WORK/upgrade-bun" "$version"
            target="$WORK/upgrade-bun"
            ;;
        esac
        status=0
        run_steps "$WORK/steps" HEDDLEWORK_SKIP_PROVIDERS=1 UPGRADE_BUN="$target" UPGRADE_FAIL="$failed" || status=$?
        [ -s "$CURL_LOG" ] || fail "accepted upgrade was not attempted"
        if [ "$upgrade" = supported ]; then
          [ "$status" -eq 0 ] || fail "supported upgrade was rejected"
          grep -qx 'run build' "$BUN_LOG" || fail "upgraded Bun did not build"
        else
          [ "$status" -ne 0 ] || fail "$upgrade upgrade was accepted"
          [ ! -s "$BUN_LOG" ] || fail "build reached after $upgrade upgrade"
        fi
      done
    fi
    pass "$CASE preserves the consent and version checks"
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
    printf 'WAIT:Choose [1/2\nEOF\nWAIT:Bun now\nEOF\n' > "$WORK/steps"
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
