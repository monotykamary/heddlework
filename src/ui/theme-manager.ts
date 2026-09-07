import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyResolvedTheme, type ResolvedTheme } from './theme.ts'
import { readOmarchyPalette, type OmarchyThemeCandidate, type OmarchySourceState, type ThemePaletteStatus } from './omarchy-theme-source.ts'

export type ThemeMode = 'system' | ResolvedTheme
export interface ThemeSnapshot { mode: ThemeMode; resolved: ResolvedTheme; palette: ThemePaletteStatus }
export interface ThemeManagerOptions {
  appearanceSource?: { getSnapshot(): { appearance: ResolvedTheme }; subscribe(listener: () => void): () => void }
  preferencePath?: string | false
  resolveSystemTheme?: () => ResolvedTheme
  pollIntervalMs?: number
  omarchyCandidates?: readonly OmarchyThemeCandidate[]
  enableEventSource?: boolean
  debounceMs?: number
}
type Cleanup = () => void
interface ThemeFileWatcher {
  close(): void
  on(event: 'error', listener: () => void): unknown
  off?(event: 'error', listener: () => void): unknown
}
interface ThemeMonitorHooks {
  platform?: NodeJS.Platform
  watcher?: (path: string, onChange: () => void) => { dispose(): void } | undefined
  watchFile?: (path: string, onChange: () => void) => ThemeFileWatcher
  readFile?: (path: string) => string | undefined
}

export class ThemeManager {
  readonly #listeners = new Set<() => void>()
  readonly #preferencePath: string | false
  readonly #resolveSystemTheme: () => ResolvedTheme
  readonly #candidates: readonly OmarchyThemeCandidate[]
  readonly #cleanups: Cleanup[] = []
  readonly #watches = new Map<string, Cleanup>()
  #source: OmarchySourceState
  #snapshot: ThemeSnapshot
  #started = false
  #generation = 0
  #timer: ReturnType<typeof setInterval> | undefined
  #pending: ReturnType<typeof setTimeout> | undefined
  #overlayKey = ''

