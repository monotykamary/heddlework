import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyResolvedTheme, parseOmarchyPalette, type ResolvedTheme, type ColorPalette } from './theme.ts'

export type ThemeMode = 'system' | ResolvedTheme

export interface ThemeSnapshot {
  mode: ThemeMode
  resolved: ResolvedTheme
}

export interface ThemeManagerOptions {
  preferencePath?: string | false
  resolveSystemTheme?: () => ResolvedTheme
  pollIntervalMs?: number
  omarchyPath?: string | false
  enableEventSource?: boolean
}

type Cleanup = () => void

interface ThemeMonitorProcess {
  kill(signal?: string): void
  stdout?: { on(event: 'data', cb: () => void): void }
  on?(event: 'error' | 'exit', listener: (...args: unknown[]) => void): unknown
  off?(event: 'error' | 'exit', listener: (...args: unknown[]) => void): unknown
}

interface ThemeFileWatcher {
  close(): void
  on(event: 'error', listener: () => void): unknown
  off?(event: 'error', listener: () => void): unknown
}

interface ThemeMonitorHooks {
  platform?: NodeJS.Platform
  spawnProcess?: (command: string, args: string[]) => ThemeMonitorProcess | undefined
  watcher?: (path: string, onChange: () => void) => { dispose(): void } | undefined
  watchFile?: (path: string, onChange: () => void) => ThemeFileWatcher
  readFile?: (path: string) => string | undefined
}

export class ThemeManager {
  readonly #listeners = new Set<() => void>()
  readonly #preferencePath: string | false
  readonly #resolveSystemTheme: () => ResolvedTheme
  readonly #pollIntervalMs: number
  readonly #omarchyPath: string | false
  readonly #enableEventSource: boolean
  readonly #cleanups: Cleanup[] = []
  #snapshot: ThemeSnapshot
  #started = false
  #pollTimer: ReturnType<typeof setInterval> | undefined
  #lastOverlayKey: string | undefined

