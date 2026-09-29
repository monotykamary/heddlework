#!/bin/sh
# Heddlework installer: picks a harness and configures API providers.
#
#   ./install.sh              # interactive menu
#   ./install.sh heddle       # Heddlework + Pi (native desktop harness)
#   ./install.sh pi           # Pi plus Fabric (plain TUI harness)
#   ./install.sh pi-fabric    # alias of `pi`
#
# Honors: NO_COLOR=1, HEDDLEWORK_NONINTERACTIVE=1, HEDDLEWORK_PI, HEDDLEWORK_PROVIDER,
#         HEDDLEWORK_MODEL, HEDDLEWORK_SKIP_PROVIDERS=1, HEDDLEWORK_SKIP_SETUP=1,
#         HEDDLEWORK_OPENAI_BASE_URL, HEDDLEWORK_OPENAI_MODEL, HEDDLEWORK_OPENAI_API,
#         HEDDLEWORK_OPENAI_NAME, HEDDLEWORK_OPENAI_KEY, HEDDLEWORK_OPENAI_USERNAME,
#         HEDDLEWORK_OPENAI_PASSWORD, HEDDLEWORK_OPENAI_CHECK,
#         HEDDLEWORK_OPENAI_CHECK_TIMEOUT, HEDDLEWORK_OPENAI_ANSWER_TIMEOUT.
#
#   ./install.sh --write-model-config   # write models.json from the
#                                       # HEDDLEWORK_OPENAI_* variables and exit
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

# ---------------------------------------------------------------------------
# Presentation helpers
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ "${NO_COLOR:-}" != "1" ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RESET=$(printf '\033[0m')
else
  BOLD=''; DIM=''; RESET=''
fi

info()  { printf '%s\n' "${BOLD}==>${RESET} $*"; }
warn()  { printf '%s\n' "${BOLD}warning:${RESET} $*" >&2; }
die()   { printf '%s\n' "${BOLD}error:${RESET} $*" >&2; exit 1; }

is_interactive() {
  [ "${HEDDLEWORK_NONINTERACTIVE:-0}" != "1" ] && [ -t 0 ]
}

# Reads one line with terminal echo disabled and leaves it in HIDDEN_INPUT.
# Echo is switched off before the prompt is printed: if the prompt came first, a
# fast keypress could land between prompt and `stty -echo` and be echoed. Echo is
# restored on every exit path, including Ctrl-C in the middle of the entry.
read_hidden() { # read_hidden <prompt>
  saved_stty=$(stty -g 2>/dev/null || true)
  trap 'stty "$saved_stty" 2>/dev/null || stty echo 2>/dev/null || true; printf '\n'; exit 130' INT
  stty -echo 2>/dev/null || true
  printf '%s' "$1"
  old_ifs=$IFS
  IFS= read -r HIDDEN_INPUT || true
  IFS=$old_ifs
  stty "$saved_stty" 2>/dev/null || stty echo 2>/dev/null || true
  trap - INT
  printf '\n'
}

# ---------------------------------------------------------------------------
# Host tool detection (best effort: Homebrew on macOS, apt/dnf/pacman otherwise)
# ---------------------------------------------------------------------------
PKG_INSTALL=''
if command -v brew >/dev/null 2>&1; then
  PKG_INSTALL='brew install'
elif command -v apt-get >/dev/null 2>&1; then
  PKG_INSTALL='sudo apt-get install -y'
elif command -v dnf >/dev/null 2>&1; then
  PKG_INSTALL='sudo dnf install -y'
elif command -v pacman >/dev/null 2>&1; then
  PKG_INSTALL='sudo pacman -S --noconfirm'
fi

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
need_node() {
  command -v node >/dev/null 2>&1 && return 0
  warn "Node.js is required to run Pi (https://nodejs.org)"
  return 1
}

need_bun() {
  command -v bun >/dev/null 2>&1 && return 0
  info "Bun 1.3+ is required to build Heddlework"
  if is_interactive; then
    printf 'Install Bun now (curl -fsSL https://bun.sh/install | bash)? [y/N] '
    read -r answer
    case "$answer" in
      y|Y|yes|YES)
        curl -fsSL https://bun.sh/install | bash
        export PATH="$HOME/.bun/bin:$PATH"
        command -v bun >/dev/null 2>&1 && return 0 ;;
    esac
  fi
  warn "install Bun from https://bun.sh"
  return 1
}

# ---------------------------------------------------------------------------
# Pi installation
# ---------------------------------------------------------------------------
install_pi() {
  if command -v pi >/dev/null 2>&1; then
    info "Pi is already installed: $(command -v pi)"
    return 0
  fi
  need_node || return 1
  info "Installing Pi (@earendil-works/pi-coding-agent) globally with npm"
  # --ignore-scripts is what Pi's own docs recommend.
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  command -v pi >/dev/null 2>&1 || die "pi was installed but is not on PATH; check your npm global bin directory"
  info "Pi installed: $(pi --version 2>/dev/null || command -v pi)"
}

# ---------------------------------------------------------------------------
# Fabric installation (pi install npm:pi-fabric)
# ---------------------------------------------------------------------------
install_fabric() {
  info "Installing pi-fabric (Pi Fabric: tools, agents, workflows, mesh)"
  pi install npm:pi-fabric
  info "pi-fabric installed; manage it any time with 'pi install' / 'pi remove' or /fabric settings inside Pi"
}

# ---------------------------------------------------------------------------
# API provider setup — writes ~/.pi/agent/auth.json
#
# Pi's auth.json maps provider name -> { "type": "api_key", "key": "..." }.
# Provider keys are also honored from the environment at runtime
# (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...); writing them to auth.json is
# optional and is done here with owner-only file permissions (0600).
# ---------------------------------------------------------------------------
# Pi honors PI_CODING_AGENT_DIR itself (sessions, auth.json live there).
PI_DIR="${PI_CODING_AGENT_DIR:-${PI_CONFIG_DIR:-$HOME/.pi/agent}}"
AUTH_FILE="$PI_DIR/auth.json"