  constructor(private readonly options: ThemeManagerOptions = {}, private readonly hooks: ThemeMonitorHooks = {}) {
    this.#preferencePath = options.preferencePath === undefined ? themePreferencePath() : options.preferencePath
    this.#resolveSystemTheme = options.appearanceSource ? () => options.appearanceSource!.getSnapshot().appearance : options.resolveSystemTheme ?? detectSystemTheme
    this.#candidates = options.omarchyCandidates ?? []
    const mode = readThemeMode(this.#preferencePath) ?? 'system'
    this.#source = readOmarchyPalette(this.#candidates, undefined, hooks.readFile)
    this.#snapshot = { mode, resolved: mode === 'system' ? this.#resolveSystemTheme() : mode, palette: this.#source.status }
    this.#overlayKey = this.#paletteKey()
    applyResolvedTheme(this.#snapshot.resolved, this.#source.overlay)
  }
  readonly subscribe = (listener: () => void): Cleanup => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  readonly getSnapshot = (): ThemeSnapshot => this.#snapshot

  setMode(mode: ThemeMode): void {
    this.#refresh(mode)
    writeThemeMode(this.#preferencePath, mode)
  }
  refreshSystemTheme(): void { this.#refresh(this.#snapshot.mode) }
  #paletteKey(): string {
    return Object.entries(this.#source.overlay ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(';')
  }
  #refresh(mode: ThemeMode, resolvedHint?: ResolvedTheme): void {
    const resolved = mode === 'system' ? (resolvedHint ?? this.#resolveSystemTheme()) : mode
    this.#source = readOmarchyPalette(this.#candidates, this.#source, this.hooks.readFile)
    const key = this.#paletteKey()
    const changed = key !== this.#overlayKey || resolved !== this.#snapshot.resolved
    const snapshot = { mode, resolved, palette: this.#source.status }
    if (!changed && JSON.stringify(snapshot) === JSON.stringify(this.#snapshot)) return
    if (changed) applyResolvedTheme(resolved, this.#source.overlay)
    this.#overlayKey = key
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
  start(): void {
    if (this.#started) return
    this.#started = true
    const generation = ++this.#generation
    const alive = () => this.#started && this.#generation === generation
    const schedule = () => {
      if (!alive()) return
      if (this.#pending) clearTimeout(this.#pending)
      this.#pending = setTimeout(() => {
        this.#pending = undefined
        if (!alive()) return
        this.#reconcileWatches(schedule)
        this.refreshSystemTheme()
      }, this.options.debounceMs ?? 30)
      this.#pending.unref?.()
    }
    const poll = () => {
      if (this.#timer || !alive()) return
      this.#timer = setInterval(() => {
        if (!alive()) return
        this.#reconcileWatches(schedule)
        if (!this.#pending) this.#refresh(this.#snapshot.mode, this.options.appearanceSource ? this.options.appearanceSource.getSnapshot().appearance : undefined)
      }, this.options.pollIntervalMs ?? 2_000)
      this.#timer.unref?.()
    }
    if (this.options.appearanceSource) this.#cleanups.push(this.options.appearanceSource.subscribe(() => { if (alive()) this.refreshSystemTheme() }))
    this.#reconcileWatches(schedule)
    // Reconcile even with healthy watchers: directory replacement can silently invalidate them.
    if (!this.options.appearanceSource || this.#candidates.length) poll()
    this.refreshSystemTheme()
  }
  #reconcileWatches(schedule: () => void): void {
    if (!this.options.enableEventSource) return
    const roots = new Set(this.#candidates.map(candidate => candidate.watchRoot))
    const paths = new Set([...roots, ...this.#candidates.map(candidate => dirname(candidate.path))])
    for (const path of paths) {
      if (this.#watches.has(path)) continue
      let closed = false
      let dispose: Cleanup | undefined
      const close = () => {
        if (closed) return
        closed = true
        this.#watches.delete(path)
        dispose?.()
      }
      const generation = this.#generation
      const changed = () => {
        if (closed || !this.#started || generation !== this.#generation) return
        // Root changes invalidate child watches, which may still refer to removed inodes.
        if (roots.has(path)) for (const candidate of this.#candidates) {
          if (candidate.watchRoot === path) this.#watches.get(dirname(candidate.path))?.()
        }
        else close()
        schedule()
      }
      try {
        if (this.hooks.watcher) {
          const watcher = this.hooks.watcher(path, changed)
          if (!watcher) continue
          dispose = () => watcher.dispose()
        } else {
          const watcher = this.hooks.watchFile ? this.hooks.watchFile(path, changed) : watch(path, { persistent: false }, changed)
          const error = () => { close(); schedule() }
          watcher.on('error', error)
          dispose = () => { watcher.off?.('error', error); watcher.close() }
        }
        this.#watches.set(path, close)
      } catch { /* The reconciliation poll retries missing roots and failed watches. */ }
    }
  }
  dispose(): void {
    this.#started = false
    ++this.#generation
    if (this.#pending) clearTimeout(this.#pending)
    if (this.#timer) clearInterval(this.#timer)
    this.#pending = undefined
    this.#timer = undefined
    for (const close of [...this.#watches.values()].reverse()) { try { close() } catch {} }
    while (this.#cleanups.length) { try { this.#cleanups.pop()!() } catch {} }
    this.#listeners.clear()
  }
}

export function detectSystemTheme(platform: NodeJS.Platform = process.platform, run: (command: string, args: string[]) => string | undefined = runCommand): ResolvedTheme {
  if (platform === 'darwin') {
    const value = run('defaults', ['read', '-g', 'AppleInterfaceStyle'])
    return value?.trim().toLowerCase() === 'dark' ? 'dark' : 'light'
  }
  if (platform === 'win32') {
    const value = run('powershell.exe', ['-NoProfile', '-Command', '(Get-ItemProperty -Path HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize).AppsUseLightTheme'])
    return value?.trim() === '0' ? 'dark' : 'light'
  }
  if (platform === 'linux') {
    const scheme = run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme'])?.toLowerCase()
    if (scheme?.includes('dark')) return 'dark'
    if (scheme?.includes('light')) return 'light'
    const gtkTheme = run('gsettings', ['get', 'org.gnome.desktop.interface', 'gtk-theme'])?.toLowerCase()
    if (gtkTheme) return gtkTheme.includes('dark') ? 'dark' : 'light'
    if (scheme?.includes('default')) return 'light'
  }
  return 'dark'
}

export function themePreferencePath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'preferences.json')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'preferences.json')
  return join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'heddlework', 'preferences.json')
}

function runCommand(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 750 })
  } catch {
    return undefined
  }
}

function readThemeMode(path: string | false): ThemeMode | undefined {
  if (!path) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { themeMode?: unknown }
    return value.themeMode === 'system' || value.themeMode === 'light' || value.themeMode === 'dark' ? value.themeMode : undefined
  } catch {
    return undefined
  }
}

function writeThemeMode(path: string | false, mode: ThemeMode): void {
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ themeMode: mode }, null, 2) + '\n', 'utf8')
  } catch {
    // Theme changes still apply for this run when the preference cannot be persisted.
  }
}

export const defaultThemeManager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => 'dark' })
