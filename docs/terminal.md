# Terminal

Heddlework owns PTY sessions in-process. The byte stream, VT state, and painter are separate so desktop can use native GPUI today while a future web/mobile client can keep the same session contract and substitute a WASM VT engine and browser painter.

## Placements

- **Bottom dock** — layout-owned in `WorkbenchApp`; sessions stay alive when the dock closes.
- **Right surface** — the existing `terminal` workbench surface.
- Both placements share `TerminalSessionService`. The most recently focused placement owns PTY rows and columns. When the bottom placement enters fullscreen, an open right terminal stays alive but its hidden projection is suspended so one session is not staged and painted twice.

## Runtime

- Default backend: `Bun.Terminal` through `BunPtyBackend`.
- Platform adapters can inject the exported `TerminalBackend` contract.
- Tests use `MemoryTerminalBackend` or a push-driven backend.
- `subscribe()` remains the compatibility channel for every published update. Renderers should use `subscribeFrames(listener)` (which supplies the changed session ID); chrome and plugins that only need sessions, selection, status, titles, or appearance should pair `subscribeState()` with `getStateSnapshot()` to avoid frame-rate updates.
- Shell: `$SHELL -l` (or `cmd.exe` on Windows), with `TERM=xterm-256color` and `COLORTERM=truecolor`.

## Output and presentation pacing

Heddlework follows the important invariants from Localterm without moving browser-specific xterm behavior into the native app:

1. `Bun.Terminal` can fragment a dense frame into hundreds of roughly 1 KiB callbacks. `TerminalOutputBuffer` copies those fragments into reusable buffers, finds DEC 2026 boundaries across arbitrary splits, and delivers each completed synchronized frame to the VT parser once. Adjacent end/start markers in one transport chunk remain separate frames.
2. Ordinary output flushes at microtask latency, so prompts and device-status/capability queries are not delayed behind a paint callback. A one-second ingress escape hatch forwards an abandoned synchronized frame instead of retaining bytes indefinitely.
3. Ordinary frame notifications are coalesced to an 8 ms (~125 Hz) deadline. The deadline is measured from the previous frame start, so native paint work does not accumulate on top of every interval. Parsing never runs inside the timer. Session-scoped frame listeners are independent from structural state listeners: terminal tabs and chrome do not enter React for animated output, while the direct native surface projects and stages the completed grid synchronously before the next React or GPUI flush. Browser and older-native fallbacks consume the same frame channel through `useSyncExternalStore`.
4. DEC private mode 2026 holds the last committed grid while a synchronized frame is incomplete. `TerminalOutputBuffer` preserves a completed-frame tag when it joins fragmented PTY callbacks, so the service publishes that frame immediately instead of accidentally passing it through the ordinary 60 Hz-era deadline. A one-second stale escape hatch prevents a broken application from freezing the surface indefinitely without exposing healthy, high-volume frames halfway through.
5. User input can preempt a held synchronized frame. The first response of at most 8 KiB within 500 ms of input also publishes immediately, preserving prompt and completion latency without making an unrelated output firehose synchronous. A detached scrollback viewport remains anchored as new rows arrive, and explicit terminal input returns to the live tail.

`VtEmulator` parses complete CSI controls directly from a decoded chunk and falls back to its incremental state machine when a sequence straddles chunks. A complete DEC 2026 OpenTUI frame gets an additional byte-native fast path matching the upstream native renderer: the synchronized hide-cursor envelope, absolute changed-run cursors, RGB/indexed/default colors, independent text attributes, and mixed ASCII or UTF-8 glyph runs are consumed directly from the PTY `Uint8Array`. One-glyph changed runs—the dominant framebuffer shape when adjacent cell colors differ—decode and commit once. Wide glyphs, combining sequences, and contiguous runs retain canonical VT cell semantics. The grammar stops at the first mismatch and decodes only that remainder through the canonical parser, avoiding a multi-megabyte transient UTF-16 string without changing partial or ordinary output behavior. Mutable pen colors and the screen, alternate screen, and scrollback backing rows use tagged four-word `Uint32Array` cells rather than per-cell JavaScript objects. Sparse maps retain only multi-codepoint graphemes, including across insertion, deletion, erase, scrollback, and resize. Erase operations retain the active rendition (BCE), so inverse and explicit-background TUI rows reach the final column. `snapshot()` copies only changed packed rows by mutable-row revision. Native projection reads those rows directly; public `TerminalRow` objects and color unions are materialized lazily only for the React fallback, copy, or tests. Historical snapshots remain immutable and unchanged public rows retain identity.

