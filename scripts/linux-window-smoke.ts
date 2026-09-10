import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { connectStdio, type App } from '@gpuix/react/automation'
import type { NativeWindowState } from '../src/ui/window-controls.ts'

type Backend = 'wayland' | 'x11'
type Compositor = 'mutter-wayland' | 'sway-wayland' | 'weston-wayland' | 'mutter-x11'
type Decorations = 'client' | 'server'
type Geometry = { x: number; y: number; width: number; height: number }
type SwayNode = { rect: Geometry; window_rect?: Geometry; app_id?: string; name?: string }

type Check = {
  name: string
  evidence: string
}

const options = parseArgs(process.argv.slice(2))
const title = `Heddlework Linux Smoke ${options.compositor} ${options.decorations} ${process.pid}`
const appId = 'io.github.monotykamary.heddlework.smoke'
const gpuixRevision = process.env.HEDDLEWORK_SMOKE_GPUIX_REVISION
if (!gpuixRevision || !/^[a-f0-9]{40}$/u.test(gpuixRevision)) throw new Error('HEDDLEWORK_SMOKE_GPUIX_REVISION must be a full commit hash')
const checks: Check[] = []
const unvalidated: string[] = []
let nativeStderr = ''
let child: ChildProcessWithoutNullStreams | undefined
let app: App | undefined
let failure: unknown
let failureTree: unknown
let minimizeChecked = false