provider_env_var() {
  case "$1" in
    anthropic) printf 'ANTHROPIC_API_KEY' ;;
    openai)    printf 'OPENAI_API_KEY' ;;
    google)    printf 'GEMINI_API_KEY' ;;
    xai)       printf 'XAI_API_KEY' ;;
    openrouter) printf 'OPENROUTER_API_KEY' ;;
    groq)      printf 'GROQ_API_KEY' ;;
    cerebras)  printf 'CEREBRAS_API_KEY' ;;
    mistral)   printf 'MISTRAL_API_KEY' ;;
    deepseek)  printf 'DEEPSEEK_API_KEY' ;;
    *)         printf '' ;;
  esac
}

provider_default_model() {
  case "$1" in
    anthropic) printf 'claude-sonnet-4-5' ;;
    openai)    printf 'gpt-5.1-codex' ;;
    google)    printf 'gemini-2.5-pro' ;;
    *)         printf '' ;;
  esac
}

KNOWN_PROVIDERS='anthropic openai google xai openrouter groq cerebras mistral deepseek'

# Pi configuration is JSON, so writes go through a JavaScript runtime. Values
# travel through the environment: bun and node disagree about argv offsets under
# `-e`, and exporting explicitly avoids depending on how a shell scopes variable
# assignments that prefix a function call.
run_js() { # run_js <script> <destination-file>
  if command -v bun >/dev/null 2>&1; then
    bun -e "$1"
  elif command -v node >/dev/null 2>&1; then
    node -e "$1"
  else
    die "node or bun is required to write $2"
  fi
}

AUTH_STORE_SCRIPT='const fs=require("node:fs");let auth={};try{auth=JSON.parse(fs.readFileSync(process.env.PI_AUTH_FILE,"utf8"))}catch{};if(!auth||typeof auth!=="object"||Array.isArray(auth))auth={};auth[process.env.PI_AUTH_PROVIDER]={type:"api_key",key:process.env.PI_AUTH_KEY};fs.writeFileSync(process.env.PI_AUTH_FILE,JSON.stringify(auth,null,2)+"\n",{mode:0o600})'

