import { watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '..')
const webRoot = resolve(root, 'dist', 'web')
let active: Promise<void> | undefined
async function rebuild(): Promise<void> { if (active) return active; active = (async () => { const child = spawn(process.execPath, [resolve(root, 'scripts/build-web.ts')], { cwd: root, stdio: 'inherit' }); const code = await new Promise<number | null>((done) => child.on('exit', done)); if (code !== 0) throw new Error(`build-web exited ${code}`) })().finally(() => { active = undefined }); return active }
await rebuild()
const environment = { ...process.env, HEDDLEWORK_HOST: '1', HEDDLEWORK_WEB_ROOT: webRoot, HEDDLEWORK_HOST_PRINT_TOKEN: process.env.HEDDLEWORK_HOST_PRINT_TOKEN ?? '1' }
const host = spawn(process.execPath, [resolve(root, 'src/host/main.ts'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: environment })
let queued = false
const watcher = watch(resolve(root, 'src'), { recursive: true }, () => { if (queued) return; queued = true; setTimeout(() => { queued = false; void rebuild().catch(console.error) }, 80) })
const stop = (signal: NodeJS.Signals) => { watcher.close(); host.kill(signal) }
process.once('SIGINT', () => stop('SIGINT')); process.once('SIGTERM', () => stop('SIGTERM')); host.on('exit', (code) => process.exit(code ?? 0))