try {
  child = spawn(process.execPath, [resolve(import.meta.dir, 'smoke-linux-window.tsx')], {
    cwd: resolve(import.meta.dir, '..'),
    env: {
      ...process.env,
      HEDDLEWORK_SMOKE_APP_ID: appId,
      HEDDLEWORK_SMOKE_DECORATIONS: options.decorations,
      HEDDLEWORK_SMOKE_START_FULLSCREEN: '1',
      HEDDLEWORK_SMOKE_TITLE: title,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = childExit(child)
  child.stderr.on('data', (chunk: Buffer) => {
    nativeStderr = (nativeStderr + chunk.toString('utf8')).slice(-5_000_000)
  })
  app = await connectStdio({
    write: (chunk) => child!.stdin.write(chunk),
    feed: (listener) => child!.stdout.on('data', (chunk: Buffer) => listener(chunk.toString('utf8'))),
    close: async () => { child?.kill('SIGTERM') },
  })

  const readiness = await waitForAutomationReady(app, 'window-drag-region', 30_000)
  await app.getByTestId('maximize-enabled').waitFor()
  for (const edge of ['top', 'topRight', 'right', 'bottomRight', 'bottom', 'bottomLeft', 'left', 'topLeft']) {
    await app.getByTestId(`window-resize-${edge}`).waitFor()
  }
  pass(
    'automation-connected',
    `stdio protocol located the live rendered drag region and all eight resize edges after ${readiness.attempts} attempt(s) in ${readiness.elapsedMs}ms`,
  )

  const expectedDecorations = options.compositor === 'mutter-wayland'
    ? 'client'
    : options.compositor === 'sway-wayland' ? 'server' : options.decorations
  const initial = await waitForState(app, (state) => state.decorations === expectedDecorations && state.fullscreen)
  assertWindowState(initial)
  assert(initial.fullscreen, `initial fullscreen was ${initial.fullscreen}`)
  assert(initial.resizable, 'smoke window is not resizable')
  assert(initial.canMinimize, 'compositor reported canMinimize=false')
  assert(initial.canMaximize, 'compositor reported canMaximize=false')
  pass('initial-window-state', JSON.stringify(initial))

  let x11Window = ''
  let xdgVersion: number | undefined
  if (options.backend === 'wayland') {
    xdgVersion = await waitForXdgVersion()
    pass('wayland-xdg-version-and-capabilities', `xdg_wm_base version=${xdgVersion}; canMinimize=${initial.canMinimize}; canMaximize=${initial.canMaximize}`)
    if (xdgVersion < 5) unvalidated.push(`xdg_wm_base version ${xdgVersion} predates wm_capabilities; capability absence would be unknown rather than unsupported.`)
  }

  if (options.backend === 'x11') {
    x11Window = await waitForXWindow(title, appId)
    const fullscreen = await waitForXProperty(x11Window, '_NET_WM_STATE', /_NET_WM_STATE_FULLSCREEN/)
    pass('x11-initial-fullscreen', compact(fullscreen))
  } else {
    await waitForTrace(waylandRequest('xdg_toplevel', 'set_fullscreen'))
    pass('wayland-initial-fullscreen', 'xdg_toplevel.set_fullscreen observed in WAYLAND_DEBUG')
  }

  await app.getByTestId('action-maximize').click()
  const fullscreenRestored = await waitForState(app, (state) => !state.fullscreen && !state.maximized)
  pass('toggle-maximize-restores-fullscreen', JSON.stringify(fullscreenRestored))
  if (options.backend === 'x11') {
    await waitForXProperty(x11Window, '_NET_WM_STATE', (value) => !value.includes('_NET_WM_STATE_FULLSCREEN'))
  } else {
    await waitForTrace(waylandRequest('xdg_toplevel', 'unset_fullscreen'))
  }

  if (options.backend === 'x11') {
    const properties = await command('xprop', ['-id', x11Window, 'WM_CLASS', '_MOTIF_WM_HINTS', '_NET_FRAME_EXTENTS'])
    assert(properties.includes(appId), `WM_CLASS does not include appId ${appId}: ${properties}`)
    const clientDecorationHint = /_MOTIF_WM_HINTS[^=]*=\s*[^\n]*(?:2|0x2),\s*(?:0|0x0),\s*(?:0|0x0)\b/
    if (options.decorations === 'client') {
      assert(clientDecorationHint.test(properties), `client decorations did not disable the server frame: ${properties}`)
    } else {
      assert(!clientDecorationHint.test(properties), `server decorations unexpectedly disabled the server frame: ${properties}`)
    }
    pass('x11-app-id-and-decorations', compact(properties))
  } else {
    await waitForTrace(new RegExp(`xdg_toplevel@\\d+\\.set_app_id\\(\"${escapeRegExp(appId)}\"\\)`))
    if (options.compositor === 'mutter-wayland') {
      assert(initial.decorations === 'client', `Mutter Wayland did not report its required client-decoration fallback: ${JSON.stringify(initial)}`)
      pass('wayland-app-id-and-decoration-fallback', `xdg_toplevel.set_app_id(${appId}); Mutter effective decorations=client for requested ${options.decorations}`)
    } else {
      const mode = options.decorations === 'client' ? 1 : 2
      await waitForTrace(new RegExp(`zxdg_toplevel_decoration_v1(?:@|#)\\d+\\.set_mode\\(${mode}\\)`))
      pass('wayland-app-id-and-decorations', `xdg_toplevel.set_app_id(${appId}); xdg-decoration mode=${mode}; effective=${initial.decorations}`)
    }
  }

  if (options.compositor === 'sway-wayland') {
    await command('swaymsg', [`[app_id="${appId}"]`, 'floating', 'enable'])
    await waitForSwayNode(appId)
    const floating = await waitForState(app, (state) => state.decorations === options.decorations && !state.fullscreen)
    pass('sway-window-discovered', `Sway IPC matched app_id=${appId}, enabled floating geometry, and configured effective ${floating.decorations} decorations`)
  }

  if (options.compositor === 'sway-wayland') {
    const maximizeRequest = waylandRequest('xdg_toplevel', 'set_maximized')
    const maximizeEnabled = await app.getByTestId('maximize-enabled').textContent()
    if (!initial.canMaximize) {
      assert(maximizeEnabled === 'false', `maximize UI remained enabled when canMaximize=false: ${maximizeEnabled}`)
      const before = traceCount(maximizeRequest)
      await app.getByTestId('action-maximize').click()
      await Bun.sleep(250)
      assert(traceCount(maximizeRequest) === before, 'disabled maximize UI emitted a Wayland maximize request')
      pass('sway-maximize-not-applicable', 'canMaximize=false disabled the control and emitted no request')
    } else {
      assert(maximizeEnabled === 'true', `maximize UI was disabled despite canMaximize=true: ${maximizeEnabled}`)
      await waitForAdditionalTrace(maximizeRequest, () => app!.getByTestId('action-maximize').click())
      const unchanged = await waitForState(app, (state) => !state.maximized && !state.fullscreen)
      pass('sway-maximize-request', `canMaximize=true; xdg_toplevel.set_maximized observed; runtime state remained ${JSON.stringify(unchanged)}`)
      await waitForAdditionalTrace(maximizeRequest, () => app!.getByTestId('action-maximize').click())
      pass('sway-second-maximize-request', 'Second native toggle invocation produced another xdg_toplevel.set_maximized request')
      const capabilitySource = xdgVersion !== undefined && xdgVersion >= 5
        ? 'the negotiated wm_capabilities value'
        : `GPUI's compatibility fallback because xdg_wm_base version ${xdgVersion ?? 'unknown'} has no wm_capabilities event`
      unvalidated.push(`Sway 1.9 ignores set_maximized even though canMaximize=true came from ${capabilitySource}; it never configures maximized state and native restore cannot be observed. Mutter Wayland validates maximize/restore state transitions.`)
    }
    await app.getByTestId('action-minimize').click()
    await waitForTrace(waylandRequest('xdg_toplevel', 'set_minimized'))
    pass('wayland-minimize-request', 'xdg_toplevel.set_minimized observed in WAYLAND_DEBUG before virtual-pointer gestures')
    unvalidated.push('sway-wayland: xdg-shell defines no minimized-state event and Sway leaves the surface mapped, so this report records the real request without claiming compositor acceptance.')
    minimizeChecked = true
  } else {
    await app.getByTestId('action-maximize').click()
    const maximized = await waitForState(app, (state) => state.maximized && !state.fullscreen)
    pass('maximize-state', JSON.stringify(maximized))
    if (options.backend === 'x11') {
      const wmState = await waitForXProperty(x11Window, '_NET_WM_STATE', /_NET_WM_STATE_MAXIMIZED_HORZ.*_NET_WM_STATE_MAXIMIZED_VERT|_NET_WM_STATE_MAXIMIZED_VERT.*_NET_WM_STATE_MAXIMIZED_HORZ/)
      pass('x11-maximize-compositor-state', compact(wmState))
    } else {
      await waitForTrace(waylandRequest('xdg_toplevel', 'set_maximized'))
      pass('wayland-maximize-request', 'xdg_toplevel.set_maximized observed in WAYLAND_DEBUG')
    }

    await app.getByTestId('action-maximize').click()
    const restored = await waitForState(app, (state) => !state.maximized && !state.fullscreen)
    pass('restore-state', JSON.stringify(restored))
    if (options.backend === 'x11') {
      await waitForXProperty(x11Window, '_NET_WM_STATE', (value) => !value.includes('_NET_WM_STATE_MAXIMIZED'))
      pass('x11-restore-compositor-state', 'maximize atoms cleared')
    } else {
      await waitForTrace(waylandRequest('xdg_toplevel', 'unset_maximized'))
      pass('wayland-restore-request', 'xdg_toplevel.unset_maximized observed in WAYLAND_DEBUG')
    }
  }

  if (options.backend === 'x11') {
    const beforeMove = await x11Geometry(x11Window)
    const drag = await app.getByTestId('window-drag-region').bounds()
    await xdotoolDrag(x11Window, drag.x + drag.width / 2, drag.y + drag.height / 2, 48, 36)
    const afterMove = await waitForGeometry(x11Window, (next) => Math.abs(next.x - beforeMove.x) >= 20 || Math.abs(next.y - beforeMove.y) >= 20)
    pass('x11-native-drag', `${formatGeometry(beforeMove)} -> ${formatGeometry(afterMove)}`)

    const beforeResize = afterMove
    const right = await app.getByTestId('window-resize-right').bounds()
    await xdotoolDrag(x11Window, right.x + right.width / 2, right.y + right.height / 2, 64, 0)
    const afterResize = await waitForGeometry(x11Window, (next) => next.width >= beforeResize.width + 24)
    pass('x11-native-resize', `${formatGeometry(beforeResize)} -> ${formatGeometry(afterResize)}`)
  } else if (options.compositor === 'sway-wayland') {
    const beforeMove = await swayGeometry(appId)
    const drag = await app.getByTestId('window-drag-region').bounds()
    await swayPointerDrag(beforeMove.x + drag.x + drag.width / 2, beforeMove.y + drag.y + drag.height / 2, 48, 36)
    const afterMove = await poll(async () => {
      const next = await swayGeometry(appId)
      return Math.abs(next.x - beforeMove.x) >= 20 || Math.abs(next.y - beforeMove.y) >= 20 ? next : undefined
    }, 5_000, 'Sway native move geometry transition')
    pass('sway-native-drag', `${formatGeometry(beforeMove)} -> ${formatGeometry(afterMove)}`)

    await waitForTrace(waylandRequest('xdg_toplevel', 'move'))

    const beforeResize = afterMove
    const resize = await app.getByTestId('window-resize-bottomRight').bounds()
    const moveRequest = waylandRequest('xdg_toplevel', 'move')
    const resizeRequest = waylandRequest('xdg_toplevel', 'resize')
    const moveCount = traceCount(moveRequest)
    const resizeCount = traceCount(resizeRequest)
    await swayPointerDrag(
      beforeResize.x + resize.x + resize.width / 2,
      beforeResize.y + resize.y + resize.height / 2,
      64,
      48,
    )
    await poll(
      async () => traceCount(resizeRequest) > resizeCount ? true : undefined,
      5_000,
      `additional Wayland trace ${resizeRequest}`,
    )
    assert(traceCount(moveRequest) === moveCount, 'Sway resize gesture emitted a second xdg_toplevel.move request')
    const afterResize = await poll(async () => {
      const next = await swayGeometry(appId)
      return next.width >= beforeResize.width + 24 && next.height >= beforeResize.height + 16 ? next : undefined
    }, 5_000, 'Sway native resize geometry transition')
    pass('sway-native-resize', `${formatGeometry(beforeResize)} -> ${formatGeometry(afterResize)}`)
  } else {
    unvalidated.push(`${options.compositor} has no headless virtual pointer injector available in Ubuntu 24.04. Native serial-backed drag is exercised by Sway headless; no drag/resize result is inferred from automation events.`)
  }

  if (!minimizeChecked) await app.getByTestId('action-minimize').click()
  if (options.backend === 'x11') {
    const hidden = await waitForXProperty(x11Window, '_NET_WM_STATE', /_NET_WM_STATE_HIDDEN/)
    pass('x11-minimize-compositor-state', compact(hidden))
  } else if (!minimizeChecked) {
    await waitForTrace(waylandRequest('xdg_toplevel', 'set_minimized'))
    pass('wayland-minimize-request', 'xdg_toplevel.set_minimized observed in WAYLAND_DEBUG')
    unvalidated.push(`${options.compositor}: xdg-shell defines no minimized-state event, so compositor acceptance cannot be observed by this client. This report records only the real Wayland request; the separate X11 probe checks _NET_WM_STATE_HIDDEN when its UI command path is responsive.`)
  }

  const closeClick = Promise.resolve(child.kill('SIGUSR1')).then(() => undefined)
  const result = await Promise.race([
    exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('native process did not exit after closeWindow')), 10_000)),
  ])
  await closeClick
  assert(result.code === 0, `native process exited with code=${result.code} signal=${result.signal}`)
  pass('close-window', `renderer.closeWindow exited native process code=${result.code}; trigger=SIGUSR1 app handler after state-poll drain`)
  if (options.backend === 'x11') {
    const search = await commandResult('xdotool', ['search', '--name', title])
    assert(search.code !== 0 || search.stdout.trim() === '', `X11 window survived closeWindow: ${search.stdout}`)
    pass('x11-window-destroyed', 'xdotool no longer finds the window')
  }
} catch (error) {
  failure = error
  try { failureTree = await app?.call('getTree', {}) } catch { /* Preserve the primary compositor failure. */ }
  child?.kill('SIGTERM')
}

