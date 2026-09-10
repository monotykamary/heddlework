import { resolve } from 'node:path'
import { WorkbenchKernel } from '../core/kernel.ts'
import { createFlowRuntimePlugin } from '../flows/plugin.ts'
import { flowRuntimePath } from '../flows/runtime.ts'
import { sessionSidebarCachePath } from '../pi/session-catalog.ts'
import { createAgentTransportPlugin, createSessionCatalogPlugin, createWorkbenchControllerPlugin, localWorkspaceDiffPlugin, workbenchControllerToken } from '../workbench/plugins.ts'
import { FileQueueStore, queueStorePath } from '../workbench/queue-store.ts'
import { FileThreadMetadataStore, threadMetadataStorePath } from '../workbench/thread-metadata-store.ts'
import { createWorkspaceHostPlugin, hostOptionsFromEnvironment, workspaceHostToken } from './plugin.ts'
import { hostConnectUrl } from './server.ts'
import { resolveStaticRoot } from './static-root.ts'
import { hostTokenPath } from './token.ts'
import { createTerminalPlugin } from '../terminal/plugin.ts'

const workspacePath = resolveWorkspacePath()
const demoMode = process.env.HEDDLEWORK_DEMO === '1'
const environment = hostOptionsFromEnvironment({ ...process.env, HEDDLEWORK_HOST: '1' })
const tokenPath = demoMode ? false : hostTokenPath()
const staticRoot = resolveStaticRoot()
const kernel = new WorkbenchKernel()
kernel.mount(createWorkbenchControllerPlugin(workspacePath, { queueStore: new FileQueueStore(demoMode ? false : queueStorePath()), threadMetadataStore: new FileThreadMetadataStore(demoMode ? false : threadMetadataStorePath()) }))
kernel.mount(createFlowRuntimePlugin({ path: demoMode ? false : flowRuntimePath() }))
kernel.mount(createTerminalPlugin({ cwd: workspacePath, appearancePath: false }))
kernel.mount(createWorkspaceHostPlugin({ ...environment, enabled: true, workspacePath, tokenPath, ...(staticRoot ? { staticRoot } : {}) }))
kernel.mount(createSessionCatalogPlugin({ cachePath: sessionSidebarCachePath() }))
kernel.mount(localWorkspaceDiffPlugin)
kernel.mount(createAgentTransportPlugin({ cwd: workspacePath, demo: demoMode, ...(process.env.HEDDLEWORK_PI ? { command: process.env.HEDDLEWORK_PI } : {}), piArgs: piArgumentsFromEnvironment() }))
const controller = kernel.get(workbenchControllerToken)
const host = kernel.get(workspaceHostToken)
if (!host) throw new Error('Workspace host failed to start')
let disposed = false
const shutdown = (): void => { if (disposed) return; disposed = true; void kernel.dispose().finally(() => process.exit(0)) }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
console.log(`Heddlework host serving ${workspacePath}`)
console.log(`  url        ${host.url}`)
if (tokenPath) console.log(`  token file ${tokenPath}`)
if (process.env.HEDDLEWORK_HOST_PRINT_TOKEN === '1') console.log(`  connect    ${hostConnectUrl(host)}`)
else console.log('  pairing link hidden; set HEDDLEWORK_HOST_PRINT_TOKEN=1 to print it')
void controller.start()
function resolveWorkspacePath(): string { if (process.env.HEDDLEWORK_CWD) return resolve(process.env.HEDDLEWORK_CWD); const argument = process.argv.slice(2).find((value) => value !== '--' && !value.startsWith('-')); return resolve(argument ?? process.cwd()) }
function piArgumentsFromEnvironment(): string[] { const args: string[] = []; if (process.env.HEDDLEWORK_PROVIDER) args.push('--provider', process.env.HEDDLEWORK_PROVIDER); if (process.env.HEDDLEWORK_MODEL) args.push('--model', process.env.HEDDLEWORK_MODEL); if (process.env.HEDDLEWORK_SESSION) args.push('--session', process.env.HEDDLEWORK_SESSION); if (process.env.HEDDLEWORK_NO_SESSION === '1') args.push('--no-session'); return args }
