# Heddlework — headless web workspace host
#
# Serves the browser/PWA client over the same controller the native window
# uses. No Rust/GPUIX toolchain is needed: this image builds the web client
# and drives Pi as an RPC sidecar (pi-fabric included).
#
# Build:
#   docker build -f Dockerfile -t heddlework:latest .
#
# Run (the pairing URL is printed at startup; keep it private):
#   docker run --rm -p 4817:4817 \
#     -e HEDDLEWORK_HOST_PRINT_TOKEN=1 \
#     -e HEDDLEWORK_HOST_ORIGINS=http://localhost:4817 \
#     -e ANTHROPIC_API_KEY=sk-ant-... \
#     -v "$PWD:/workspace" -v heddlework-state:/state \
#     heddlework:latest
#
#   Open the printed http://127.0.0.1:4817/#token=… URL.

# ---------------------------------------------------------------------------
# deps — workspace dependencies from the lockfile
# ---------------------------------------------------------------------------
FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# web — build the browser client (the only artifact the host serves)
# ---------------------------------------------------------------------------
FROM deps AS web
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN bun run build:web

# ---------------------------------------------------------------------------
# pi — Node.js + Pi + pi-fabric, with the extension payload staged in /opt
# ---------------------------------------------------------------------------
FROM node:24-slim AS pi
# Install pi-fabric into a skeleton agent dir; the entrypoint seeds /state
# from it on first boot so mounted state can take over afterwards.
ENV PI_CODING_AGENT_DIR=/opt/pi-agent
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
 && pi install npm:pi-fabric

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM oven/bun:1.4 AS runtime
LABEL org.opencontainers.image.title="heddlework" \
      org.opencontainers.image.description="Heddlework headless web workspace host with Pi + pi-fabric" \
      org.opencontainers.image.source="https://github.com/monotykamary/heddlework" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep util-linux \
 && rm -rf /var/lib/apt/lists/*

# Node runs the Pi sidecar; the launcher is a stable wrapper around the
# published bin path (dist/bundle/cli.js).
COPY --from=pi /usr/local/bin/node /usr/local/bin/node
COPY --from=pi /usr/local/lib/node_modules/@earendil-works/pi-coding-agent /usr/local/lib/node_modules/@earendil-works/pi-coding-agent
RUN printf '#!/bin/sh\nexec /usr/local/bin/node /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js "$@"\n' > /usr/local/bin/pi \
 && chmod 755 /usr/local/bin/pi

# pi-fabric extension payload, seeded into persistent state on first boot.
COPY --from=pi --chown=bun:bun /opt/pi-agent /opt/pi-agent

RUN mkdir -p /state /workspace /app/dist/web \
 && chown -R bun:bun /state /workspace /app

WORKDIR /app
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=web --chown=bun:bun /app/dist/web ./dist/web
COPY --chown=bun:bun src/host ./src/host
COPY --chown=bun:bun src/protocol ./src/protocol
COPY --chown=bun:bun src/core ./src/core
COPY --chown=bun:bun src/flows ./src/flows
COPY --chown=bun:bun src/pi ./src/pi
COPY --chown=bun:bun src/workbench ./src/workbench
COPY --chown=bun:bun src/terminal ./src/terminal
COPY --chown=bun:bun src/workspace ./src/workspace
COPY --chown=bun:bun src/ui/format-time.ts ./src/ui/format-time.ts
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

# A custom OpenAI-compatible endpoint is configured by the installer's
# config-only mode, so the container and a desktop install write the same
# models.json instead of drifting apart. curl above is what lets that mode
# probe the endpoint (HEDDLEWORK_OPENAI_CHECK) the way the entrypoint does.
COPY install.sh /opt/heddlework/install.sh

# The entrypoint starts as root only to drop privileges (HOST_UID/HOST_GID
# remapping for bind-mounted workspaces); it execs bun as uid 1000 or the
# requested identity and never runs the workspace host as root.

EXPOSE 4817
VOLUME ["/state"]
WORKDIR /workspace

# Non-loopback binding requires an explicit network opt-in plus exact origins.
ENV NODE_ENV=production \
    XDG_STATE_HOME=/state/xdg-state \
    XDG_CACHE_HOME=/state/xdg-cache \
    PI_CODING_AGENT_DIR=/state/pi/agent \
    HOST_UID=1000 \
    HOST_GID=1000 \
    HEDDLEWORK_HOST=1 \
    HEDDLEWORK_HOST_PORT=4817 \
    HEDDLEWORK_HOST_BIND=0.0.0.0 \
    HEDDLEWORK_HOST_ALLOW_NETWORK=1

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:4817/health'); if (!r.ok) throw new Error('unhealthy'); await r.json()"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/workspace"]
