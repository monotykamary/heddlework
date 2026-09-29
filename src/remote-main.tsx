// Desktop remote mode: the native window drives a Heddlework host on another machine over an SSH tunnel.
// It renders the same WorkbenchApp as the local app, backed by the controller and terminal proxies the web client uses.
import React from 'react'
import { GpuixRenderer, render, resetRender } from '@gpuix/react'
import { connectSshTunnel, parseArguments, USAGE, type SshTunnelConnection } from '../scripts/heddlework-ssh.ts'
import { RemoteTerminalService, asTerminalSessionService } from './client/remote-terminal-service.ts'
import { WorkbenchKernel } from './core/kernel.ts'
import { RemoteWorkbenchController, asWorkbenchController } from './dom/remote-controller.ts'
import { assertNativeRuntime } from './native-runtime.ts'
import { WorkbenchApp } from './ui/app.tsx'
import { createCoreUiExtension } from './ui/core-extension.tsx'
import { WorkbenchUiRegistry } from './ui/extensions.ts'
import { isGpuixWindowCloseRace } from './ui/native-window-lifecycle.ts'
import { ThemeManager } from './ui/theme-manager.ts'
import { coreToolPresentersPlugin, toolPresenterSlot } from './ui/tool-presenters.ts'
import { WorkspaceClient } from './web/client.ts'
import { createWindowOptions } from './window-options.ts'

assertNativeRuntime(GpuixRenderer.prototype)

const parsed = parseArguments(process.argv.slice(2))
if (parsed.help) { console.log(USAGE.replace('bun run ssh --', 'bun run remote --')); process.exit(0) }
const { options } = parsed
const log = (message: string): void => console.error(`[heddlework-remote] ${message}`)
const abort = new AbortController()

let connection: SshTunnelConnection
try {
  connection = await connectSshTunnel(options, log, abort.signal)
} catch (error) {
  log(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
log(`connected to ${options.target} (${connection.workspacePath}) via 127.0.0.1:${connection.localPort}`)

const client = new WorkspaceClient()
client.connect(connection.url, connection.token)
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Timed out connecting to ${options.target}: ${client.getSnapshot().lastError ?? 'no welcome'}`)) }, 30_000)
  const check = (): void => { const view = client.getSnapshot(); if (view.status === 'open' && view.state) { clearTimeout(timer); unsubscribe(); resolve() } }
  const unsubscribe = client.subscribe(check)
  check()
}).catch((error: unknown) => { log(error instanceof Error ? error.message : String(error)); abort.abort(); process.exit(1) })

const remote = new RemoteWorkbenchController(client)
const controller = asWorkbenchController(remote)
const remoteTerminals = new RemoteTerminalService(client)
const terminals = asTerminalSessionService(remoteTerminals)
const kernel = new WorkbenchKernel()
kernel.mount(coreToolPresentersPlugin)
const ui = new WorkbenchUiRegistry()
ui.register(createCoreUiExtension(controller))
const themeManager = new ThemeManager()

let shuttingDown = false
// Once GPUI has terminated the window, unmounting or re-rendering throws, so only the tunnel is closed before exiting.
function shutdown(initialError?: unknown, windowGone = false): void {
  if (shuttingDown) return
  shuttingDown = true
  abort.abort()
  if (windowGone) process.exit(0)
  void (async () => {
    const failures: unknown[] = initialError === undefined || isGpuixWindowCloseRace(initialError) ? [] : [initialError]
    // Unmount first: disposing the remote services emits state, which would otherwise render into a torn-down tree.
    try { resetRender() } catch (error) { if (!isGpuixWindowCloseRace(error)) failures.push(error) }
    try {
      themeManager.dispose()
      ui.dispose()
      await remote.dispose()
      await remoteTerminals.dispose()
      client.dispose()
      await kernel.dispose()
    } catch (error) { failures.push(error) }
    if (failures.length > 0) console.error('[heddlework-remote] shutdown failed', new AggregateError(failures))
    process.exit(failures.length > 0 ? 1 : 0)
  })()
}
process.prependListener('uncaughtException', (error) => shutdown(error))
process.prependListener('unhandledRejection', (error) => shutdown(error))
process.once('SIGINT', () => shutdown())
process.once('SIGTERM', () => shutdown())
void connection.closed.then(() => shutdown())

render(
  <WorkbenchApp controller={controller} terminals={terminals} presenters={kernel.contributions(toolPresenterSlot)} ui={ui} themeManager={themeManager} onQuit={() => shutdown()} />,
  { ...createWindowOptions(process.platform, 'hidden', '', false), title: `Heddlework — ${options.target}`, onTerminated: () => shutdown(undefined, true) },
)
themeManager.start()