write_auth_entry() { # write_auth_entry <provider> <key>
  mkdir -p "$PI_DIR"
  export PI_AUTH_FILE="$AUTH_FILE" PI_AUTH_PROVIDER="$1" PI_AUTH_KEY="$2"
  run_js "$AUTH_STORE_SCRIPT" "$AUTH_FILE"
  unset PI_AUTH_FILE PI_AUTH_PROVIDER PI_AUTH_KEY
  chmod 600 "$AUTH_FILE" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Custom OpenAI-compatible endpoint — writes <agent-dir>/models.json and then
# proves the result, first with an HTTP probe and finally by asking Pi itself
#
# Pi reaches a non-default endpoint through models.json rather than an
# environment variable: "providers.<id>" carries baseUrl, api, apiKey, and the
# model ids to expose. A dedicated provider id leaves the built-in OpenAI
# catalog intact, so both stay selectable in /model. Existing providers in the
# file are preserved. An endpoint behind HTTP Basic auth gets an Authorization
# header instead of a key, since Pi sends apiKey as a bearer token.
# ---------------------------------------------------------------------------
MODELS_FILE="$PI_DIR/models.json"

# The write is one expression per statement so the whole writer stays a single
# line, like the auth.json writer. PI_MODELS_BASIC carries "user:password" for an
# endpoint behind HTTP Basic auth: Pi reaches it through a provider header (an
# API key would be sent as `Bearer`, which such a proxy rejects), and Buffer
# computes the base64 so no extra binary is needed. The placeholder apiKey keeps
# the model selectable in /model while the header overrides its bearer value —
# Pi merges provider headers after the key.
MODELS_STORE_SCRIPT='const fs=require("node:fs");let config={};try{config=JSON.parse(fs.readFileSync(process.env.PI_MODELS_FILE,"utf8"))}catch{};if(!config||typeof config!=="object"||Array.isArray(config))config={};if(!config.providers||typeof config.providers!=="object"||Array.isArray(config.providers))config.providers={};const entry={baseUrl:process.env.PI_MODELS_BASE_URL,api:process.env.PI_MODELS_API,apiKey:process.env.PI_MODELS_API_KEY};if(process.env.PI_MODELS_BASIC)entry.headers={Authorization:"Basic "+Buffer.from(process.env.PI_MODELS_BASIC,"utf8").toString("base64")};entry.models=process.env.PI_MODELS_IDS.split(",").filter(Boolean).map(id=>({id}));config.providers[process.env.PI_MODELS_PROVIDER]=entry;fs.writeFileSync(process.env.PI_MODELS_FILE,JSON.stringify(config,null,2)+"\n",{mode:0o600})'

provider_env_name() { # provider_env_name <provider-id> -> CUSTOM_OPENAI_API_KEY
  printf '%s_API_KEY' "$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')"
}

write_models_entry() { # write_models_entry <provider> <base-url> <api> <api-key> <model-ids> [user:password]
  mkdir -p "$PI_DIR"
  export PI_MODELS_FILE="$MODELS_FILE" PI_MODELS_PROVIDER="$1" PI_MODELS_BASE_URL="$2" \
    PI_MODELS_API="$3" PI_MODELS_API_KEY="$4" PI_MODELS_IDS="$5" PI_MODELS_BASIC="${6:-}"
  run_js "$MODELS_STORE_SCRIPT" "$MODELS_FILE"
  unset PI_MODELS_FILE PI_MODELS_PROVIDER PI_MODELS_BASE_URL PI_MODELS_API PI_MODELS_API_KEY PI_MODELS_IDS PI_MODELS_BASIC
  chmod 600 "$MODELS_FILE" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Endpoint connectivity check
#
# A typo in the base URL or a model id the server does not serve would stay
# invisible until the first prompt inside Pi, where it reads like a provider
# outage. This probe asks the same question up front: GET <base-url>/models —
# the OpenAI-compatible listing Ollama, LM Studio, vLLM, LiteLLM, and most
# gateways implement — and, for a server that exposes no listing, a one-token
# POST to <base-url>/chat/completions.
#
# HEDDLEWORK_OPENAI_CHECK decides what a failed probe means: require (default)
# aborts before anything is written, warn writes the configuration and explains
# the problem, off skips the probe. Only openai-* flavors are probed, because
# Anthropic, Bedrock, and Vertex endpoints do not answer these routes.
# ---------------------------------------------------------------------------
ENDPOINT_TIMEOUT=${HEDDLEWORK_OPENAI_CHECK_TIMEOUT:-10}
ENDPOINT_BODY_FILE=''
ENDPOINT_ERROR_FILE=''
ENDPOINT_AUTH_HEADER=''
ENDPOINT_BASIC_USER=''
ENDPOINT_BASIC_PASSWORD=''

# curl when present, wget otherwise; a slim host with neither reports a skipped
# check rather than failing the install.
http_client() {
  if command -v curl >/dev/null 2>&1; then
    printf 'curl'
  elif command -v wget >/dev/null 2>&1; then
    printf 'wget'
  else
    return 1
  fi
}

# http_request <client> <url> [json-body] -> prints the HTTP status code, or 000
# when the request never completed. Response body lands in $ENDPOINT_BODY_FILE
# and the transport error in $ENDPOINT_ERROR_FILE; $ENDPOINT_AUTH_HEADER carries
# the credential. Timeouts keep a black-holed endpoint from hanging the install.
http_request() {
  request_client=$1
  request_url=$2
  request_body=${3:-}
  : > "$ENDPOINT_BODY_FILE"
  : > "$ENDPOINT_ERROR_FILE"
  if [ "$request_client" = curl ]; then
    set -- -sS -o "$ENDPOINT_BODY_FILE" -w '%{http_code}' \
      --connect-timeout 5 --max-time "$ENDPOINT_TIMEOUT"
    # Both clients compute the Basic header themselves, so the probe never has
    # to encode anything itself.
    if [ -n "$ENDPOINT_BASIC_USER" ]; then
      set -- "$@" --user "$ENDPOINT_BASIC_USER:$ENDPOINT_BASIC_PASSWORD"
    elif [ -n "$ENDPOINT_AUTH_HEADER" ]; then
      set -- "$@" -H "$ENDPOINT_AUTH_HEADER"
    fi
    if [ -n "$request_body" ]; then
      set -- "$@" -H 'Content-Type: application/json' -X POST --data "$request_body"
    fi
    # curl exits non-zero on a transport failure after already printing the 000
    # status, so the code is read from stdout either way.
    curl "$@" "$request_url" 2>"$ENDPOINT_ERROR_FILE" || true
  else
    # wget has no --write-out; --server-response prints the status line to
    # stderr, which is where the code is recovered from.
    set -- -q -O "$ENDPOINT_BODY_FILE" --server-response \
      --timeout="$ENDPOINT_TIMEOUT" --tries=1
    if [ -n "$ENDPOINT_BASIC_USER" ]; then
      set -- "$@" --user "$ENDPOINT_BASIC_USER" --password "$ENDPOINT_BASIC_PASSWORD"
    elif [ -n "$ENDPOINT_AUTH_HEADER" ]; then
      set -- "$@" --header "$ENDPOINT_AUTH_HEADER"
    fi
    if [ -n "$request_body" ]; then
      set -- "$@" --header 'Content-Type: application/json' --post-data "$request_body"
    fi
    wget "$@" "$request_url" 2>"$ENDPOINT_ERROR_FILE" || true
    request_code=$(sed -n 's/^[[:space:]]*HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' "$ENDPOINT_ERROR_FILE" | tail -n 1) || true
    printf '%s' "${request_code:-000}"
  fi
}

# endpoint_error_message — the API's own explanation, when it sent one
endpoint_error_message() {
  grep -o '"message"[[:space:]]*:[[:space:]]*"[^"]*"' "$ENDPOINT_BODY_FILE" 2>/dev/null \
    | head -n 1 | cut -d'"' -f4 || true
}

# endpoint_offered_models — the ids the response advertises, space-separated
endpoint_offered_models() {
  tr -d ' \t\r\n' < "$ENDPOINT_BODY_FILE" \
    | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | head -n 12 | tr '\n' ' ' || true
}

# probe_custom_endpoint <base-url> <api> <model-ids> [key] [user:password]
#   0 verified, 1 reached but broken, 2 not checked
# A "user:password" argument probes with HTTP Basic auth; otherwise the key is
# sent as a bearer token, exactly as Pi will send it.
probe_custom_endpoint() {
  probe_body=$(mktemp "${TMPDIR:-/tmp}/heddlework-endpoint-body.XXXXXX") || return 2
  probe_error=$(mktemp "${TMPDIR:-/tmp}/heddlework-endpoint-error.XXXXXX") \
    || { rm -f "$probe_body"; return 2; }
  ENDPOINT_BODY_FILE=$probe_body
  ENDPOINT_ERROR_FILE=$probe_error
  # `|| capture` keeps a failed probe from tripping `set -e` here.
  probe_status=''
  probe_endpoint "$@" || probe_status=$?
  rm -f "$probe_body" "$probe_error"
  ENDPOINT_BODY_FILE=''
  ENDPOINT_ERROR_FILE=''
  ENDPOINT_BASIC_USER=''
  ENDPOINT_BASIC_PASSWORD=''
  return "${probe_status:-0}"
}

probe_endpoint() { # probe_endpoint <base-url> <api> <model-ids> [key] [user:password]
  probe_base=$1
  probe_api=$2
  probe_models=$3
  probe_key=${4:-}
  probe_basic=${5:-}

  case "$probe_api" in
    openai-*) ;;
    *)
      info "endpoint check: skipped — only OpenAI-compatible flavors expose the routes this check uses (api: $probe_api)"
      return 2
      ;;
  esac

  if ! probe_client=$(http_client); then
    info "endpoint check: skipped — neither curl nor wget is installed"
    return 2
  fi

  # A missing scheme is what the caller warns about; here it is decisive, since
  # there is nothing to contact and Pi would build the same broken request.
  case "$probe_base" in
    http://*|https://*) ;;
    *)
      warn "endpoint check: '$probe_base' has no http:// or https:// scheme"
      return 1
      ;;
  esac

  # Trailing slashes would double up in "$base/models".
  probe_base=$(printf '%s' "$probe_base" | sed 's:/*$::')
  ENDPOINT_AUTH_HEADER=''
  ENDPOINT_BASIC_USER=''
  ENDPOINT_BASIC_PASSWORD=''
  if [ -n "$probe_basic" ]; then
    ENDPOINT_BASIC_USER=${probe_basic%%:*}
    ENDPOINT_BASIC_PASSWORD=${probe_basic#*:}
  elif [ -n "$probe_key" ]; then
    ENDPOINT_AUTH_HEADER="Authorization: Bearer $probe_key"
  fi

  probe_code=$(http_request "$probe_client" "$probe_base/models")
  case "$probe_code" in
    2*)
      # The listing is JSON; matching is done on a whitespace-stripped copy so a
      # fixed-string search works for both "id": "x" and "id":"x" without jq.
      probe_compact=$(tr -d ' \t\r\n' < "$ENDPOINT_BODY_FILE")
      probe_remaining=$probe_models
      probe_missing=''
      probe_found=0
      while [ -n "$probe_remaining" ]; do
        case "$probe_remaining" in
          *,*) probe_id=${probe_remaining%%,*}; probe_remaining=${probe_remaining#*,} ;;
          *)   probe_id=$probe_remaining; probe_remaining='' ;;
        esac
        probe_id=$(printf '%s' "$probe_id" | tr -d ' \t')
        [ -n "$probe_id" ] || continue
        if printf '%s' "$probe_compact" | grep -Fq "\"id\":\"$probe_id\""; then
          probe_found=$((probe_found + 1))
        else
          probe_missing="$probe_missing $probe_id"
        fi
      done
      if [ -z "$probe_missing" ]; then
        info "endpoint check: ok — $probe_base serves all $probe_found requested model id(s)"
        return 0
      fi
      warn "endpoint check: $probe_base does not serve:$probe_missing"
      probe_offered=$(endpoint_offered_models | sed 's/ *$//')
      if [ -n "$probe_offered" ]; then
        warn "endpoint check: it offers: $probe_offered"
      else
        warn "endpoint check: it advertised no model ids at all"
      fi
      return 1
      ;;
    401|403)
      if [ -n "$probe_basic" ]; then
        warn "endpoint check: $probe_base rejected the username and password (HTTP $probe_code)"
      else
        warn "endpoint check: $probe_base rejected the credential (HTTP $probe_code)"
      fi ;;
    000)
      warn "endpoint check: cannot reach $probe_base/models — $(head -n 1 "$ENDPOINT_ERROR_FILE")" ;;
    *)
      # No model listing (some gateways only implement chat): ask the route Pi
      # will actually use, with the smallest possible completion.
      info "endpoint check: $probe_base/models answered HTTP $probe_code; trying a one-token chat completion instead"
      probe_first=$(printf '%s' "$probe_models" | cut -d, -f1 | tr -d ' \t')
      probe_json='{"model":"'"$probe_first"'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'
      probe_code=$(http_request "$probe_client" "$probe_base/chat/completions" "$probe_json")
      case "$probe_code" in
        2*) info "endpoint check: ok — $probe_base answered a chat completion for $probe_first"; return 0 ;;
        401|403)
          if [ -n "$probe_basic" ]; then
            warn "endpoint check: $probe_base rejected the username and password (HTTP $probe_code)"
          else
            warn "endpoint check: $probe_base rejected the credential (HTTP $probe_code)"
          fi ;;
        000) warn "endpoint check: cannot reach $probe_base/chat/completions — $(head -n 1 "$ENDPOINT_ERROR_FILE")" ;;
        *)
          probe_detail=$(endpoint_error_message)
          warn "endpoint check: $probe_base refused a chat completion for $probe_first (HTTP $probe_code)${probe_detail:+: $probe_detail}" ;;
      esac
      return 1
      ;;
  esac
  # Reached, but not usable: the response body usually says why.
  probe_detail=$(endpoint_error_message)
  [ -n "$probe_detail" ] && warn "endpoint check: the endpoint said: $probe_detail"
  return 1
}

