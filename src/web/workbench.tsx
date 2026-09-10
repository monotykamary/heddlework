import React, { useEffect, useMemo, useSyncExternalStore } from 'react'
import { WorkbenchKernel } from '../core/kernel.ts'
import { RemoteWorkbenchController, asWorkbenchController } from '../dom/remote-controller.ts'
import { domRenderer, GpuixContext } from '../dom/host.tsx'
import { WorkbenchApp } from '../ui/app.tsx'
import { createCoreUiExtension } from '../ui/core-extension.tsx'
import { WorkbenchUiRegistry } from '../ui/extensions.ts'
import { colors } from '../ui/theme.ts'
import { defaultThemeManager } from '../ui/theme-manager.ts'
import { coreToolPresentersPlugin, toolPresenterSlot } from '../ui/tool-presenters.ts'
import { workspaceClient } from './store.ts'
import { RemoteTerminalService, asTerminalSessionService } from '../client/remote-terminal-service.ts'

const kernel = new WorkbenchKernel()
kernel.mount(coreToolPresentersPlugin)
const presenters = kernel.contributions(toolPresenterSlot)

export function WebWorkbench() {
  const client = workspaceClient()
  const view = useSyncExternalStore(client.subscribe.bind(client), client.getSnapshot.bind(client), client.getSnapshot.bind(client))
  const remote = useMemo(() => new RemoteWorkbenchController(client), [client])
  const controller = useMemo(() => asWorkbenchController(remote), [remote])
  const remoteTerminals = useMemo(() => new RemoteTerminalService(client), [client])
  const terminals = useMemo(() => asTerminalSessionService(remoteTerminals), [remoteTerminals])
  const registry = useMemo(() => { const value = new WorkbenchUiRegistry(); value.register(createCoreUiExtension(controller)); return value }, [controller])
  useEffect(() => { defaultThemeManager.start(); return () => { void remote.dispose(); void remoteTerminals.dispose(); registry.dispose() } }, [registry, remote, remoteTerminals])
  useEffect(() => {
    document.documentElement.style.colorScheme = defaultThemeManager.getSnapshot().resolved
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.background)
  }, [view.state])
  if (view.status !== 'open' || !view.state) return <ConnectionStatus status={view.status} error={view.lastError} />
  return <GpuixContext.Provider value={{ renderer: domRenderer }}><WorkbenchApp controller={controller} presenters={presenters} ui={registry} themeManager={defaultThemeManager} terminals={terminals} onQuit={() => client.disconnect()} /></GpuixContext.Provider>
}

function ConnectionStatus({ status, error }: { status: string; error?: string | undefined }) {
  return <div testId="web-connect-status" style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: colors.background }}><div style={{ width: '100%', maxWidth: 420, padding: 22, borderWidth: 1, borderColor: colors.border, borderRadius: 14, backgroundColor: colors.card, display: 'flex', flexDirection: 'column', gap: 8 }}><text style={{ fontSize: 18, color: colors.text }}>Heddlework</text><text style={{ color: error ? colors.error : colors.textMuted }}>{error ?? (status === 'connecting' ? 'Reconnecting to the workspace…' : 'Disconnected')}</text></div></div>
}
