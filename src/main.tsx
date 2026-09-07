import { LinuxDesktopIntegration } from './linux/desktop-integration.ts'
import { pickWorkspaceDirectory } from './ui/open-external.ts'
import React from 'react'
import { render, resetRender } from '@gpuix/react'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifyNativeRuntime } from './core/native-runtime.ts'
import { createWindowOptions } from './window-options.ts'
import { WorkbenchKernel } from './core/kernel.ts'
import { WorkbenchApp } from './ui/app.tsx'
import { isGpuixWindowCloseRace } from './ui/native-window-lifecycle.ts'
import { ThemeManager } from './ui/theme-manager.ts'
import { omarchyThemeCandidates } from './ui/omarchy-theme-source.ts'
import { createCoreUiExtensionPlugin } from './ui/core-extension.tsx'
import { workbenchUiHostPlugin, workbenchUiRegistryToken } from './ui/extensions.ts'
import { coreToolPresentersPlugin, toolPresenterSlot } from './ui/tool-presenters.ts'
import { sessionSidebarCachePath } from './pi/session-catalog.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from './flows/plugin.ts'
import { flowRuntimePath } from './flows/runtime.ts'
import { FileQueueStore, queueStorePath } from './workbench/queue-store.ts'
import { FileThreadMetadataStore, threadMetadataStorePath } from './workbench/thread-metadata-store.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from './workbench/plugins.ts'
import { createTerminalPlugin, terminalSessionToken } from './terminal/plugin.ts'
import { browserSessionToken, createBrowserPlugin } from './browser/plugin.ts'

interface RuntimeHandle {
  kernel: WorkbenchKernel
  dispose(): Promise<void>
}

declare global {
  // eslint-disable-next-line no-var
  var __heddleworkRuntime: RuntimeHandle | undefined
}

const workspacePath = resolveWorkspacePath()
const demoMode = process.env.HEDDLEWORK_DEMO === '1'
const browserSmokeUrl = process.env.HEDDLEWORK_BROWSER_SMOKE_URL
const previous = globalThis.__heddleworkRuntime
const coldStart = previous === undefined
if (previous) await previous.dispose()

const desktop = process.platform === 'linux' ? new LinuxDesktopIntegration() : undefined
const pickDirectory = desktop ? async (signal?: AbortSignal) => {
  const result = await desktop.pickDirectory(signal)
  return result.path ? { path: result.path } : result.error ? { error: result.error } : {}
} : pickWorkspaceDirectory
const themeManager = new ThemeManager({
  ...(desktop ? { appearanceSource: desktop } : {}),
  // On Linux, follow desktop portal/theme events and, when an Omarchy palette
  // is present, overlay it onto the resolved theme. Both are opt-in and degrade
  // to the built-in palette (and polling) elsewhere.
  ...(process.platform === 'linux' ? { enableEventSource: true, omarchyCandidates: omarchyThemeCandidates() } : {}),
})

const kernel = new WorkbenchKernel()
kernel.mount(coreToolPresentersPlugin)
kernel.mount(createWorkbenchControllerPlugin(workspacePath, {
  queueStore: new FileQueueStore(demoMode ? false : queueStorePath()),
  threadMetadataStore: new FileThreadMetadataStore(demoMode ? false : threadMetadataStorePath()),
}))
kernel.mount(createFlowRuntimePlugin({ path: demoMode ? false : flowRuntimePath() }))
kernel.mount(createCoreUiExtensionPlugin())
kernel.mount(workbenchUiHostPlugin)
kernel.mount(createTerminalPlugin({ cwd: workspacePath }))
kernel.mount(createBrowserPlugin({
  ...(demoMode ? { statePath: false as const } : {}),
  cleanupOrphanedProfiles: coldStart,
}))
kernel.mount(createSessionCatalogPlugin({ cachePath: sessionSidebarCachePath() }))
kernel.mount(localWorkspaceDiffPlugin)
kernel.mount(createAgentTransportPlugin({
  cwd: workspacePath,
  demo: demoMode,
  ...(process.env.HEDDLEWORK_PI ? { command: process.env.HEDDLEWORK_PI } : {}),
  piArgs: piArgumentsFromEnvironment(),
}))

