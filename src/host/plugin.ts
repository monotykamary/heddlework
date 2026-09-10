import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { flowRuntimeToken } from '../flows/plugin.ts'
import { workbenchControllerToken } from '../workbench/plugins.ts'
import { terminalSessionToken } from '../terminal/plugin.ts'
import { createWorkspaceHost, DEFAULT_HOST_BIND, DEFAULT_HOST_PORT, type WorkspaceHost } from './server.ts'
import { loadOrCreateHostToken } from './token.ts'

export interface WorkspaceHostPluginOptions {
  enabled: boolean; workspacePath: string; port?: number; hostname?: string; tokenPath?: string | false; token?: string; staticRoot?: string; allowNetwork?: boolean; allowedOrigins?: readonly string[]
}
export const workspaceHostToken = serviceToken<WorkspaceHost | undefined>('workspace-host')
export function createWorkspaceHostPlugin(options: WorkspaceHostPluginOptions): WorkbenchPlugin {
  return { id: 'workspace-host', requires: [workbenchControllerToken, flowRuntimeToken, terminalSessionToken], activate(ctx) {
    if (!options.enabled) { ctx.provide(workspaceHostToken, undefined); return }
    const host = createWorkspaceHost({ controller: ctx.get(workbenchControllerToken), flows: ctx.get(flowRuntimeToken), workspacePath: options.workspacePath, port: options.port ?? DEFAULT_HOST_PORT, hostname: options.hostname ?? DEFAULT_HOST_BIND, token: options.token ?? loadOrCreateHostToken(options.tokenPath ?? false), terminals: ctx.get(terminalSessionToken), ...(options.staticRoot ? { staticRoot: options.staticRoot } : {}), ...(options.allowNetwork === undefined ? {} : { allowNetwork: options.allowNetwork }), ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}) })
    ctx.provide(workspaceHostToken, host); ctx.effect(() => () => host.close())
  } }
}
export interface HostEnvironmentOptions { enabled: boolean; port: number; hostname: string; allowNetwork: boolean; allowedOrigins: string[] }
export function hostOptionsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): HostEnvironmentOptions {
  const port = Number.parseInt(environment.HEDDLEWORK_HOST_PORT ?? '', 10)
  return { enabled: environment.HEDDLEWORK_HOST === '1', port: Number.isFinite(port) && port >= 0 && port <= 65_535 ? port : DEFAULT_HOST_PORT, hostname: environment.HEDDLEWORK_HOST_BIND?.trim() || DEFAULT_HOST_BIND, allowNetwork: environment.HEDDLEWORK_HOST_ALLOW_NETWORK === '1', allowedOrigins: (environment.HEDDLEWORK_HOST_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean) }
}