# run_endpoint_check <base-url> <api> <model-ids> <key> — applies
# HEDDLEWORK_OPENAI_CHECK to the probe result; only a confirmed failure in
# require mode stops the install, and it does so before anything is written.
run_endpoint_check() {
  check_mode=${HEDDLEWORK_OPENAI_CHECK:-require}
  case "$check_mode" in
    off|no|0) info "HEDDLEWORK_OPENAI_CHECK=$check_mode — writing the endpoint without testing it"; return 0 ;;
    require|yes|1|warn) ;;
    *) warn "unknown HEDDLEWORK_OPENAI_CHECK='$check_mode' (expected require, warn, or off); treating it as require"; check_mode=require ;;
  esac

  check_status=''
  probe_custom_endpoint "$@" || check_status=$?
  case "${check_status:-0}" in
    0|2) ENDPOINT_CHECK_STATUS=0; return 0 ;;
  esac
  # 1 is a confirmed failure: the HTTP probe already said what is wrong, so the
  # round trip through Pi is skipped rather than waiting out a second timeout.
  ENDPOINT_CHECK_STATUS=1

  if [ "$check_mode" = warn ]; then
    warn "writing the endpoint anyway (HEDDLEWORK_OPENAI_CHECK=warn); Pi will fail at the first prompt while it stays unreachable"
    return 0
  fi
  die "refusing to write an endpoint that failed its check — fix the base URL or model id, start the server, or set HEDDLEWORK_OPENAI_CHECK=warn to write it anyway"
}

# ---------------------------------------------------------------------------
# Round trip through Pi
#
# The HTTP probe proves the endpoint answers; it does not prove Pi can use the
# configuration just written. This asks Pi itself for a one-word reply with the
# provider and model an editor would launch, so a configuration Pi rejects — a
# header it cannot resolve, a model id it hides, a credential only the probe
# knew — is reported here, with the model's own words, instead of at the first
# prompt. It runs after the write because Pi reads models.json and auth.json, so
# it never gates the write, and it is fatal only in require mode.
# ---------------------------------------------------------------------------
# A cold local model can take far longer to load than an HTTP probe should wait,
# hence a separate budget for the answer.
PI_ANSWER_TIMEOUT=${HEDDLEWORK_OPENAI_ANSWER_TIMEOUT:-60}
PI_ROUNDTRIP_PROMPT='Reply with the single word: pong'
PI_HELP=''

