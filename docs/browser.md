# Browser architecture

Heddlework's Browser surface is split between an engine-neutral TypeScript model
and a native GPUix host. On desktop macOS, GPUix embeds a native
`CefBrowserView` in a frameless, CEF-owned `CefWindow` attached to the GPUI
window. CEF Views owns the native close sequence, and no browser title bar or
nested tab strip is exposed. It does not use WKWebView or attach to Safari,
Chrome, or another browser's personal profile.

## Ownership

- `src/browser/service.ts` owns profiles, tabs, commands, history state, popup
  routing, geometry, and persistence.
- `src/browser/types.ts` is the renderer-neutral contract. The `remote` engine
  and `BrowserAutomationAdapter` boundary are reserved for a future host-backed
  web/mobile client.
- `src/ui/browser-panel.tsx` renders each browser session as a first-class tab in
  the main right-panel header, followed directly by the toolbar and content. It
  does not render a nested browser tab strip.
- `src/ui/browser-host.tsx` materializes one GPUix `<browser>` intrinsic per live
  tab and projects only the active tab into the panel's measured rectangle.
- GPUix's native `browser_cef` backend owns CEF initialization, request contexts,
  the BrowserView/Window hierarchy, focus, visibility, and command dispatch.

The panel can change size or enter fullscreen without recreating Chromium.
Heddlework publishes placement only when its measured rectangle changes. Hidden
and inactive tabs keep their native browser with `visible={false}` and retain
the last logical bounds (falling back to 1×1 only before the first show), so
navigation state survives tab switches without painting over GPUI controls.
Background tabs are not guaranteed job runners: Chromium may throttle timers
and pause animation frames while hidden. Hide/show must restore identity,
focus eligibility, and painting without a reload.

## Process model

Packaged `.app` builds run CEF in multi-process, sandboxed mode. Native Chromium
requires the current executable to be an immediate child of `Contents/MacOS` in
a bundle with an `Info.plist`, then performs a strict deep code-signature check.
In production it canonicalizes the bundle's
`Contents/Frameworks` directory, framework, framework binary, and helper, then
rejects any symlink chain that leaves the owning application bundle. Runtime
environment variables and package/source-tree CEF directories are ignored.
Chromium fails closed outside a valid macOS application bundle and does not
attempt to launch staged helpers from `bun run dev`, because CEF's macOS
rendezvous and sandbox model requires a coherent main bundle. Use the packaged
build workflow below to exercise Chromium. Unbundled development still renders
the Browser surface with an actionable unavailable-engine error.

The main Heddlework process owns the browser process and native child view.
Dedicated signed helper app variants run renderer, GPU, utility, plugin, and
alert roles. Popup creation is denied inside CEF and emitted to Heddlework as
`browserOpen`, where the service may create an isolated managed tab.

GPUix reports browser support through:

