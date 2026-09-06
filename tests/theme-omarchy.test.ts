import { afterEach, describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { applyResolvedTheme, parseOmarchyPalette, darkColors, colors } from '../src/ui/theme.ts'
import { ThemeManager, omarchyThemePath } from '../src/ui/theme-manager.ts'

afterEach(() => {
  applyResolvedTheme('dark')
})

const TOML = [
  'mode = "dark"',
  'background = "#140000"',
  'foreground = "#FED700"',
  'accent = "#3b6cfe"',
  'muted = "#6f6766"',
].join('\n')

describe('parseOmarchyPalette', () => {
  it('maps semantic colors onto the palette', () => {
    const overlay = parseOmarchyPalette(TOML)
    expect(overlay?.background).toBe('#140000')
    expect(overlay?.window).toBe('#140000')
    expect(overlay?.text).toBe('#FED700')
    expect(overlay?.primary).toBe('#3b6cfe')
    expect(overlay?.textMuted).toBe('#6f6766')
  })

  it('returns undefined for empty or malformed input', () => {
    expect(parseOmarchyPalette('')).toBeUndefined()
    expect(parseOmarchyPalette('# only comments\n[section]\n')).toBeUndefined()
  })

  it('rejects non-hex or malformed color values silently', () => {
    const overlay = parseOmarchyPalette('background = "not-a-color"\nforeground = "#123"')
    expect(overlay?.background).toBeUndefined()
    expect(overlay?.text).toBeUndefined()
  })
})

function makeFakeWatcher() {
  let disposed = 0
  return {
    dispose: () => { disposed += 1 },
    disposed: () => disposed > 0,
  }
}

function makeFakeMonitor() {
  const events = new EventEmitter()
  const stdout = new EventEmitter()
  const killSignals: string[] = []
  const process = {
    stdout,
    on: events.on.bind(events),
    off: events.off.bind(events),
    kill: (signal = 'SIGTERM') => { killSignals.push(signal) },
  }
  return { events, process, killSignals }
}

describe('ThemeManager event source lifecycle', () => {
  it('runs polling under an injected resolver and releases on dispose', () => {
    // With no event sources, start() falls back to a polling timer that the
    // constructor keeps tracked for reversible teardown.
    let systemTheme: 'light' | 'dark' = 'dark'
    const manager = new ThemeManager({
      preferencePath: false,
      resolveSystemTheme: () => systemTheme,
      omarchyPath: false,
      enableEventSource: false,
    })
    manager.start()
    manager.dispose()
    expect(manager.getSnapshot().resolved).toBe('dark')
  })

  it('falls back to polling when the system monitor errors and terminates it on disposal', async () => {
    let systemTheme: 'light' | 'dark' = 'dark'
    const monitor = makeFakeMonitor()
    const manager = new ThemeManager({
      preferencePath: false,
      resolveSystemTheme: () => systemTheme,
      pollIntervalMs: 1,
      omarchyPath: false,
      enableEventSource: true,
    }, {
      platform: 'linux',
      spawnProcess: () => monitor.process,
    })

    manager.start()
    try {
      systemTheme = 'light'
      expect(() => monitor.events.emit('error', new Error('EACCES'))).not.toThrow()
      await Bun.sleep(10)
      expect(manager.getSnapshot().resolved).toBe('light')
    } finally {
      manager.dispose()
    }
    expect(monitor.killSignals).toEqual(['SIGTERM'])
  })

  it('falls back to polling when the system monitor exits early', async () => {
    let systemTheme: 'light' | 'dark' = 'dark'
    const monitor = makeFakeMonitor()
    const manager = new ThemeManager({
      preferencePath: false,
      resolveSystemTheme: () => systemTheme,
      pollIntervalMs: 1,
      omarchyPath: false,
      enableEventSource: true,
    }, {
      platform: 'linux',
      spawnProcess: () => monitor.process,
    })

    manager.start()
    try {
      systemTheme = 'light'
      monitor.events.emit('exit', 1)
      await Bun.sleep(10)
      expect(manager.getSnapshot().resolved).toBe('light')
    } finally {
      manager.dispose()
    }
  })

  it('refreshes Omarchy colors while an explicit theme mode is selected', () => {
    let content = 'background = "#140000"'
    let onChange: (() => void) | undefined
    const manager = new ThemeManager({
      preferencePath: false,
      resolveSystemTheme: () => 'dark',
      omarchyPath: '/tmp/fake-omarchy/colors.toml',
      enableEventSource: true,
    }, {
      platform: 'linux',
      spawnProcess: () => undefined,
      watcher: (_path, listener) => {
        onChange = listener
        return { dispose() {} }
      },
      readFile: () => content,
    })
    manager.start()
    manager.setMode('light')
    let notifications = 0
    manager.subscribe(() => { notifications += 1 })

    content = 'background = "#220000"'
    onChange?.()

    expect(colors.background).toBe('#220000')
    expect(manager.getSnapshot()).toEqual({ mode: 'light', resolved: 'light' })
    expect(notifications).toBe(1)
    manager.dispose()
  })

  it('polls when the Omarchy watcher is unavailable beside a live system monitor', async () => {
    let content = 'background = "#140000"'
    const monitor = makeFakeMonitor()
    const manager = new ThemeManager({
      preferencePath: false,
      resolveSystemTheme: () => 'dark',
      pollIntervalMs: 1,
      omarchyPath: '/tmp/fake-omarchy/colors.toml',
      enableEventSource: true,
    }, {
      platform: 'linux',
      spawnProcess: () => monitor.process,
      watcher: () => undefined,
      readFile: () => content,
    })

    manager.start()
    try {
      content = 'background = "#220000"'
      await Bun.sleep(10)
      expect(colors.background).toBe('#220000')
    } finally {
      manager.dispose()
    }
  })

  it('handles asynchronous native watcher errors and falls back to polling', async () => {
    let content = 'background = "#140000"'
    const watcherEvents = new EventEmitter()
    let closed = false
    const monitor = makeFakeMonitor()
    const manager = new ThemeManager({
      preferencePath: false,
      resolveSystemTheme: () => 'dark',
      pollIntervalMs: 1,
      omarchyPath: '/tmp/fake-omarchy/colors.toml',
      enableEventSource: true,
    }, {
      platform: 'linux',
      spawnProcess: () => monitor.process,
      watchFile: () => ({
        on: watcherEvents.on.bind(watcherEvents),
        off: watcherEvents.off.bind(watcherEvents),
        close: () => { closed = true },
      }),
      readFile: () => content,
    })

    manager.start()
    try {
      content = 'background = "#330000"'
      expect(() => watcherEvents.emit('error', new Error('watch failed'))).not.toThrow()
      await Bun.sleep(10)
      expect(closed).toBe(true)
      expect(colors.background).toBe('#330000')
    } finally {
      manager.dispose()
    }
  })

  it('dispose() runs attached watcher cleanups', () => {
    const watcher = makeFakeWatcher()
    const manager = new ThemeManager({
      preferencePath: false,
      resolveSystemTheme: () => 'dark',
      omarchyPath: '/tmp/fake-omarchy/colors.toml',
      enableEventSource: true,
    }, {
      platform: 'linux',
      spawnProcess: () => undefined,           // force fs watcher path
      watcher: () => watcher as { dispose(): void },
    })
    manager.start()
    expect(watcher.disposed()).toBe(false)
    manager.dispose()
    expect(watcher.disposed()).toBe(true)
  })
})

describe('omarchyThemePath', () => {
  it('derives the current colors file under XDG_CONFIG_HOME', () => {
    expect(omarchyThemePath('linux', { XDG_CONFIG_HOME: '/cf' } as NodeJS.ProcessEnv, '/home/u')).toBe('/cf/omarchy/current/theme/colors.toml')
    expect(omarchyThemePath('darwin', { XDG_CONFIG_HOME: '/cf' } as NodeJS.ProcessEnv, '/home/u')).toBe('')
  })
})