const report = {
  schemaVersion: 1,
  backend: options.backend,
  compositor: options.compositor,
  requestedDecorations: options.decorations,
  appId,
  gpuixRevision,
  renderer: 'lavapipe Vulkan',
  passed: failure === undefined,
  complete: failure === undefined && unvalidated.length === 0,
  checks,
  unvalidated,
  error: failure instanceof Error ? failure.stack ?? failure.message : failure === undefined ? null : String(failure),
  failureTree,
  nativeEvidence: relevantNativeEvidence(nativeStderr),
}
await mkdir(dirname(options.report), { recursive: true })
await writeFile(options.report.replace(/\.json$/u, '.native.log'), nativeStderr)
await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`)
console.log(`HEDDLEWORK_LINUX_SMOKE_REPORT ${JSON.stringify(report)}`)
if (failure !== undefined) process.exit(1)

function parseArgs(args: string[]): { backend: Backend; compositor: Compositor; decorations: Decorations; report: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) values.set(args[index]!, args[index + 1]!)
  const backend = values.get('--backend')
  const compositor = values.get('--compositor')
  const decorations = values.get('--decorations')
  const report = values.get('--report')
  const compositors: Compositor[] = ['mutter-wayland', 'sway-wayland', 'weston-wayland', 'mutter-x11']
  if ((backend !== 'wayland' && backend !== 'x11') || !compositors.includes(compositor as Compositor) || (decorations !== 'client' && decorations !== 'server') || !report) {
    throw new Error('Usage: bun scripts/linux-window-smoke.ts --backend wayland|x11 --compositor mutter-wayland|sway-wayland|weston-wayland|mutter-x11 --decorations client|server --report PATH')
  }
  if ((compositor === 'mutter-x11') !== (backend === 'x11')) throw new Error(`Backend ${backend} does not match compositor ${compositor}`)
  return { backend, compositor: compositor as Compositor, decorations, report }
}

function pass(name: string, evidence: string): void {
  checks.push({ name, evidence })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertWindowState(state: NativeWindowState): void {
  assert(state.decorations === 'client' || state.decorations === 'server', `invalid decorations state: ${JSON.stringify(state)}`)
  for (const field of ['maximized', 'fullscreen', 'resizable', 'canMinimize', 'canMaximize'] as const) {
    assert(typeof state[field] === 'boolean', `window state ${field} is not boolean: ${JSON.stringify(state)}`)
  }
}

async function waitForAutomationReady(app: App, testId: string, timeoutMs: number): Promise<{ attempts: number; elapsedMs: number }> {
  const started = Date.now()
  let attempts = 0
  let lastBoundsTimeout: unknown
  while (Date.now() - started < timeoutMs) {
    attempts += 1
    try {
      const found = await app.getByTestId(testId).all()
      if (found.length === 1) return { attempts, elapsedMs: Date.now() - started }
      if (found.length > 1) throw new Error(`Automation readiness testId=${testId} matched ${found.length} elements`)
    } catch (error) {
      if (!isNativeBoundsTimeout(error)) throw error
      lastBoundsTimeout = error
    }
    await Bun.sleep(40)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for automation readiness${lastBoundsTimeout ? `: ${String(lastBoundsTimeout)}` : ''}`)
}