# pi_supports <flag> — whether the installed Pi advertises a flag. --print is
# required to ask for an answer at all; the optional flags are passed only when
# present, so an older build is still exercised instead of failing on an option
# it does not know.
pi_supports() {
  if [ -z "$PI_HELP" ]; then
    PI_HELP=$(pi --help 2>&1 || true)
  fi
  printf '%s' "$PI_HELP" | grep -q -- "$1"
}

# run_pi_roundtrip <provider> <model-id>
run_pi_roundtrip() {
  roundtrip_provider=$1
  roundtrip_model=$2
  case "${HEDDLEWORK_OPENAI_CHECK:-require}" in
    off|no|0) return 0 ;;
  esac
  if ! command -v pi >/dev/null 2>&1; then
    info "endpoint check: skipped the round trip — 'pi' is not on PATH (a full install would have put it there)"
    return 0
  fi
  if ! pi_supports --print; then
    info "endpoint check: skipped the round trip — this Pi build has no --print mode"
    return 0
  fi

  set -- --provider "$roundtrip_provider" --model "$roundtrip_model" --print "$PI_ROUNDTRIP_PROMPT"
  pi_supports --no-session && set -- "$@" --no-session
  pi_supports --no-tools && set -- "$@" --no-tools
  pi_supports --offline && set -- "$@" --offline

  roundtrip_dir=$(mktemp -d "${TMPDIR:-/tmp}/heddlework-roundtrip.XXXXXX") || return 0
  info "endpoint check: asking Pi for a one-word answer through $roundtrip_provider/$roundtrip_model"
  # The status goes to a file because a backgrounded `kill -0` cannot tell a
  # running child from an unreaped one; polling the file also bounds the wait
  # without relying on GNU `timeout`, which macOS does not ship. The subshell
  # runs Pi from a scratch directory so the installer's working directory does
  # not add context files to the request.
  (
    cd "$roundtrip_dir" || exit 1
    # `|| capture` so a failing Pi still reaches the line that records it, which
    # `set -e` would otherwise skip along with the status file.
    roundtrip_exit=0
    PI_CODING_AGENT_DIR="$PI_DIR" pi "$@" > "$roundtrip_dir/answer" 2> "$roundtrip_dir/error" || roundtrip_exit=$?
    printf '%s' "$roundtrip_exit" > "$roundtrip_dir/status"
  ) &
  roundtrip_pid=$!

  roundtrip_waited=0
  while [ ! -s "$roundtrip_dir/status" ] && [ "$roundtrip_waited" -lt "$PI_ANSWER_TIMEOUT" ]; do
    sleep 1
    roundtrip_waited=$((roundtrip_waited + 1))
  done

  # CR is stripped because Pi may be on Windows; the last non-empty line is the
  # answer, since a one-word reply can still be preceded by startup notices.
  roundtrip_reply=$(tr -d '\r' < "$roundtrip_dir/answer" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 1 | cut -c1-160) || true
  roundtrip_reason=$(tr -d '\r' < "$roundtrip_dir/error" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 1 | cut -c1-300) || true
  roundtrip_status=$(cat "$roundtrip_dir/status" 2>/dev/null) || roundtrip_status=''

  if [ -z "$roundtrip_status" ]; then
    kill "$roundtrip_pid" 2>/dev/null || true
    rm -rf "$roundtrip_dir"
    warn "endpoint check: Pi did not answer within ${PI_ANSWER_TIMEOUT}s; a cold local model can take a while to load — raise HEDDLEWORK_OPENAI_ANSWER_TIMEOUT if this endpoint is just slow"
    verdict_pi_roundtrip_failure
    return $?
  fi
  rm -rf "$roundtrip_dir"

  if [ "$roundtrip_status" != 0 ]; then
    warn "endpoint check: Pi could not complete a request through $roundtrip_provider: ${roundtrip_reason:-no error output (exit $roundtrip_status)}"
    verdict_pi_roundtrip_failure
    return $?
  fi
  if [ -z "$roundtrip_reply" ]; then
    warn "endpoint check: Pi completed the request but returned no answer${roundtrip_reason:+ (${roundtrip_reason})}"
    verdict_pi_roundtrip_failure
    return $?
  fi
  info "endpoint check: Pi answered \"$roundtrip_reply\""
  return 0
}

# The shared verdict: require mode refuses an endpoint Pi cannot use, warn mode
# reports it and continues.
verdict_pi_roundtrip_failure() {
  if [ "${HEDDLEWORK_OPENAI_CHECK:-require}" = warn ]; then
    warn "continuing anyway (HEDDLEWORK_OPENAI_CHECK=warn); Pi will fail at the first prompt if this persists"
    return 0
  fi
  die "the endpoint answered but Pi could not complete a request through it — see the warning above, or set HEDDLEWORK_OPENAI_CHECK=warn to install anyway"
}

