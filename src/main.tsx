import React from 'react'
import { render } from '@gpuix/react'
import { resolve } from 'node:path'
import { createWindowOptions } from './window-options.ts'
import { WorkbenchKernel } from './core/kernel.ts'
import { WorkbenchApp } from './ui/app.tsx'
import { ThemeManager } from './ui/theme-manager.ts'
import { createCoreUiExtensionPlugin } from './ui/core-extension.tsx'
import { workbenchUiHostPlugin, workbenchUiRegistryToken } from './ui/extensions.ts'
import { coreToolPresentersPlugin, toolPresenterSlot } from './ui/tool-presenters.ts'
import { sessionSidebarCachePath } from './pi/session-catalog.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from './workbench/plugins.ts'

interface RuntimeHandle {
  kernel: WorkbenchKernel
  dispose(): Promise<void>
}

declare global {
  // eslint-disable-next-line no-var
  var __heddleworkRuntime: RuntimeHandle | undefined
}

const workspacePath = resolveWorkspacePath()
const previous = globalThis.__heddleworkRuntime
if (previous) await previous.dispose()

const themeManager = new ThemeManager()

const kernel = new WorkbenchKernel()
kernel.mount(coreToolPresentersPlugin)
kernel.mount(createWorkbenchControllerPlugin(workspacePath))
kernel.mount(createCoreUiExtensionPlugin())
kernel.mount(workbenchUiHostPlugin)
kernel.mount(createSessionCatalogPlugin({ cachePath: sessionSidebarCachePath() }))
kernel.mount(localWorkspaceDiffPlugin)
kernel.mount(createAgentTransportPlugin({
  cwd: workspacePath,
  demo: process.env.HEDDLEWORK_DEMO === '1',
  ...(process.env.HEDDLEWORK_PI ? { command: process.env.HEDDLEWORK_PI } : {}),
  piArgs: piArgumentsFromEnvironment(),
}))

const controller = kernel.get(workbenchControllerToken)
const ui = kernel.get(workbenchUiRegistryToken)
let disposed = false
const runtime: RuntimeHandle = {
  kernel,
  dispose: async () => {
    if (disposed) return
    disposed = true
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    themeManager.dispose()
    await kernel.dispose()
  },
}
globalThis.__heddleworkRuntime = runtime

render(
  <WorkbenchApp controller={controller} presenters={kernel.contributions(toolPresenterSlot)} ui={ui} themeManager={themeManager} />,
  createWindowOptions(process.platform, debugOverlay()),
)

themeManager.start()
void controller.start()

const shutdown = () => {
  void runtime.dispose().finally(() => process.exit(0))
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

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
