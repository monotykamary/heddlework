import { spawn } from 'node:child_process'
import { detectSystemTheme } from '../ui/theme-manager.ts'
import type { ResolvedTheme } from '../ui/theme.ts'
import { requestPortalDirectory, type PortalPickResult } from '../ui/portal-file-chooser.ts'
import { directoryPickerCommands, runDirectoryPicker } from '../ui/open-external.ts'
import { abortable, throwIfAborted } from './process.ts'

export interface LinuxDesktopSnapshot {
  appearance: ResolvedTheme
  appearanceBackend: 'monitor' | 'poll'
  pickerBackend: 'unprobed' | 'cli-portal' | 'fallback-dialog' | 'unavailable'
  degradations: readonly string[]
}
export class LinuxDesktopIntegration {
  #listeners = new Set<() => void>()
  #operations = new Set<AbortController>()
  #disposed = false
  #started = false
  #cleanup: Array<() => void> = []
  #snapshot: LinuxDesktopSnapshot
  constructor(private readonly options: {
    resolveAppearance?: () => ResolvedTheme
    spawnMonitor?: typeof spawn
    portal?: (signal: AbortSignal) => Promise<PortalPickResult>
    dialog?: typeof runDirectoryPicker
    pollIntervalMs?: number
  } = {}) {
    this.#snapshot = { appearance: this.#resolve(), appearanceBackend: 'poll', pickerBackend: 'unprobed', degradations: [] }
  }
  #resolve(): ResolvedTheme { return this.options.resolveAppearance?.() ?? detectSystemTheme('linux') }
  getSnapshot = (): LinuxDesktopSnapshot => this.#snapshot
  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => {}
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
  #publish(patch: Partial<LinuxDesktopSnapshot>): void {
    if (this.#disposed) return
    const next = { ...this.#snapshot, ...patch }
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return
    this.#snapshot = next
    for (const listener of this.#listeners) listener()
  }
  start(): void {
    if (this.#started || this.#disposed) return
    this.#started = true
    const refresh = () => { if (!this.#disposed) this.#publish({ appearance: this.#resolve() }) }
    let debounce: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      if (this.#disposed) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { debounce = undefined; refresh() }, 30)
      debounce.unref?.()
    }
    let polling = false
    const fallback = () => {
      if (this.#disposed || polling) return
      polling = true
      this.#publish({ appearanceBackend: 'poll', degradations: ['appearance-monitor-unavailable'] })
      refresh()
      const timer = setInterval(refresh, this.options.pollIntervalMs ?? 2000)
      timer.unref?.()
      this.#cleanup.push(() => clearInterval(timer))
    }
    try {
      const child = (this.options.spawnMonitor ?? spawn)('gsettings', ['monitor', 'org.gnome.desktop.interface', 'color-scheme'], { stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout?.on('data', scheduleRefresh)
      child.on('error', fallback)
      child.on('exit', fallback)
      this.#cleanup.push(() => {
        if (debounce) clearTimeout(debounce)
        child.stdout?.off('data', scheduleRefresh)
        child.off('exit', fallback)
        // Keep an error sink until close: spawn errors can arrive after disposal.
        child.once('close', () => child.off('error', fallback))
        child.kill('SIGTERM')
      })
      if (child.stdout) this.#publish({ appearanceBackend: 'monitor' }); else fallback()
    } catch { fallback() }
  }
  pickDirectory = async (signal?: AbortSignal): Promise<PortalPickResult> => {
    const operation = new AbortController()
    if (this.#disposed || signal?.aborted) operation.abort()
    throwIfAborted(operation.signal)
    const abort = () => operation.abort()
    signal?.addEventListener('abort', abort, { once: true })
    for (const previous of this.#operations) previous.abort()
    this.#operations.add(operation)
    try {
      const portal = await abortable((this.options.portal ?? (signal => requestPortalDirectory({}, signal)))(operation.signal), operation.signal)
      if (portal.status !== 'unavailable') { this.#publish({ pickerBackend: 'cli-portal' }); return portal }
      for (const command of directoryPickerCommands('linux')) {
        throwIfAborted(operation.signal)
        const result = await abortable((this.options.dialog ?? runDirectoryPicker)(command, operation.signal), operation.signal)
        if (result.status !== 'unavailable') { this.#publish({ pickerBackend: 'fallback-dialog' }); return result }
      }
      this.#publish({ pickerBackend: 'unavailable' })
      return { status: 'unavailable', error: 'No folder picker is available on this system' }
    } finally {
      signal?.removeEventListener('abort', abort)
      this.#operations.delete(operation)
    }
  }
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const operation of this.#operations) operation.abort()
    while (this.#cleanup.length) { try { this.#cleanup.pop()!() } catch {} }
    this.#listeners.clear()
  }
}