write_custom_endpoint() { # write_custom_endpoint <name> <base-url> <api> <model-ids> [key] [username] [password]
  custom_name=$1
  custom_base_url=$2
  custom_api=$3
  custom_models=$4
  custom_key=${5:-}
  custom_user=${6:-}
  custom_pass=${7:-}

  case "$custom_base_url" in
    http://*|https://*) ;;
    *) warn "$custom_base_url has no http:// or https:// scheme; Pi appends request paths to it" ;;
  esac

  # Resolving the credential first lets the check use exactly what Pi will send,
  # and keeps a failed check from leaving a half-configured endpoint behind.
  custom_basic=''
  custom_probe_key=''
  custom_probe_basic=''
  custom_key_ref='local'
  if [ -n "$custom_user" ] || [ -n "$custom_pass" ]; then
    [ -n "$custom_user" ] || die "a username is required alongside the password for HTTP Basic auth"
    [ -n "$custom_pass" ] || die "a password is required alongside the username for HTTP Basic auth"
    # A proxy asking for Basic auth rejects a bearer token, and Pi cannot send
    # Basic through apiKey, so the credential travels as a provider header while
    # the placeholder apiKey keeps the model selectable in /model.
    custom_basic="$custom_user:$custom_pass"
    custom_probe_basic=$custom_basic
    if [ -n "$custom_key" ]; then
      warn "HTTP Basic auth is configured, so the API key is ignored (the Authorization header replaces it)"
    elif [ -n "${OPENAI_API_KEY:-}" ]; then
      info "OPENAI_API_KEY is set but unused: this endpoint authenticates with HTTP Basic"
    fi
  elif [ -n "$custom_key" ]; then
    custom_key_ref='${'"$(provider_env_name "$custom_name")"'}';
    custom_probe_key=$custom_key
  elif [ -n "${OPENAI_API_KEY:-}" ]; then
    custom_key_ref='${OPENAI_API_KEY}'
    custom_probe_key=$OPENAI_API_KEY
  else
    # Local servers ignore credentials, but a missing key hides the models from
    # /model, so a literal placeholder keeps them selectable.
    custom_probe_key='local'
  fi

  run_endpoint_check "$custom_base_url" "$custom_api" "$custom_models" "$custom_probe_key" "$custom_probe_basic"

  case "$custom_key_ref" in
    local) ;;
    *)
      # Pi resolves a stored credential by provider id, so the secret lives in
      # auth.json. models.json only references an environment variable, which
      # keeps the same endpoint usable where there is no auth.json (CI, containers).
      if [ -n "$custom_key" ]; then
        write_auth_entry "$custom_name" "$custom_key"
      else
        # A gateway fronting the same protocol usually reuses the OpenAI key.
        write_auth_entry "$custom_name" "$OPENAI_API_KEY"
      fi
      ;;
  esac

  write_models_entry "$custom_name" "$custom_base_url" "$custom_api" "$custom_key_ref" "$custom_models" "$custom_basic"
  CUSTOM_ENDPOINT_NAME=$custom_name
  CUSTOM_ENDPOINT_MODEL=$(printf '%s' "$custom_models" | cut -d, -f1)
  info "$custom_name -> $custom_base_url (api: $custom_api, models: $custom_models)"
  if [ -n "$custom_key" ]; then
    info "key stored in $AUTH_FILE; export $(provider_env_name "$custom_name") where that file is unavailable"
  fi
  if [ -n "$custom_basic" ]; then
    info "HTTP Basic auth for '$custom_user' is an Authorization header in $MODELS_FILE (0600)"
    info "to keep the secret out of that file, replace the header value with a lone \$MY_BASIC_HEADER and export it instead"
  fi

  if [ "$ENDPOINT_CHECK_STATUS" = 1 ]; then
    info "endpoint check: skipping the round trip through Pi — the endpoint did not answer the HTTP probe"
    return 0
  fi
  run_pi_roundtrip "$custom_name" "$CUSTOM_ENDPOINT_MODEL"
}

write_custom_endpoint_from_env() {
  [ -n "${HEDDLEWORK_OPENAI_BASE_URL:-}" ] || die "HEDDLEWORK_OPENAI_BASE_URL is not set"
  [ -n "${HEDDLEWORK_OPENAI_MODEL:-}" ] || die "HEDDLEWORK_OPENAI_MODEL is required alongside HEDDLEWORK_OPENAI_BASE_URL (comma-separate several model ids)"
  # Basic credentials must arrive as a pair: half of one would otherwise write an
  # endpoint that only fails at the first prompt.
  if [ -n "${HEDDLEWORK_OPENAI_USERNAME:-}" ] && [ -z "${HEDDLEWORK_OPENAI_PASSWORD:-}" ]; then
    die "HEDDLEWORK_OPENAI_PASSWORD is required alongside HEDDLEWORK_OPENAI_USERNAME"
  fi
  if [ -n "${HEDDLEWORK_OPENAI_PASSWORD:-}" ] && [ -z "${HEDDLEWORK_OPENAI_USERNAME:-}" ]; then
    die "HEDDLEWORK_OPENAI_USERNAME is required alongside HEDDLEWORK_OPENAI_PASSWORD"
  fi
  write_custom_endpoint \
    "${HEDDLEWORK_OPENAI_NAME:-custom-openai}" \
    "$HEDDLEWORK_OPENAI_BASE_URL" \
    "${HEDDLEWORK_OPENAI_API:-openai-completions}" \
    "$HEDDLEWORK_OPENAI_MODEL" \
    "${HEDDLEWORK_OPENAI_KEY:-}" \
    "${HEDDLEWORK_OPENAI_USERNAME:-}" \
    "${HEDDLEWORK_OPENAI_PASSWORD:-}"
}

prompt_custom_endpoint() {
  # The environment wins over the prompt, so an unattended run and an
  # interactive one converge on the same configuration.
  [ -z "${HEDDLEWORK_OPENAI_BASE_URL:-}" ] || return 0
  printf 'Use a custom OpenAI-compatible base URL (Ollama, LM Studio, vLLM, LiteLLM, gateway)? [y/N] '
  read -r answer || true
  case "$answer" in
    y|Y|yes|YES) ;;
    *) return 0 ;;
  esac
  printf 'Base URL [http://localhost:11434/v1]: '
  read -r custom_base_url || true
  custom_base_url=${custom_base_url:-http://localhost:11434/v1}
  printf 'Model ID (comma-separate several, e.g. qwen2.5-coder:7b): '
  read -r custom_models || true
  if [ -z "$custom_models" ]; then
    warn "no model id given — skipping the custom endpoint; set HEDDLEWORK_OPENAI_BASE_URL and HEDDLEWORK_OPENAI_MODEL to add it later"
    return 0
  fi
  printf 'Provider ID [custom-openai]: '
  read -r custom_name || true
  custom_name=${custom_name:-custom-openai}
  printf 'API flavor [openai-completions]: '
  read -r custom_api || true
  custom_api=${custom_api:-openai-completions}

  # The credential is either an API key (sent as a bearer token) or a username
  # and password (sent as an Authorization header, which is what a proxy asks
  # for). A pair from the environment is used without asking, the way the base
  # URL and model ids are.
  custom_user=${HEDDLEWORK_OPENAI_USERNAME:-}
  custom_pass=${HEDDLEWORK_OPENAI_PASSWORD:-}
  if [ -n "$custom_user" ] && [ -n "$custom_pass" ]; then
    info "using HEDDLEWORK_OPENAI_USERNAME for HTTP Basic auth"
    write_custom_endpoint "$custom_name" "$custom_base_url" "$custom_api" "$custom_models" '' "$custom_user" "$custom_pass"
    return 0
  fi
  [ -n "$custom_user" ] && warn "HEDDLEWORK_OPENAI_USERNAME is set without HEDDLEWORK_OPENAI_PASSWORD"
  printf 'Does the endpoint use HTTP Basic auth (username and password)? [y/N] '
  read -r answer || true
  case "$answer" in
    y|Y|yes|YES)
      printf 'Username: '
      read -r custom_user || true
      read_hidden 'Password (input hidden, Ctrl-C cancels): '
      custom_pass=$HIDDEN_INPUT
      if [ -z "$custom_user" ] || [ -z "$custom_pass" ]; then
        warn "HTTP Basic auth needs both a username and a password — skipping the custom endpoint"
        return 0
      fi
      write_custom_endpoint "$custom_name" "$custom_base_url" "$custom_api" "$custom_models" '' "$custom_user" "$custom_pass"
      return 0
      ;;
  esac
  read_hidden 'API key (input hidden; press Enter for a local endpoint without auth): '
  write_custom_endpoint "$custom_name" "$custom_base_url" "$custom_api" "$custom_models" "$HIDDEN_INPUT"
}