On a patched GPUIX runtime, `TerminalView` projects each session-scoped frame directly into a versioned binary payload: each cell is one 16-byte little-endian record containing a glyph reference, final foreground/background RGB, and flags. Multi-codepoint graphemes live in a small side table. Each terminal overwrites one aligned JavaScript cell buffer, and `setTerminalFrame(elementId, metadata, cells)` sends it through NAPI immediately, outside both React reconciliation and the React mutation JSON. The native call invalidates GPUI itself. The mailbox validates and copies arrivals but defers cell decoding, block rasterization, and text-run construction until GPUI consumes only the latest payload. Animated frames retain a stable image identity and update their same-sized Metal, WGPU, or DirectX atlas tile in place rather than reallocating it every paint. Older GPUIX builds retain the base64 single-prop native path; browser/unpatched runtimes retain the memoized React-run fallback.

Run the repeatable hot-path benchmarks with:

```bash
bun run benchmark:terminal
bun run benchmark:terminal:hires
```

The UI probe pre-encodes four fully changed frames outside the timed region, cycles them to bound fixture memory, fragments each into 1 KiB PTY callbacks, and measures synchronized scanning, packed VT mutation, direct projection/NAPI staging, the post-stage event-loop handoff, GPUI rasterization, layout, and paint. It mechanically verifies that every timed frame reached the direct transport without requiring a React commit; a separate 8→1 burst measures raw mailbox coalescing. The wire reproduces OpenTUI's DEC 2026 prefix, initial hidden-cursor control, absolute changed-cell cursors, truecolor foreground/background, mixed spaces and Unicode blocks, and SGR run resets—the shape used by the Golden Star workload. The high-resolution command covers 220×65, 320×90, 480×120, 640×180, and 960×240, and intentionally fails unless the patched native test renderer exposes the direct binary transport.

On the development machine, the native offscreen renderer is Retina (`100×50` logical pixels capture as `200×100`). A repeat matrix of the direct faithful path measured 1.73 ms median / 2.05 ms p95 at 220×65, 5.31 / 8.47 ms at 480×120, 8.93 / 11.39 ms at 640×180, and 18.09 / 26.54 ms at the deliberately extreme 960×240 grid. Even at 960×240, eight raw arrivals coalesced into one raster/upload in 3.09 ms median. At 2× scale with the current 7.83×17 logical-cell metrics, the 480×120 terminal surface is already approximately 7549×4104 physical pixels; 960×240 is approximately 15066×8184, near Metal's maximum texture dimension and much larger than a 5K fullscreen terminal. The 640×180 case remains below a 16.7 ms frame budget through p95. A three-second full-workbench Golden Star probe delivered 169 PTY frames at 56.3 producer FPS as exactly 169 session notifications and 169 native stages, with zero structural notifications or React commits; the terminal callback measured 0.20 ms median / 0.29 ms p90. Treat timings as hardware-dependent; synchronized provenance, realistic byte ingress, pre-commit direct staging, direct-transport capability, raw-mailbox coalescing, workload shape, node count, immutable row reuse, and single visible projection are the structural guards.

### Live GPUIX window harness

The offscreen probes deliberately remove the operating-system event loop. Use the live harness when the problem only appears in a real, maximized, or Retina window:

```bash
bun run benchmark:terminal:gpuix -- --fullscreen --duration 15 --overlay full --report screenshots/terminal-gpuix-live.json
```

The command creates a production `GpuixRenderer`, uses Heddlework's real window options and `startFrameLoop`, mounts the production `TerminalView`, and runs a real `Bun.Terminal` PTY. When the sibling `../opentui-examples` executable exists, the harness starts it and selects **Golden Star Demo**. Otherwise, `--fixture` is implied and a bundled 60 FPS DEC 2026 truecolor framebuffer producer supplies a deterministic full-grid workload. Use `--help` for custom commands, logical window dimensions, warmup, focus, and report options.