- `supportsNativeBrowser()`
- `nativeBrowserEngine()` (`chromium` maps to Heddlework's `cef` engine kind)
- `nativeBrowserProfileIsolation()` (`full` for CEF request contexts)

If the feature or runtime assets are missing, the right panel remains usable and
shows an unavailable-engine state. There is no silent WKWebView fallback.

`GPUIX_CEF_DEBUG=1` enables native lifecycle logging. The production addon
ignores CEF runtime, sandbox, and remote-debugging environment overrides. GPUix
library developers can compile its explicit `cef-development-overrides` feature;
only that build honors `GPUIX_CEF_REMOTE_DEBUGGING_PORT`, which opens an
unauthenticated local Chrome DevTools Protocol endpoint and must be limited to an
explicit development session.

## Profiles and persistence

Heddlework configures the allowed Chromium profile parent before the native
window opens:

```text
macOS:   ~/Library/Application Support/Heddlework/Browser/profiles
Windows: %LOCALAPPDATA%/Heddlework/Browser/profiles
Linux:   $XDG_DATA_HOME/heddlework/browser/profiles
```

`HEDDLEWORK_BROWSER_DATA_DIR` overrides the browser data root. Every persistent
CEF `profilePath` must be an immediate child of the configured profiles root;
GPUix rejects traversal, nested, or unrelated paths. This guarantees that CEF's
global root cache and per-context cache paths satisfy Chromium's ownership rules.
Private profiles use an in-memory request context, are never restored, and drop
that context after their last native tab closes.

The built-in policies are:

| Profile | Persistence | Agent access |
| --- | --- | --- |
| Workspace | Disk, app-owned | Allowed |
| Personal | Disk, app-owned | Denied |
| Private | Memory only | Denied |

Tab metadata and non-private session restoration live in
`~/Library/Application Support/Heddlework/browser.json` on macOS (with equivalent
platform config roots). The file is written atomically with mode `0600`.
Before reading state, Heddlework creates and canonicalizes the data root,
profiles root, and state parent. Process-lifetime locks cover those canonical
identities, so lexical and symlink aliases in separate processes contend for the
same profile/state stores. Native CEF and every profile operation receive the
same canonical profiles root covered by the lock. Contention fails closed before
reading state, exposing profile paths, initializing CEF, or writing metadata; it
never reclaims a lock held by a live process. Cookies,
cache, local storage, service workers, and credentials remain within the selected
CEF request context; they are not copied into Heddlework's metadata.

## Navigation and agent access

The service normalizes bare hosts and local development addresses, converts
other plain text into search URLs, and blocks unsupported schemes before a
command reaches CEF. `clearData` clears cookies, HTTP cache, certificate
exceptions, and HTTP-auth credentials. Removing a profile queues its entire
app-owned directory for deletion after native CEF teardown; a valid persisted
state also cleans orphaned profile directories on the next cold start. Browser
commands use an ordered FIFO with monotonically increasing serials and native
acknowledgements, so one React commit cannot collapse adjacent actions and a
rerender cannot execute an acknowledged action twice. CEF reports URL, title,
loading, back/forward availability, and the completed command serial
asynchronously to the owning tab. Each logical tab/profile incarnation has a
process-global monotonic generation that is not reset by hot reload. Heddlework
passes it into the native surface, GPUix stamps state, popup, and error events
with it, and the service rejects callbacks from an
older generation. This prevents queued events from a destroyed profile surface
from mutating or opening tabs in its replacement.

Agent automation is a separate capability from user interaction. Workspace
profiles allow it, personal/private profiles deny it, and a `prompt` policy
requires an unexpired explicit grant. The current native implementation exposes
user-driven browsing first; `BrowserAutomationAdapter` keeps later evaluate and
screenshot support behind the same policy gate.

CEF popups become independent app-managed tabs. They intentionally do not retain
`window.opener`, target features, referrer bodies, or POST data, so
opener-dependent OAuth/payment popup flows are not yet supported. Site permission
requests (camera, microphone, geolocation, notifications, Bluetooth, and
passkeys) and file downloads are also denied until Heddlework has an
origin-aware prompt, destination picker, and policy bridge; the app bundle does
not claim those entitlements.

## macOS build and packaging

Build the linked GPUix CEF feature once before packaging Heddlework:

```bash
cd ../gpuix-heddlework-0.7/packages/native
bun run build:browser
cd ../../../heddlework
bun run build
bun run smoke:browser
```

The smoke runner launches only the packaged app with its window hidden, serves a
loopback fixture, and requires native loads across persistent and private request
contexts, ordered clear/reload/focus acknowledgements, sandboxed helper roles,
CEF Views window destruction, and a clean CEF shutdown. It is the macOS
integration check for the real native backend; unit and offscreen UI tests
intentionally use a browser-disabled test renderer.

GPUix stages the pinned CEF framework, five helper bundles, and a hashed artifact
manifest in `packages/native/cef/`. Its macOS CI job runs the same
`build:browser --target aarch64-apple-darwin` path, archives `cef/` to preserve
modes and symlinks, uploads it with the native addon, and restores it before
publishing `@gpuix/native`. Publish CI then packs and extracts both the root and
Darwin platform npm packages and verifies every extracted CEF entry plus the
native addon against the manifest; a release cannot silently publish an
incomplete or browser-free macOS package.

On macOS, Heddlework's `scripts/build.ts` copies the runtime, loader, and addon
into a private staging directory with verbatim relative symlinks. It validates
that immutable snapshot, aliases Bun compilation to its verified native loader,
and packages only from the same snapshot. The schema-v2 verifier rejects any
missing, extra, modified, permission/special-mode-changed, or symlink-changed
entry across the complete CEF framework/helper tree. The build rechecks copied
framework symlink containment before signing and verifies the exact native
addon, architecture, and CEF API build before creating:

```text
dist/Heddlework.app/
  Contents/MacOS/Heddlework
  Contents/Frameworks/Chromium Embedded Framework.framework
  Contents/Frameworks/Heddlework Helper.app
  Contents/Frameworks/Heddlework Helper (Alerts).app
  Contents/Frameworks/Heddlework Helper (GPU).app
  Contents/Frameworks/Heddlework Helper (Plugin).app
  Contents/Frameworks/Heddlework Helper (Renderer).app
```

The local build signs the CEF framework, each renamed helper, and finally the
outer app with an ad-hoc identity, then runs strict deep signature and Mach-O
minimum-version verification. Set `HEDDLEWORK_WITHOUT_CEF=1` only for an
explicit browser-free macOS build. Release packaging must replace that identity
with the normal Developer ID, hardened-runtime, and notarization flow while
preserving the inside-out order and bundle names. `dist/heddlework` is a
compatibility symlink to the app executable when Chromium is bundled.

## Web and mobile

CEF is intentionally not compiled into the WASM client. The browser domain and
surface contribution stay engine-neutral so a mobile/PWA UI can control a
browser running in the desktop or remote workspace host. That future transport
should report the `remote` engine kind and enforce the same profile and agent
policies server-side.