const controller = kernel.get(workbenchControllerToken)
const flows = kernel.get(flowRuntimeToken)
const ui = kernel.get(workbenchUiRegistryToken)
const terminals = kernel.get(terminalSessionToken)
const browsers = kernel.get(browserSessionToken)
let disposed = false
const handleUncaughtException = (error: unknown): void => {
  shutdown(isGpuixWindowCloseRace(error) ? undefined : error)
}
const handleUnhandledRejection = (error: unknown): void => {
  shutdown(error)
}
const runtime: RuntimeHandle = {
  kernel,
  dispose: async () => {
    if (disposed) return
    disposed = true
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    process.off('uncaughtException', handleUncaughtException)
    process.off('unhandledRejection', handleUnhandledRejection)
    themeManager.dispose()
    desktop?.dispose()
    await kernel.dispose()
  },
}
globalThis.__heddleworkRuntime = runtime

let shutdownStarted = false
function shutdown(initialError?: unknown): void {
  if (shutdownStarted) return
  shutdownStarted = true
  void (async () => {
    const failures: unknown[] = []
    if (initialError !== undefined) failures.push(initialError)
    try {
      await runtime.dispose()
    } catch (error) {
      failures.push(error)
    }

    let nativeStopped = false
    try {
      resetRender()
      nativeStopped = true
    } catch (error) {
      nativeStopped = isGpuixWindowCloseRace(error)
      if (!nativeStopped) failures.push(error)
    }

    if (nativeStopped) {
      try {
        browsers.flushRemovedProfileData()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      console.error('[heddlework] shutdown failed', new AggregateError(failures))
    }
    process.exit(failures.length > 0 ? 1 : 0)
  })()
}

process.prependListener('uncaughtException', handleUncaughtException)
process.prependListener('unhandledRejection', handleUnhandledRejection)
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

// Report the native runtime contract before rendering; an incompatible runtime
// must be named here instead of failing later during layout or paint. Packaged
// builds bundle the addon and have no node_modules to probe, so this is a
// development-checkout guard.
try {
  if (existsSync(resolve(import.meta.dir, '..', 'node_modules'))) {
    const runtime = verifyNativeRuntime()
    for (const check of runtime.checks.filter((entry) => !entry.ok)) {
      const message = `[heddlework] native runtime ${check.required ? 'error' : 'degradation'}: ${check.detail}`
      const remediation = `  → ${check.remediation ?? ''}`
      if (check.required) console.error(`${message}\n${remediation}`)
      else console.warn(`${message}\n${remediation}`)
    }
  }
} catch {
  // Best-effort startup probe; bun run check:native reports the full picture.
}

render(
  <WorkbenchApp controller={controller} flows={flows} terminals={terminals} browsers={browsers} presenters={kernel.contributions(toolPresenterSlot)} ui={ui} themeManager={themeManager} pickDirectory={pickDirectory} onQuit={shutdown} />,
  {
    ...createWindowOptions(
      process.platform,
      debugOverlay(),
      browsers.nativeProfileRoot() ?? '',
      browsers.canInitializeNativeBrowser(),
    ),
    ...(browserSmokeUrl ? { focus: false, show: false } : {}),
    onTerminated: shutdown,
  },
)

desktop?.start()
themeManager.start()
void controller.start()
if (browserSmokeUrl) startPackagedBrowserSmoke(browsers, browserSmokeUrl)

function startPackagedBrowserSmoke(service: typeof browsers, url: string): void {
  const initialTabId = service.createTab({ address: url })
  service.setPlacement(initialTabId, { x: 0, y: 0, width: 640, height: 480 }, true)
  let phase: 'initial' | 'commands' | 'profile' | 'private' | 'private-close' | 'complete' = 'initial'
  let profileId: string | undefined
  let privateTabId: string | undefined
  let sawReloadLoading = false
  let privateCloseSettled = false
  let inspectionQueued = false

  const finish = (error?: Error) => {
    if (phase === 'complete') return
    phase = 'complete'
    clearTimeout(timeout)
    unsubscribe()
    if (error) {
      console.error('[heddlework-browser-smoke] failed', error.message)
      shutdown(error)
    } else {
      const snapshot = service.getSnapshot()
      console.log('[heddlework-browser-smoke] passed', JSON.stringify({
        engine: snapshot.engine.kind,
        tabs: snapshot.tabs.length,
        profiles: snapshot.profiles.length,
      }))
      shutdown()
    }
  }

  const inspect = () => {
    inspectionQueued = false
    if (phase === 'complete') return
    const snapshot = service.getSnapshot()
    if (process.env.GPUIX_CEF_DEBUG) {
      console.error('[heddlework-browser-smoke] state', phase, JSON.stringify(snapshot.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, status: tab.status, commands: tab.commands.map((command) => command.serial) }))))
    }
    const failed = snapshot.tabs.find((tab) => tab.error)
    if (failed) {
      finish(new Error(failed.error ?? 'Native browser failed'))
      return
    }
    if (!snapshot.engine.available) return

    if (phase === 'initial') {
      const tab = snapshot.tabs.find((candidate) => candidate.id === initialTabId)
      if (tab?.status !== 'ready' || tab.commands.length > 0 || !tab.title.includes('Heddlework Browser Smoke')) return
      phase = 'commands'
      service.command(initialTabId, 'clearData')
      service.command(initialTabId, 'reload')
      return
    }

    if (phase === 'commands') {
      const tab = snapshot.tabs.find((candidate) => candidate.id === initialTabId)
      if (tab?.status === 'loading') sawReloadLoading = true
      if (!sawReloadLoading || tab?.status !== 'ready' || tab.commands.length > 0) return
      phase = 'profile'
      profileId = service.createProfile({ name: 'Smoke Profile', agentAccess: 'denied' })
      service.switchTabProfile(initialTabId, profileId)
      return
    }

    if (phase === 'profile') {
      const tab = snapshot.tabs.find((candidate) => candidate.id === initialTabId)
      if (!profileId || tab?.profileId !== profileId || tab.status !== 'ready' || tab.commands.length > 0) return
      phase = 'private'
      privateTabId = service.createTab({ profileId: 'private', address: url })
      service.setPlacement(privateTabId, { x: 0, y: 0, width: 640, height: 480 }, true)
      return
    }

    if (phase === 'private') {
      const tab = snapshot.tabs.find((candidate) => candidate.id === privateTabId)
      if (tab?.status !== 'ready' || tab.commands.length > 0 || !privateTabId) return
      phase = 'private-close'
      service.closeTab(privateTabId)
      setTimeout(() => {
        privateCloseSettled = true
        scheduleInspection()
      }, 1_000)
      return
    }

    if (phase === 'private-close') {
      if (!privateCloseSettled || snapshot.tabs.some((candidate) => candidate.id === privateTabId)) return
      finish()
    }
  }

  const scheduleInspection = () => {
    if (inspectionQueued || phase === 'complete') return
    inspectionQueued = true
    queueMicrotask(inspect)
  }
  const unsubscribe = service.subscribe(scheduleInspection)
  const timeout = setTimeout(() => finish(new Error(`Timed out during ${phase}`)), 30_000)
  scheduleInspection()
}

function resolveWorkspacePath(): string {
  if (process.env.HEDDLEWORK_CWD) return resolve(process.env.HEDDLEWORK_CWD)
  const argument = process.argv.slice(2).find((value) => value !== '--' && !value.startsWith('-'))
  return resolve(argument ?? process.cwd())
}

function piArgumentsFromEnvironment(): string[] {
  const args: string[] = []
  if (process.env.HEDDLEWORK_PROVIDER) args.push('--provider', process.env.HEDDLEWORK_PROVIDER)
  if (process.env.HEDDLEWORK_MODEL) args.push('--model', process.env.HEDDLEWORK_MODEL)
  if (process.env.HEDDLEWORK_SESSION) args.push('--session', process.env.HEDDLEWORK_SESSION)
  if (process.env.HEDDLEWORK_NO_SESSION === '1') args.push('--no-session')
  return args
}

function debugOverlay(): 'hidden' | 'minimal' | 'full' {
  const value = process.env.HEDDLEWORK_DEBUG_OVERLAY
  return value === 'minimal' || value === 'full' ? value : 'hidden'
}