function isNativeBoundsTimeout(error: unknown): boolean {
  return error instanceof Error && /Timed out after 2 seconds waiting for the automation bounds query/u.test(error.message)
}

async function waitForState(app: App, predicate: (state: NativeWindowState) => boolean): Promise<NativeWindowState> {
  return poll(async () => {
    const text = await app.getByTestId('smoke-state').textContent()
    if (text === 'pending') return undefined
    const state = JSON.parse(text) as NativeWindowState
    return predicate(state) ? state : undefined
  }, 8_000, 'window state transition')
}

async function waitForTrace(pattern: RegExp): Promise<string> {
  return poll(async () => {
    const match = nativeStderr.match(pattern)
    return match?.[0]
  }, 5_000, `Wayland trace ${pattern}`)
}

async function waitForXdgVersion(): Promise<number> {
  return poll(async () => {
    const match = nativeStderr.match(/bind\(\d+, "xdg_wm_base", (\d+),/u)
    return match ? Number(match[1]) : undefined
  }, 5_000, 'negotiated xdg_wm_base version')
}

function traceCount(pattern: RegExp): number {
  return nativeStderr.match(new RegExp(pattern.source, 'g'))?.length ?? 0
}

async function waitForAdditionalTrace(pattern: RegExp, action: () => Promise<void>): Promise<void> {
  const before = traceCount(pattern)
  await action()
  await poll(async () => traceCount(pattern) > before ? true : undefined, 5_000, `additional Wayland trace ${pattern}`)
}

async function waitForXWindow(title: string, appId: string): Promise<string> {
  return poll(async () => {
    const result = await commandResult('xdotool', ['search', '--name', title])
    if (result.code !== 0) return undefined
    for (const window of result.stdout.trim().split(/\s+/)) {
      if (!window) continue
      const wmClass = await commandResult('xprop', ['-id', window, 'WM_CLASS'])
      if (wmClass.code === 0 && wmClass.stdout.includes(appId)) return window
    }
    return undefined
  }, 8_000, `X11 window ${title} with WM_CLASS ${appId}`)
}

async function waitForXProperty(window: string, property: string, expected: RegExp | ((value: string) => boolean)): Promise<string> {
  return poll(async () => {
    const value = await command('xprop', ['-id', window, property])
    const matches = expected instanceof RegExp ? expected.test(value) : expected(value)
    return matches ? value : undefined
  }, 8_000, `${property}=${String(expected)}`)
}

async function x11Geometry(window: string): Promise<Geometry> {
  const value = await command('xwininfo', ['-id', window])
  const number = (label: string) => {
    const match = value.match(new RegExp(`${label}:\\s+(-?\\d+)`))
    if (!match) throw new Error(`Missing ${label} in xwininfo: ${value}`)
    return Number(match[1])
  }
  return { x: number('Absolute upper-left X'), y: number('Absolute upper-left Y'), width: number('Width'), height: number('Height') }
}

async function waitForGeometry(window: string, expected: (geometry: Geometry) => boolean): Promise<Geometry> {
  return poll(async () => {
    const geometry = await x11Geometry(window)
    return expected(geometry) ? geometry : undefined
  }, 5_000, 'X11 geometry transition')
}

async function xdotoolDrag(window: string, x: number, y: number, dx: number, dy: number): Promise<void> {
  const triggerX = Math.sign(dx) * Math.min(Math.abs(dx), 2)
  const triggerY = Math.sign(dy) * Math.min(Math.abs(dy), 2)
  await command('xdotool', [
    'mousemove', '--window', window, String(Math.round(x)), String(Math.round(y)),
    'mousedown', '1',
    'mousemove_relative', '--sync', String(triggerX), String(triggerY),
    'sleep', '0.1',
    'mousemove_relative', '--sync', String(dx - triggerX), String(dy - triggerY),
    'sleep', '0.1',
    'mouseup', '1',
  ])
}

async function waitForSwayNode(appId: string): Promise<SwayNode> {
  return poll(() => swayNode(appId), 5_000, `Sway node app_id=${appId}`)
}

async function swayNode(appId: string): Promise<SwayNode | undefined> {
  const tree = JSON.parse(await command('swaymsg', ['-t', 'get_tree'])) as unknown
  const visit = (value: unknown): SwayNode | undefined => {
    if (!value || typeof value !== 'object') return undefined
    const node = value as Record<string, unknown>
    if (node.app_id === appId && node.rect && typeof node.rect === 'object') return node as unknown as SwayNode
    for (const key of ['nodes', 'floating_nodes']) {
      if (!Array.isArray(node[key])) continue
      for (const child of node[key]) {
        const match = visit(child)
        if (match) return match
      }
    }
    return undefined
  }
  return visit(tree)
}

async function swayGeometry(appId: string): Promise<Geometry> {
  return (await waitForSwayNode(appId)).rect
}

async function swayPointerDrag(x: number, y: number, dx: number, dy: number): Promise<void> {
  const injector = process.env.HEDDLEWORK_SMOKE_WAYLAND_DRAG
  assert(injector, 'HEDDLEWORK_SMOKE_WAYLAND_DRAG is not configured')
  await command(injector, [String(Math.round(x)), String(Math.round(y)), String(Math.round(dx)), String(Math.round(dy))])
}

async function poll<T>(read: () => Promise<T | undefined>, timeoutMs: number, description: string): Promise<T> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await read()
      if (value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(40)
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ''}`)
}

function childExit(process: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    process.once('error', reject)
    process.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function command(commandName: string, args: string[]): Promise<string> {
  const result = await commandResult(commandName, args)
  if (result.code !== 0) throw new Error(`${commandName} ${args.join(' ')} failed (${result.code}): ${result.stderr}`)
  return result.stdout
}

async function commandResult(commandName: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn([commandName, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { code, stdout, stderr }
}

function relevantNativeEvidence(value: string): string[] {
  return value.split('\n').filter((line) => /HEDDLEWORK_SMOKE|xdg_toplevel|zxdg_toplevel_decoration|error|panic/i.test(line)).slice(-120)
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function formatGeometry(value: Geometry): string {
  return `${value.width}x${value.height}+${value.x}+${value.y}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function waylandRequest(interfaceName: string, method: string): RegExp {
  return new RegExp(`${interfaceName}(?:@|#)\\d+\\.${method}\\(`)
}