  constructor(options: ThemeManagerOptions = {}, private readonly hooks: ThemeMonitorHooks = {}) {
    this.#preferencePath = options.preferencePath === undefined ? themePreferencePath() : options.preferencePath
    this.#resolveSystemTheme = options.resolveSystemTheme ?? detectSystemTheme
    this.#pollIntervalMs = options.pollIntervalMs ?? 2_000
    // Omarchy palette is an opt-in overlay: constructors that want it must pass
    // an absolute omarchyPath. Defaulting to off keeps unit tests hermetic and
    // keeps Heddlework fully independent of Omarchy's config layout.
    this.#omarchyPath = options.omarchyPath ?? false
    this.#enableEventSource = options.enableEventSource ?? false
    const mode = readThemeMode(this.#preferencePath) ?? 'system'
    this.#snapshot = { mode, resolved: mode === 'system' ? this.#resolveSystemTheme() : mode }
    const initialOverlay = this.#readOmarchyOverlay()
    this.#lastOverlayKey = initialOverlay ? stablePaletteKey(initialOverlay) : undefined
    applyResolvedTheme(this.#snapshot.resolved, initialOverlay)
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): ThemeSnapshot => this.#snapshot

  setMode(mode: ThemeMode): void {
    const resolved = mode === 'system' ? this.#resolveSystemTheme() : mode
    if (mode === this.#snapshot.mode && resolved === this.#snapshot.resolved) return
    const overlay = this.#readOmarchyOverlay()
    this.#lastOverlayKey = overlay ? stablePaletteKey(overlay) : undefined
    this.#snapshot = { mode, resolved }
    applyResolvedTheme(resolved, overlay)
    writeThemeMode(this.#preferencePath, mode)
    this.#emit()
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    const platform = this.hooks.platform ?? process.platform
    const sources = this.#enableEventSource ? this.#attachEventSources(platform) : { system: false, omarchy: false }
    const omarchyUnavailable = this.#omarchyPath !== false && !sources.omarchy
    if (!sources.system || omarchyUnavailable) this.#startPolling()
  }

  refreshSystemTheme(): void {
    const resolved = this.#snapshot.mode === 'system' ? this.#resolveSystemTheme() : this.#snapshot.resolved
    const overlay = this.#readOmarchyOverlay()
    const overlayKey = overlay === undefined ? undefined : stablePaletteKey(overlay)
    if (resolved === this.#snapshot.resolved && overlayKey === this.#lastOverlayKey) return
    this.#snapshot = { mode: this.#snapshot.mode, resolved }
    this.#lastOverlayKey = overlayKey
    applyResolvedTheme(resolved, overlay)
    this.#emit()
  }

  dispose(): void {
    this.#started = false
    // Reverse (LIFO) teardown: last-attached source is withdrawn first so a
    // later-attached source never fires after a sibling is gone.
    while (this.#cleanups.length > 0) {
      const cleanup = this.#cleanups.pop()
      if (cleanup) { try { cleanup() } catch { } }
    }
    this.#listeners.clear()
  }

  #startPolling(): void {
    if (!this.#started || this.#pollTimer) return
    const timer = setInterval(() => this.refreshSystemTheme(), this.#pollIntervalMs)
    timer.unref?.()
    this.#pollTimer = timer
    this.#cleanups.push(() => {
      clearInterval(timer)
      if (this.#pollTimer === timer) this.#pollTimer = undefined
    })
  }

  #attachEventSources(platform: NodeJS.Platform): { system: boolean; omarchy: boolean } {
    let systemAttached = false
    let omarchyAttached = this.#omarchyPath === false
    if (platform === 'linux') {
      // A missing gsettings binary (KDE, XFCE, container) emits an unhandled
      // ChildProcess 'error' that would crash startup, so presence is probed
      // synchronously BEFORE spawning.
      if (this.hooks.spawnProcess !== undefined || this.#binaryOnPath('gsettings')) {
        const gsettings = this.#spawnProcess('gsettings', ['monitor', 'org.gnome.desktop.interface', 'color-scheme'])
        if (gsettings && gsettings.stdout) {
          const fallback = () => {
            if (!this.#started) return
            this.refreshSystemTheme()
            this.#startPolling()
          }
          gsettings.stdout.on('data', () => this.refreshSystemTheme())
          gsettings.on?.('error', fallback)
          gsettings.on?.('exit', fallback)
          this.#cleanups.push(() => {
            gsettings.off?.('exit', fallback)
            gsettings.off?.('error', fallback)
            try { gsettings.kill('SIGTERM') } catch { }
          })
          systemAttached = true
        }
      }
    }

    if (this.#omarchyPath !== false) {
      const watcher = this.hooks.watcher
        ? this.hooks.watcher(this.#omarchyPath, () => this.refreshSystemTheme())
        : this.#nativeWatcher(this.#omarchyPath)
      if (watcher) {
        omarchyAttached = true
        this.#cleanups.push(() => { try { watcher.dispose() } catch { } })
      }
    }

    return { system: systemAttached, omarchy: omarchyAttached }
  }

  #binaryOnPath(command: string): boolean {
    const dirs = (process.env.PATH ?? '').split(/[:;]/u)
    for (const dir of dirs) {
      if (dir && existsSync(join(dir, command))) return true
    }
    return false
  }

  #nativeWatcher(path: string): { dispose(): void } | undefined {
    // Watch the parent directory so atomic writes and renames both register.
    try {
      const watcher = this.hooks.watchFile
        ? this.hooks.watchFile(dirname(path), () => this.refreshSystemTheme())
        : watch(dirname(path), { persistent: false }, () => this.refreshSystemTheme())
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        watcher.off?.('error', onError)
        try { watcher.close() } catch { }
      }
      const onError = () => {
        close()
        if (this.#started) this.#startPolling()
      }
      watcher.on('error', onError)
      return { dispose: close }
    } catch {
      return undefined
    }
  }

  #spawnProcess(command: string, args: string[]): ThemeMonitorProcess | undefined {
    const spawnFn = this.hooks.spawnProcess ?? spawn
    try {
      const child = spawnFn(command, args)
      if (!child) return undefined
      return child as ThemeMonitorProcess
    } catch {
      return undefined
    }
  }

  #readOmarchyOverlay(): Partial<ColorPalette> | undefined {
    if (this.#omarchyPath === false) return undefined
    const read = this.hooks.readFile ?? ((path: string) => {
      try { return readFileSync(path, 'utf8') } catch { return undefined }
    })
    const content = read(this.#omarchyPath)
    return content === undefined ? undefined : parseOmarchyPalette(content)
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
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

export function omarchyThemePath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform !== 'linux') return ''
  return join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'omarchy', 'current', 'theme', 'colors.toml')
}

// Deterministic, insertion-stable serialization for change detection. Palette
// objects are small (on the order of 40 hex strings), so JSON with sorted keys
// keeps repeated parses of an unchanged file cheap to compare.
function stablePaletteKey(overlay: Record<string, string>): string {
  const keys = Object.keys(overlay).sort()
  return keys.map((key) => key + '=' + overlay[key]).join(';')
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
