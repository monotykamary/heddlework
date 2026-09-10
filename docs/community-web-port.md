# Community web port

## Status and source

The browser client is a source preview. It renders the shared workbench UI through the DOM host in `src/dom/`, connects to the authenticated workspace host in `src/host/`, and uses the versioned messages in `src/protocol/`.

This work cherry-picks and adapts the web/host/DOM implementation from the MIT-licensed [0xCUB3 Heddlework fork](https://github.com/0xCUB3/heddlework) at `d55e9adb26ff25f31223f588b118393ae1125f6d`. The port takes implementation code and tests only. It does not import the fork's artwork, branding or product-opinion copy, release channels, native iOS client, host switcher, Tailscale automation, plugin platform, or unrelated roadmap changes.

The runtime architecture remains this repository's architecture. When remote access is enabled in `src/main.tsx`, the host receives the same `WorkbenchController`, Flow runtime, and terminal service used by the native window. `src/host/main.ts` composes those same services for a headless process. The port does not use the fork's session-bundle runtime and does not attach to an independently running Pi TUI. Pi RPC remains authoritative through the existing controller.

## Run on the host computer

Remote access in the desktop process is off by default. The simplest development path builds the web client, watches `src/`, starts a loopback host, and prints a pairing URL:

```bash
bun install --frozen-lockfile
HEDDLEWORK_DEMO=1 bun run dev:web -- /path/to/repository
```

Remove `HEDDLEWORK_DEMO=1` to launch the configured Pi executable. For a non-watching headless host:

```bash
bun run build:web
HEDDLEWORK_HOST_PRINT_TOKEN=1 bun run host -- /path/to/repository
```

Open the printed `http://127.0.0.1:4817/#token=…` URL on that computer. `bun run build:web` writes `dist/web`; the host finds that directory automatically. `HEDDLEWORK_WEB_ROOT=/absolute/path` can select a different built shell.

To expose the web client from the native desktop process instead, build it and opt in for that process:

```bash
bun run build:web
HEDDLEWORK_HOST=1 HEDDLEWORK_HOST_PRINT_TOKEN=1 bun run start -- /path/to/repository
```

Outside demo mode, the pairing token is persisted in the platform Heddlework state directory as `host-token`; demo mode uses an in-memory token. Set `HEDDLEWORK_HOST_PRINT_TOKEN=1` only where process output is private.

## LAN and TLS access

Non-loopback binding requires both an explicit network opt-in and at least one exact browser origin. For a trusted private LAN, replace `192.168.1.20` with the host computer's address:

```bash
bun run build:web
HEDDLEWORK_HOST_BIND=0.0.0.0 \
HEDDLEWORK_HOST_ALLOW_NETWORK=1 \
HEDDLEWORK_HOST_ORIGINS=http://192.168.1.20:4817 \
HEDDLEWORK_HOST_PRINT_TOKEN=1 \
bun run host -- /path/to/repository
```

A wildcard bind prints a loopback URL. On the phone, open `http://192.168.1.20:4817/#token=…` using the fragment from the printed URL. Origins are comma-separated, exact `http://` or `https://` origins; paths do not broaden access.

Plain HTTP sends the WebSocket authentication protocol without transport encryption. Use it only on a network you trust. A phone-installable PWA, browser clipboard APIs, and other secure-context features normally require HTTPS.

The host does not terminate TLS. Put an HTTPS reverse proxy on the same computer and proxy both ordinary requests and WebSocket upgrades. For example, a Caddy site can be:

```caddyfile
workbench.example.net {
  reverse_proxy 127.0.0.1:4817
}
```

Then run the loopback host with the public TLS origin allowed:

```bash
bun run build:web
HEDDLEWORK_HOST_ORIGINS=https://workbench.example.net \
HEDDLEWORK_HOST_PRINT_TOKEN=1 \
bun run host -- /path/to/repository
```

Open `https://workbench.example.net/#token=…` using the printed fragment. If the TLS proxy is on another machine, also bind a private interface and set `HEDDLEWORK_HOST_ALLOW_NETWORK=1`; firewall the host port so only the proxy can reach it.

## Authentication and containment

- Pairing credentials belong in the URL fragment. The browser removes `host` and `token` fragments from history after reading them and keeps the token in `sessionStorage`, so it is scoped to the tab.
- Legacy `?token=` query authentication is rejected. Browser WebSockets authenticate with the `auth.<token>` WebSocket subprotocol; non-browser clients may use `Authorization: Bearer <token>`.
- The service worker refuses credential-bearing query requests and never handles `/ws`, `/health`, or `/api/` as app-shell content. It caches only public shell assets; workspace data and commands are never available offline.
- Loopback is the default bind. A non-loopback bind requires `HEDDLEWORK_HOST_ALLOW_NETWORK=1` and `HEDDLEWORK_HOST_ORIGINS`.
- Static files are resolved under the real build root. Lexical traversal and symlinks escaping that root are rejected. Missing asset paths return `404`; the HTML shell fallback is limited to extensionless document navigations.
- Commands are parsed against a bounded command union, queued per socket, and deduplicated by the pair of client ID and request ID across reconnects. Image byte metadata must match its base64 payload, and oversized image data (including embedded data-URL previews) is omitted from snapshots.

A pairing token grants the browser the same workspace command authority as the local UI, including terminal input and agent controls. Treat the URL fragment and token file as secrets.

## Current terminal path

The web terminal is not a second PTY implementation. The host's existing `TerminalSessionService` owns the PTY and VT parser. The host serializes terminal session metadata and bounded text frames over the workspace socket. `WorkspaceClient` retains frames only for IDs present in the latest authoritative terminal snapshot, and `RemoteTerminalService` projects them back into the shared `TerminalView`, whose DOM fallback paints a text-cell grid and forwards keyboard, composition, paste, resize, and close commands to the host.

Terminal frame delivery is coalesced to roughly 33 ms. A frame contains at most 80 viewport rows and 240 text characters per row; terminal command dimensions are clamped to 240 columns by 80 rows. Browser panes arbitrate resize ownership locally by the most recently focused view. The host applies browser resizes as ownerless programmatic updates, so they do not claim a native bottom or right placement; the most recently focused native view remains the native size owner and can reapply its dimensions. This is not a global cross-client size lease. Closed terminals, reconnect generations, and disconnected hosts do not retain old grids.

## Performance scope

The accepted performance work in this port is bounded transport and disclosure behavior, not a benchmark claim:

- initial transcript disclosure is the newest 400 messages; each earlier-page request adds 120, with a hard per-socket ceiling of 1,200;
- unchanged top-level snapshot fields are omitted from patches, while a changed collection is currently sent as a whole collection;
- a WebSocket frame is at most 256 KiB; an assembled message is at most 32 MiB and 256 frames; an assembler allows at most four pending messages, 40 MiB total pending data, and 15 seconds before expiration;
- each serialized server message is capped by the 32 MiB assembly limit and is sent incrementally in 256 KiB frames; Bun's server-side `getBufferedAmount()` is held to 8 MiB, at most another 8 MiB of complete messages may wait behind the active message, and any message still queued after 30 seconds closes the slow client;
- the client pauses command flushing above 2 MiB buffered data, retains at most 128 pending commands, and the host admits at most 32 queued commands per socket;
- replay protection retains at most 500 request entries with fixed-size SHA-256 command fingerprints and refuses new unique requests rather than dropping protection for commands that are still running;
- terminal publication uses the bounded/coalesced path described above, and transcript rows use the DOM virtual-list host.

Excluded from the scope are the community fork's lazy multi-session runtime, live attachment to an external Pi TUI, inactive session bundles, prepend-delta history protocol, and native GPU terminal optimizations. No numerical browser throughput, memory, startup, or physical-phone performance claim is made. The Happy DOM and Chromium probes are functional checks, not performance benchmarks.

## Mobile limitations

The current mobile surface is the responsive browser app, not a native iOS or Android client.

- Validation covers a Chromium mobile viewport and touch-sized controls. It does not validate Safari's or Android's real software keyboard, IME, background suspension, or installed-PWA lifecycle on physical devices.
- The remote terminal sends plain viewport text. ANSI cell colors, attributes, native glyph rendering, and scrollback are not transported; remote scrollback controls are no-ops.
- The native embedded-browser surface is unavailable in the DOM host. Folder picking and opening host filesystem paths remain desktop-only.
- Offline support caches only the app shell. A live host connection is required to read workspace state or issue commands, and commands are not queued for later offline delivery.
- Clipboard text and image access depends on HTTPS, browser permission, and platform policy. Closing the tab loses the session-scoped token and requires pairing again.
- The host process must remain running and continues to own the repository, Pi process, terminal processes, and persistence. The phone never receives direct filesystem access.

## Validation

Run the bounded web suite without the full native suite:

```bash
bun run typecheck
bun run typecheck:web
bun run test:web
bun run build:web
```

`test:web` runs protocol, authorization/replay, service-worker, host/platform, client lifecycle, and Happy DOM end-to-end checks. `bun run test:browser` is the optional Chromium terminal probe and requires an installed Playwright Chromium plus a real PTY. It creates the terminal through the browser, checks initial sizing, shared picker dismissal, IME commit ordering and cancellation, correction suppression, and verifies that background output neither steals composer focus nor repeats PTY resizes. WebKit-style `insertFromComposition` events are synthesized because Chromium normalizes that input type; this is not a physical-device IME certification.