The one-second line and final `TERMINAL_GPUIX_REPORT` JSON expose every handoff independently:

- PTY complete-frame rate and wire MiB/s;
- session notifications and direct native stages, which must remain 1:1;
- service-to-stage time (packed projection) and the isolated NAPI call;
- actual GPUI draw count and native draw percentiles;
- React commits during animation;
- macOS `tick()` rate, latency, and wall occupancy, distinct from CPU use.

For an event-pump A/B with an identical producer and grid, run:

```bash
bun run benchmark:terminal:gpuix -- --fixture --duration 10 --frame-ms 8
bun run benchmark:terminal:gpuix -- --fixture --duration 10 --frame-ms 33
```

On the development machine at 800×600, the default 8 ms loop delivered approximately 23 producer/service/stage/draw FPS even though every pipeline ratio was exactly 1.0 and GPUI draw p90 was about 0.30 ms. `tick()` itself occupied roughly 93% of wall time at a 15.6 ms median. The 33 ms diagnostic delivered approximately 55 FPS with a 0.27 ms GPUI draw p90, zero animated React commits, and 3.5% tick wall occupancy. This isolates the remaining live-window slowdown to the embedded macOS event pump starving Bun's PTY/JavaScript loop, rather than terminal projection, retained nodes, rasterization, or texture upload. The 33 ms mode is an A/B diagnostic, not a production fix: it lowers AppKit pump frequency while proving where the contention occurs.

## Native rendering versus xterm.js

The xterm.js/WebGL fork in Localterm is not copied into the desktop bundle. Instead, Heddlework adds the missing low-level primitive to GPUIX: one fixed-cell `<terminal>` host consumes compact complete frames through a coalescing binary mailbox and paints directly into the GPUI scene.

The native surface preserves terminal geometry rather than treating the grid as flexbox text:

- one nearest-sampled `(cols × 2) × (rows × 2)` BGRA texture paints cell backgrounds plus exact half-block, quadrant, and shade masks, including BCE highlights through the rightmost column;
- ordinary and double-width glyphs retain explicit column positions at fractional cell coordinates;
- shaping is cached by text and font geometry, not ANSI color, then cached glyph-atlas masks are painted directly with the current foreground;
- adjacent compatible cells remain one shaped run, preserving programming ligatures without per-cell retained nodes;
- cursor, underline, and strike are exact grid quads; framebuffer block elements bypass shaping and thousands of glyph draws by becoming quarter-cell texture pixels;
- disabling ligatures inserts zero-width non-joiners; Nerd Font ranges can use a separate family;
- bold base ANSI colors resolve to bright variants, and muted emoji requests text presentation (`VS15`).

This is the Localterm alpha-mask optimization in native form. GPUI caches ordinary glyph coverage in its monochrome atlas and applies terminal foreground color during GPU composition; changing ANSI color does not reshape text or create another atlas entry. There is no browser canvas polarity to reconstruct and no second xterm/WebGL atlas to maintain. Emoji that remain color presentation use GPUI's polychrome atlas; `VS15` routes supported muted forms through the monochrome coverage path. Platform color-font fallback can still override unsupported text-presentation sequences.

## Fonts and live settings

Settings → **Terminal** applies changes to every open terminal without restarting its PTY:

- primary installed font family;
- programming ligatures;
- Nerd Font symbol routing and fallback family;
- muted emoji.

The native text system resolves installed font family names. Heddlework does not bundle Localterm's WOFF2 webfonts because GPUix does not currently expose runtime font-byte registration to React hosts. A full Nerd Font can also be selected directly as the primary family.

Preferences are stored in `terminal.json` under the platform application configuration directory:

- macOS: `~/Library/Application Support/Heddlework/terminal.json`
- Windows: `%APPDATA%/Heddlework/terminal.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/heddlework/terminal.json`

Plugin hosts can override or disable the path through `createTerminalPlugin({ appearancePath })` and can provide initial values with `appearance`.

## Color, gamma, and light mode

