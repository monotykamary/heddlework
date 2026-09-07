import { spawn } from 'node:child_process'
import { detectSystemTheme } from '../ui/theme-manager.ts'
import type { ResolvedTheme } from '../ui/theme.ts'
import { requestPortalDirectory, type PortalPickResult } from '../ui/portal-file-chooser.ts'
import { directoryPickerCommands, runDirectoryPicker } from '../ui/open-external.ts'
import { abortable, throwIfAborted } from './process.ts'
import type { SubscribeSystemAppearance, SystemAppearanceEvent } from './native-appearance.ts'
import type { NativeDirectoryPicker } from './native-directory-picker.ts'

export interface LinuxDesktopSnapshot {
  appearance: ResolvedTheme
  appearanceBackend: 'initializing' | 'native' | 'monitor' | 'poll'
  pickerBackend: 'unprobed' | 'native-portal' | 'cli-portal' | 'fallback-dialog' | 'unavailable'
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
    nativeDirectoryPicker?: NativeDirectoryPicker
    subscribeNativeAppearance?: SubscribeSystemAppearance
    nativeSetupTimeoutMs?: number
  } = {}) {
    // M3 deliberately uses the built-in default during asynchronous native setup;
    // `initializing` distinguishes it from an observed desktop preference without
    // blocking the first render on gsettings or portal availability.
    this.#snapshot = { appearance: options.subscribeNativeAppearance ? 'dark' : this.#resolve(), appearanceBackend: options.subscribeNativeAppearance ? 'initializing' : 'poll', pickerBackend: 'unprobed', degradations: [] }
  }
  #appearanceDiagnostics(reasons: string[]): void {
    this.#publish({ degradations: [
      ...this.#snapshot.degradations.filter(reason => !reason.startsWith('appearance-')),
      ...reasons,
      ...this.#snapshot.degradations.filter(reason => reason === 'appearance-monitor-unavailable'),
    ] })
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
    let stopFallback: (() => void) | undefined
    const fallback = (reason: string) => {
      this.#appearanceDiagnostics([reason])
      stopFallback ??= this.#startFallback()
    }
    this.#cleanup.push(() => { stopFallback?.(); stopFallback = undefined })
    const subscribe = this.options.subscribeNativeAppearance
    if (!subscribe) { fallback('appearance-native-unavailable'); return }
    let retired = false
    let subscription: ReturnType<SubscribeSystemAppearance> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const retire = () => {
      retired = true
      if (timer) clearTimeout(timer)
      subscription?.dispose()
      subscription = undefined
    }
    const unavailable = (reason: string) => {
      if (retired || this.#disposed) return
      retire()
      fallback(reason)
    }
    const receive = (event: SystemAppearanceEvent) => {
      if (retired || this.#disposed) return
      if (timer) clearTimeout(timer)
      if (event.status === 'unavailable') { unavailable('appearance-native-failed'); return }
      if (event.preference === 'none') { fallback('appearance-native-no-preference'); return }
      stopFallback?.()
      stopFallback = undefined
      this.#publish({ appearance: event.preference, appearanceBackend: 'native', degradations: this.#snapshot.degradations.filter(reason => !reason.startsWith('appearance-')) })
    }
    this.#cleanup.push(retire)
    timer = setTimeout(() => unavailable('appearance-native-timeout'), this.options.nativeSetupTimeoutMs ?? 6000)
    timer.unref?.()
    try {
      subscription = subscribe(receive)
      // Also support injected adapters that report a failure during registration.
      if (retired || this.#disposed) { subscription.dispose(); subscription = undefined }
    } catch { unavailable('appearance-native-failed') }
  }
  #startFallback(): () => void {
    let stopped = false
    const cleanups: Array<() => void> = []
    const refresh = () => { if (!this.#disposed && !stopped) this.#publish({ appearance: this.#resolve() }) }
    let debounce: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      if (this.#disposed || stopped) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { debounce = undefined; refresh() }, 30)
      debounce.unref?.()
    }
    let polling = false
    const fallback = () => {
      if (this.#disposed || stopped || polling) return
      polling = true
      this.#publish({ appearanceBackend: 'poll', degradations: [...new Set([...this.#snapshot.degradations, 'appearance-monitor-unavailable'])] })
      refresh()
      const timer = setInterval(refresh, this.options.pollIntervalMs ?? 2000)
      timer.unref?.()
      cleanups.push(() => clearInterval(timer))
    }
    try {
      const child = (this.options.spawnMonitor ?? spawn)('gsettings', ['monitor', 'org.gnome.desktop.interface', 'color-scheme'], { stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout?.on('data', scheduleRefresh)
      child.on('error', fallback)
      child.on('exit', fallback)
      cleanups.push(() => {
        if (debounce) clearTimeout(debounce)
        child.stdout?.off('data', scheduleRefresh)
        child.off('exit', fallback)
        // Keep an error sink until close: spawn errors can arrive after disposal.
        child.once('close', () => child.off('error', fallback))
        child.kill('SIGTERM')
      })
      if (child.stdout) this.#publish({ appearanceBackend: 'monitor' }); else fallback()
    } catch { fallback() }
    refresh()
    return () => {
      if (stopped) return
      stopped = true
      while (cleanups.length) { try { cleanups.pop()!() } catch {} }
    }
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
      if (this.options.nativeDirectoryPicker) {
        const result = await abortable(this.options.nativeDirectoryPicker.pick(operation.signal), operation.signal)
        throwIfAborted(operation.signal)
        if (result.status !== 'unavailable') {
          this.#publish({ pickerBackend: 'native-portal' })
          return result
        }
        if (!result.safeToFallback) {
          this.#publish({ pickerBackend: 'unavailable' })
          return { status: 'unavailable', error: result.reason }
        }
      }
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
    this.options.nativeDirectoryPicker?.dispose()
    while (this.#cleanup.length) { try { this.#cleanup.pop()!() } catch {} }
    this.#listeners.clear()
  }
}