CUSTOM_ENDPOINT_NAME=''
CUSTOM_ENDPOINT_MODEL=''
ENDPOINT_CHECK_STATUS=0

setup_providers() {
  if [ "${HEDDLEWORK_SKIP_PROVIDERS:-0}" = "1" ]; then
    info "HEDDLEWORK_SKIP_PROVIDERS=1 — skipping provider setup"
    return 0
  fi
  info "API provider setup"
  printf '%s\n' "Pi reads keys from the environment at runtime (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)"
  printf '%s\n' "or stores them in $AUTH_FILE (chmod 600, never commit it)."

  # Interactive: offer each known provider in turn.
  if is_interactive; then
    for provider in $KNOWN_PROVIDERS; do
      env_var=$(provider_env_var "$provider")
      current="not set"
      if [ -n "$env_var" ] && [ -n "$(eval "printf '%s' \"\${$env_var:-}\"")" ]; then
        current="set in environment"
      elif [ -f "$AUTH_FILE" ] && { command -v bun >/dev/null 2>&1 || command -v node >/dev/null 2>&1; }; then
        if command -v bun >/dev/null 2>&1; then
          JS_RUNTIME=$(command -v bun)
        else
          JS_RUNTIME=$(command -v node)
        fi
        if PI_AUTH_FILE="$AUTH_FILE" PI_AUTH_PROVIDER="$provider" "$JS_RUNTIME" -e 'let a={};try{a=JSON.parse(require("node:fs").readFileSync(process.env.PI_AUTH_FILE,"utf8"))}catch{};process.stdout.write(a[process.env.PI_AUTH_PROVIDER]?"configured":"not set")' 2>/dev/null | grep -q configured; then
          current="already in $AUTH_FILE"
        fi
      fi
      printf 'Configure %s API key? [%s] [y/N] ' "$provider" "$current"
      read -r answer
      case "$answer" in
        y|Y|yes|YES) ;;
        *) continue ;;
      esac
      read_hidden "Paste the $provider API key (input hidden, Ctrl-C cancels): "
      key=$HIDDEN_INPUT
      [ -n "$key" ] || { warn "empty key for $provider — skipped"; continue; }
      write_auth_entry "$provider" "$key"
      info "$provider key written to $AUTH_FILE"
    done
    prompt_custom_endpoint
  fi

  # Non-interactive / explicit: pick up provider keys from the environment.
  for provider in $KNOWN_PROVIDERS; do
    env_var=$(provider_env_var "$provider")
    [ -n "$env_var" ] || continue
    key=$(eval "printf '%s' \"\${$env_var:-}\"")
    [ -n "$key" ] || continue
    if [ ! -f "$AUTH_FILE" ] || ! grep -q "\"$provider\"" "$AUTH_FILE" 2>/dev/null; then
      write_auth_entry "$provider" "$key"
      info "$provider key copied from $env_var into $AUTH_FILE"
    fi
  done

  # Custom endpoint from the environment. Interactive collection above already
  # covers the prompted case; these same variables drive the container
  # entrypoint and CI through --write-model-config.
  if [ -n "${HEDDLEWORK_OPENAI_BASE_URL:-}" ]; then
    write_custom_endpoint_from_env
  fi

  # Initial provider/model hints for the desktop app.
  if [ -n "${HEDDLEWORK_PROVIDER:-}" ] && [ -n "${HEDDLEWORK_MODEL:-}" ]; then
    info "HEDDLEWORK_PROVIDER=$HEDDLEWORK_PROVIDER HEDDLEWORK_MODEL=$HEDDLEWORK_MODEL will be passed to Pi on launch"
  elif [ -n "${HEDDLEWORK_PROVIDER:-}" ]; then
    default=$(provider_default_model "$HEDDLEWORK_PROVIDER")
    [ -n "$default" ] && warn "set HEDDLEWORK_MODEL too (e.g. $default) to pin the startup model"
  fi
  info "Subscription-based providers (GitHub Copilot, OAuth flows) can be configured later with 'pi /login'"
}

# ---------------------------------------------------------------------------
# Harness builds
# ---------------------------------------------------------------------------
build_heddlework() {
  need_bun || die "Bun is required for the Heddlework harness"
  cd "$REPO_ROOT"
  info "Installing workspace dependencies (bun install --frozen-lockfile)"
  bun install --frozen-lockfile
  if [ "${HEDDLEWORK_SKIP_SETUP:-0}" != "1" ]; then
    info "Building the pinned GPUIX native runtime (Rust toolchain required)"
    bun run setup:native
  fi
  info "Building Heddlework"
  bun run build
  info "Built $(cd "$REPO_ROOT" && pwd)/dist — run it with: ./dist/heddlework /path/to/repository"
}

verify_pi() {
  command -v pi >/dev/null 2>&1 || die "pi is not on PATH after installation"
  info "pi: $(command -v pi)"
  if pi --help 2>&1 | grep -q -- '--mode'; then
    info "Pi RPC mode is available (--mode rpc) — Heddlework will drive it as a sidecar"
  fi
}

# ---------------------------------------------------------------------------
# Harness selection
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
Usage: install.sh [harness|--write-model-config]

Harnesses:
  heddle      Heddlework + Pi — the native GPUIX desktop harness (default prompt)
  pi          Pi + Fabric — the plain terminal harness with pi-fabric installed
  pi-fabric   alias of `pi`

