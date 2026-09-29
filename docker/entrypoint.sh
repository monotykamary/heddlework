#!/bin/sh
# Heddlework container entrypoint.
#
#   entrypoint.sh [WORKSPACE_DIR]
#
# Responsibilities:
#   1. HEDDLEWORK_HOST_ORIGINS must be set for the non-loopback bind; fail
#      fast with an actionable message instead of a stack trace.
#   2. Seed persistent state (/state) from /opt/pi-agent on first boot so
#      pi-fabric travels with mounted state; existing state is never touched.
#   3. Optionally re-map the runtime user to HOST_UID/HOST_GID so bind-mounted
#      workspaces stay writable (agents write files, run git, and Pi records
#      sessions); then launch src/host/main.ts with Pi as an RPC sidecar.
set -eu

WORKSPACE=${1:-${HEDDLEWORK_CWD:-/workspace}}
export HEDDLEWORK_CWD="$WORKSPACE"
AGENT_DIR=${PI_CODING_AGENT_DIR:-/state/pi/agent}

if [ ! -d "$WORKSPACE" ]; then
  echo "entrypoint: workspace directory does not exist: $WORKSPACE" >&2
  exit 1
fi

if [ -z "${HEDDLEWORK_HOST_ORIGINS:-}" ]; then
  echo "entrypoint: HEDDLEWORK_HOST_ORIGINS is required (comma-separated exact browser origins)" >&2
  echo '  e.g. -e HEDDLEWORK_HOST_ORIGINS=http://localhost:4817' >&2
  exit 1
fi

if [ "${HEDDLEWORK_HOST_PRINT_TOKEN:-0}" != "1" ]; then
  echo "entrypoint: hint — set HEDDLEWORK_HOST_PRINT_TOKEN=1 to print the pairing URL" >&2
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "entrypoint: pi was not found on PATH" >&2
  exit 1
fi
export HEDDLEWORK_PI="$(command -v pi)"

# First boot only: copy the pi-fabric extension payload into persistent state.
# A marker file keeps restarts idempotent; pre-seeded mounted state wins.
if [ ! -f "$AGENT_DIR/.heddlework-seeded" ]; then
  mkdir -p "$AGENT_DIR"
  if [ -d /opt/pi-agent ] && [ -n "$(ls -A /opt/pi-agent 2>/dev/null)" ]; then
    cp -Rn /opt/pi-agent/. "$AGENT_DIR/" 2>/dev/null || true
  fi
  touch "$AGENT_DIR/.heddlework-seeded"
fi

# Optional custom OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, LiteLLM,
# a gateway). This reuses the installer's config-only mode, which accepts the
# same HEDDLEWORK_OPENAI_* variables; the workspace user takes ownership of the
# files afterwards so they stay editable inside the container.
#
# The endpoint is probed, and then exercised through Pi itself — a chat answer,
# a tool call, and a whole turn that reads a file and edits it — but none of it
# is fatal here: the server it points at often starts after the container does
# (or lives on the host behind host.docker.internal), and a container that
# refuses to boot is worse than a logged warning. Set
# HEDDLEWORK_OPENAI_CHECK=require to make it fatal anyway.
if [ -n "${HEDDLEWORK_OPENAI_BASE_URL:-}" ]; then
  HEDDLEWORK_OPENAI_CHECK=${HEDDLEWORK_OPENAI_CHECK:-warn}
  export HEDDLEWORK_OPENAI_CHECK
  if sh /opt/heddlework/install.sh --write-model-config; then
    [ "$(id -u)" = "0" ] && chown "${HOST_UID:-1000}:${HOST_GID:-1000}" "$AGENT_DIR"/*.json 2>/dev/null || true
  else
    echo "entrypoint: warning — could not write $AGENT_DIR/models.json" >&2
  fi
fi

# Bind-mounted workspaces carry the host's numeric UID/GID. When the caller
# provides HOST_UID/HOST_GID, clone the shipped `bun` user's identity to match
# and take over /state, so Pi and agent tooling can write the workspace and
# persisted state stays owned. The container starts as root and drops
# privileges here; `docker run --user` skips all of this.
cd /app
if [ "$(id -u)" = "0" ]; then
  RUN_UID=${HOST_UID:-1000}
  RUN_GID=${HOST_GID:-1000}
  if [ "$RUN_UID" != "1000" ] || [ "$RUN_GID" != "1000" ]; then
    groupmod -o -g "$RUN_GID" bun 2>/dev/null || groupadd -o -g "$RUN_GID" heddlework
    usermod -o -u "$RUN_UID" -g "$RUN_GID" -d /home/bun bun 2>/dev/null \
      || useradd -o -u "$RUN_UID" -g "$RUN_GID" -d /home/bun -s /bin/sh heddlework
    chown -R "$RUN_UID:$RUN_GID" /state /app/dist/web /app/src 2>/dev/null || true
  fi
  exec setpriv --reuid "$RUN_UID" --regid "$RUN_GID" --init-groups \
    env HOME=/home/bun bun src/host/main.ts "$WORKSPACE"
fi

# Bun runs src/host/main.ts directly; the compiled web client is served from /app/dist/web.
exec bun src/host/main.ts "$WORKSPACE"
