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
#         HEDDLEWORK_OPENAI_NAME, HEDDLEWORK_OPENAI_KEY.
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

bun_is_supported() {
  bun_version=$(bun --version 2>/dev/null) || return 1
  # Stable Bun 1.4.0+ matches the CI baseline and reads the checked-in lockfile.
  printf '%s\n' "$bun_version" | awk -F. '{
    exit !($0 ~ /^[0-9]+\.[0-9]+\.[0-9]+$/ && ($1 > 1 || ($1 == 1 && $2 >= 4)))
  }'
}

need_bun() {
  bun_is_supported && return 0
  info "Bun 1.4.0+ (stable) is required to build Heddlework; detected: ${bun_version:-not found}"
  if is_interactive; then
    printf 'Install or upgrade Bun now (curl -fsSL https://bun.sh/install | bash)? [y/N] '
    read -r answer || answer=''
    case "$answer" in
      y|Y|yes|YES)
        if curl -fsSL https://bun.sh/install | bash; then
          export PATH="$HOME/.bun/bin:$PATH"
          bun_is_supported && return 0
        fi
        warn "Bun installation did not provide a supported version; detected: ${bun_version:-not found}"
        ;;
    esac
  fi
  warn "install Bun 1.4.0 or newer from https://bun.sh, ensure it is on PATH, then rerun this installer"
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
# Custom OpenAI-compatible endpoint — writes <agent-dir>/models.json
#
# Pi reaches a non-default endpoint through models.json rather than an
# environment variable: "providers.<id>" carries baseUrl, api, apiKey, and the
# model ids to expose. A dedicated provider id leaves the built-in OpenAI
# catalog intact, so both stay selectable in /model. Existing providers in the
# file are preserved.
# ---------------------------------------------------------------------------
MODELS_FILE="$PI_DIR/models.json"

MODELS_STORE_SCRIPT='const fs=require("node:fs");let config={};try{config=JSON.parse(fs.readFileSync(process.env.PI_MODELS_FILE,"utf8"))}catch{};if(!config||typeof config!=="object"||Array.isArray(config))config={};if(!config.providers||typeof config.providers!=="object"||Array.isArray(config.providers))config.providers={};config.providers[process.env.PI_MODELS_PROVIDER]={baseUrl:process.env.PI_MODELS_BASE_URL,api:process.env.PI_MODELS_API,apiKey:process.env.PI_MODELS_API_KEY,models:process.env.PI_MODELS_IDS.split(",").filter(Boolean).map(id=>({id}))};fs.writeFileSync(process.env.PI_MODELS_FILE,JSON.stringify(config,null,2)+"\n",{mode:0o600})'

provider_env_name() { # provider_env_name <provider-id> -> CUSTOM_OPENAI_API_KEY
  printf '%s_API_KEY' "$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')"
}

write_models_entry() { # write_models_entry <provider> <base-url> <api> <api-key> <model-ids>
  mkdir -p "$PI_DIR"
  export PI_MODELS_FILE="$MODELS_FILE" PI_MODELS_PROVIDER="$1" PI_MODELS_BASE_URL="$2" \
    PI_MODELS_API="$3" PI_MODELS_API_KEY="$4" PI_MODELS_IDS="$5"
  run_js "$MODELS_STORE_SCRIPT" "$MODELS_FILE"
  unset PI_MODELS_FILE PI_MODELS_PROVIDER PI_MODELS_BASE_URL PI_MODELS_API PI_MODELS_API_KEY PI_MODELS_IDS
  chmod 600 "$MODELS_FILE" 2>/dev/null || true
}

write_custom_endpoint() { # write_custom_endpoint <name> <base-url> <api> <model-ids> [key]
  custom_name=$1
  custom_base_url=$2
  custom_api=$3
  custom_models=$4
  custom_key=${5:-}

  case "$custom_base_url" in
    http://*|https://*) ;;
    *) warn "$custom_base_url has no http:// or https:// scheme; Pi appends request paths to it" ;;
  esac

  if [ -n "$custom_key" ]; then
    # Pi resolves a stored credential by provider id, so the secret lives in
    # auth.json. models.json only references an environment variable, which keeps
    # the same endpoint usable where there is no auth.json (CI, containers).
    write_auth_entry "$custom_name" "$custom_key"
    custom_key_ref='${'"$(provider_env_name "$custom_name")"'}'
  elif [ -n "${OPENAI_API_KEY:-}" ]; then
    # A gateway fronting the same protocol usually reuses the OpenAI key.
    write_auth_entry "$custom_name" "$OPENAI_API_KEY"
    custom_key_ref='${OPENAI_API_KEY}'
  else
    # Local servers ignore credentials, but a missing key hides the models from
    # /model, so a literal placeholder keeps them selectable.
    custom_key_ref='local'
  fi

  write_models_entry "$custom_name" "$custom_base_url" "$custom_api" "$custom_key_ref" "$custom_models"
  CUSTOM_ENDPOINT_NAME=$custom_name
  CUSTOM_ENDPOINT_MODEL=$(printf '%s' "$custom_models" | cut -d, -f1)
  info "$custom_name -> $custom_base_url (api: $custom_api, models: $custom_models)"
  if [ -n "$custom_key" ]; then
    info "key stored in $AUTH_FILE; export $(provider_env_name "$custom_name") where that file is unavailable"
  fi
}

write_custom_endpoint_from_env() {
  [ -n "${HEDDLEWORK_OPENAI_BASE_URL:-}" ] || die "HEDDLEWORK_OPENAI_BASE_URL is not set"
  [ -n "${HEDDLEWORK_OPENAI_MODEL:-}" ] || die "HEDDLEWORK_OPENAI_MODEL is required alongside HEDDLEWORK_OPENAI_BASE_URL (comma-separate several model ids)"
  write_custom_endpoint \
    "${HEDDLEWORK_OPENAI_NAME:-custom-openai}" \
    "$HEDDLEWORK_OPENAI_BASE_URL" \
    "${HEDDLEWORK_OPENAI_API:-openai-completions}" \
    "$HEDDLEWORK_OPENAI_MODEL" \
    "${HEDDLEWORK_OPENAI_KEY:-}"
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
  read_hidden 'API key (input hidden; press Enter for a local endpoint without auth): '
  write_custom_endpoint "$custom_name" "$custom_base_url" "$custom_api" "$custom_models" "$HIDDEN_INPUT"
}

CUSTOM_ENDPOINT_NAME=''
CUSTOM_ENDPOINT_MODEL=''

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