Config only:
  --write-model-config          write the custom OpenAI-compatible endpoint given
                                by the HEDDLEWORK_OPENAI_* variables into
                                models.json, then exit (no harness selection and
                                no installation)

Options (environment):
  HEDDLEWORK_NONINTERACTIVE=1   never prompt; use flags/env only
  HEDDLEWORK_SKIP_PROVIDERS=1   do not touch ~/.pi/agent/auth.json or models.json
  HEDDLEWORK_SKIP_SETUP=1       skip the slow GPUIX native build (`bun run setup:native`)
  HEDDLEWORK_PI=/abs/path/pi    absolute Pi path for desktop launchers
  HEDDLEWORK_PROVIDER=...       initial provider passed to Pi
  HEDDLEWORK_MODEL=...          initial model passed to Pi

Custom OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, LiteLLM, a gateway):
  HEDDLEWORK_OPENAI_BASE_URL    endpoint root, e.g. http://localhost:11434/v1
  HEDDLEWORK_OPENAI_MODEL       model id(s) to expose, comma-separated
  HEDDLEWORK_OPENAI_API         endpoint API flavor (default openai-completions)
  HEDDLEWORK_OPENAI_NAME        provider id to create (default custom-openai)
  HEDDLEWORK_OPENAI_KEY         key for the endpoint; defaults to OPENAI_API_KEY,
                                otherwise to a placeholder local servers ignore
  HEDDLEWORK_OPENAI_USERNAME   username for an endpoint behind HTTP Basic auth
  HEDDLEWORK_OPENAI_PASSWORD   password for that endpoint; the pair is required
                                together and replaces HEDDLEWORK_OPENAI_KEY, as
                                Pi sends Basic through a request header rather
                                than an API key. The credential is written to
                                models.json (mode 0600): replace the header value
                                with a lone $MY_BASIC_HEADER to keep it in the
                                environment instead
  HEDDLEWORK_OPENAI_CHECK       require (default) aborts the install when the
                                endpoint is unreachable, rejects the credential,
                                does not serve the given model id, or Pi cannot
                                complete a request through it; warn reports all
                                of that and installs anyway; off skips the checks
  HEDDLEWORK_OPENAI_CHECK_TIMEOUT  seconds to wait for the endpoint (default 10)
  HEDDLEWORK_OPENAI_ANSWER_TIMEOUT seconds Pi may take to answer through the
                                endpoint (default 60; a cold local model can
                                take a while to load)

Examples:
  ./install.sh                    # interactive menu
  ./install.sh heddle             # desktop harness
  HEDDLEWORK_PROVIDER=anthropic HEDDLEWORK_MODEL=claude-sonnet-4-5 ./install.sh pi
  HEDDLEWORK_OPENAI_BASE_URL=http://localhost:11434/v1 \
    HEDDLEWORK_OPENAI_MODEL=qwen2.5-coder:7b ./install.sh pi
  ./install.sh --write-model-config            # models.json only, no install
EOF
}

select_harness() {
  if [ "${1:-}" = "pi-fabric" ]; then
    printf 'pi'
    return 0
  fi
  case "${1:-}" in
    heddle|pi) printf '%s' "$1"; return 0 ;;
    '') ;;
    *) die "unknown harness '$1' (expected: heddle, pi, pi-fabric)" ;;
  esac

  if ! is_interactive; then
    die "no harness specified; pass 'heddle' or 'pi' (or run interactively)"
  fi
  # The caller captures this function's stdout, so the menu and prompt belong
  # on stderr — only the harness name may travel through stdout.
  cat >&2 <<'EOF'

Which harness should this machine use?

  1) Heddlework + Pi   — native GPUIX desktop workspace; Pi runs as an RPC sidecar
                         (builds the pinned native runtime; needs Rust)
  2) Pi + Fabric       — plain Pi TUI with pi-fabric installed; no Heddlework build
                         (fastest path; only needs Node.js)

EOF
  printf 'Choose [1/2, default 1]: ' >&2
  # Ctrl-D at the prompt must fall through to the default harness, not abort
  # the installer (read returns non-zero on EOF; set -e would kill the script).
  read -r choice || true
  case "${choice:-1}" in
    2) printf 'pi' ;;
    *) printf 'heddle' ;;
  esac
}

main() {
  case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    --write-model-config)
      write_custom_endpoint_from_env
      info "wrote $MODELS_FILE"
      exit 0
      ;;
  esac
  harness=$(select_harness "$@")

  info "Heddlework installer — harness: ${BOLD}$harness${RESET}"

  install_pi
  verify_pi

  case "$harness" in
    pi)
      install_fabric
      ;;
    heddle)
      build_heddlework
      ;;
  esac

  setup_providers

  printf '\n'
  info "Done. Next steps:"
  if [ "$harness" = "heddle" ]; then
    printf '  %s./dist/heddlework /path/to/repository%s   # native desktop\n' "$BOLD" "$RESET"
    printf '  %sbun run demo /path/to/repository%s        # no credentials, no Pi process\n' "$BOLD" "$RESET"
    printf '  %sbun run host /path/to/repository%s        # headless web workspace (see Dockerfile)\n' "$BOLD" "$RESET"
    if is_interactive && [ "$(uname -s)" = "Linux" ]; then
      printf '  %sHEDDLEWORK_PI="$(command -v pi)" ./packaging/linux/install-user.sh%s  # app menu entry\n' "$BOLD" "$RESET"
    fi
  else
    printf '  %spi /path/to/repository%s                  # start the TUI\n' "$BOLD" "$RESET"
    printf '  %s/fabric%s inside Pi opens the Fabric dashboard; /fabric settings tunes it\n' "$BOLD" "$RESET"
  fi
  if [ -n "$CUSTOM_ENDPOINT_NAME" ]; then
    printf '  %sHEDDLEWORK_PROVIDER=%s HEDDLEWORK_MODEL=%s bun run start%s   # custom endpoint\n' "$BOLD" "$CUSTOM_ENDPOINT_NAME" "$CUSTOM_ENDPOINT_MODEL" "$RESET"
  fi
  printf '  %spi /login%s subscribes OAuth providers (Copilot etc.); API keys above are already wired\n' "$BOLD" "$RESET"
}

main "$@"