The first 16 ANSI colors are theme anchors. Indices 16–255 are regenerated in CIELAB space as a 216-color cube plus a 24-step grayscale ramp, avoiding the harsh and low-contrast fixed xterm cube on light themes.

Light mode enforces a 4.5:1 minimum foreground/background contrast ratio using WCAG relative luminance. Color adjustment and dim compositing happen in linear sRGB rather than interpolating gamma-encoded channel bytes. Dim dark-on-light text uses the Localterm-derived 0.9 opacity policy and is checked again after blending; dark themes retain author colors and use the conventional 0.5 dim blend.

## GPUIX focus boundary

GPUix 0.7 removed its process-wide `Tab` and `Shift+Tab` traversal bindings. Both keys now reach the focused terminal's `onKeyDown` handler directly, while applications that want traversal can call `focusNext()` or `focusPrevious()` explicitly. Heddlework therefore no longer needs the temporary `captureTab` host prop, and its terminal UI regression always sends both Tab variants through the native input pipeline.

The desktop runtime is provisioned with `bun run setup:native` from the immutable GPUix/Zed revisions in `gpuix-runtime.json`. The installer builds matching native and React packages, preserves the application React singleton, and verifies the terminal/window APIs. Desktop startup rejects incompatible stock GPUix rather than silently losing terminal or window behavior. `patches/gpuix-0.7.0-heddlework.patch` is a historical patch against the published 0.7.0 baseline, not the current installation recipe; do not apply it over the reconciled upstream sources.

The renderer still feature-detects `supportsNativeTerminal()` to choose the native painter or the portable grid fallback. This painter fallback does not substitute for installing a compatible desktop runtime.

## Native frame pipeline

The desktop renderer keeps framebuffer backgrounds and block graphics in one stable nearest-sampled atlas image. After the first paint, GPUIX prepares the newest packed frame at the NAPI boundary and compares only primitives that remain in the GPUI scene: shaped text, visible cursor, dimensions, and text geometry. Box-drawing backgrounds are excluded because the updated image already owns those pixels; foreground and glyph changes are not.

When that overlay is unchanged on macOS, GPUIX waits for the newest ordered Metal command-buffer submission to finish sampling the tile, updates the existing atlas tile, and presents the current scene directly. This completion fence prevents CPU `replace_region` writes from racing an in-flight GPU frame. The terminal frame still avoids React commits, root invalidation, retained-tree conversion, layout, prepaint, paint, and scene rebuilding. Overlay changes and failed atlas updates use the full path, and the latest prepared frame remains available for any unrelated redraw.

The embedded AppKit pump drains pending native events and ready CoreFoundation sources without waiting for a display-link wake. This matters because a blocking 8 ms polling loop previously occupied about 91% of Bun's wall time and reduced the Golden Star workload to roughly 13 staged frames per second. The nonblocking pump returns in well under a millisecond in the same harness and lets the terminal track the raw PTY producer ceiling. `bun run benchmark:terminal:gpuix -- --fullscreen --frame-ms 8 --duration 8` reports PTY, service, native-stage, GPUI-draw, stable-layer avoidance, tick-wall, and CPU rates for regressions.

## Web and mobile path

The browser client now reuses the existing terminal UI through a remote terminal-service adapter. The authenticated host owns the PTY and VT state, sends grid snapshots, and accepts bounded terminal input/resize commands. The DOM host provides browser composition/paste input and a mobile software-keyboard target; neither xterm.js nor a WASM runtime is required for this path.

Keep the following extension boundary for future companion renderers:

1. a host process owns the PTY and transports ordered bytes plus resize/input events;
2. Ghostty's VT core, compiled natively or to WASM, can replace `VtEmulator` behind the snapshot/session boundary;
3. each platform owns its painter: GPUI on desktop, a browser renderer on web, and a platform view on mobile. The packed cell contract is platform-neutral, uses a WASM-compatible decoder, and has validated WGPU/WebGL shader paths, so a GPUIX WebAssembly renderer can expose the same host element.

The Localterm xterm/WebGL work remains an appropriate browser implementation when GPUIX/WASM is not the UI host. Heddlework shares pacing, color, font, frame, and accessibility policy rather than importing browser renderer internals into desktop.
