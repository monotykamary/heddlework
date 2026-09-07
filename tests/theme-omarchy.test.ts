import { LinuxDesktopIntegration } from '../src/linux/desktop-integration.ts'
import { omarchyThemeCandidates, parseOmarchyPalette } from '../src/ui/omarchy-theme-source.ts'
import { afterEach, describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { applyResolvedTheme, darkColors, colors } from '../src/ui/theme.ts'
import { ThemeManager } from '../src/ui/theme-manager.ts'

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
  it('rejects an entire replacement when a recognized field is malformed', () => {
    expect(parseOmarchyPalette('background = "#123456"\nforeground = "#12')).toBeUndefined()
  })

  it('does not interpret nested table colors as root palette fields', () => {
    expect(parseOmarchyPalette('[application]\nbackground = "#123456"')).toBeUndefined()
  })

  it('accepts distinct aliases in file order while rejecting repeated raw keys', () => {
    for (const [alias, key, target] of [['bg', 'background', 'background'], ['fg', 'foreground', 'text'], ['panel', 'sidebar', 'sidebar']] as const) {
      expect(parseOmarchyPalette(`${alias} = "#123456"\n${key} = "#abcdef"`)?.[target]).toBe('#abcdef')
      expect(parseOmarchyPalette(`${key} = "#abcdef"\n${alias} = "#123456"`)?.[target]).toBe('#123456')
      expect(parseOmarchyPalette(`${alias} = "#123456"\n${alias} = "#abcdef"`)).toBeUndefined()
    }
  })

  it('rejects duplicate recognized assignments', () => {
    expect(parseOmarchyPalette('background = "#123456"\nbackground = "#abcdef"')).toBeUndefined()
  })
  it('maps semantic colors onto the palette', () => {
    const overlay = parseOmarchyPalette(TOML)
    expect(overlay?.background).toBe('#140000')
    expect(overlay?.window).toBe('#140000')
    expect(overlay?.text).toBe('#fed700')
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
    once: events.once.bind(events),
    off: events.off.bind(events),
    kill: (signal = 'SIGTERM') => { killSignals.push(signal) },
  }
  return { events, process, killSignals }
}

describe('ThemeManager event source lifecycle', () => {
  it('polls palettes without probing appearance while the monitor is alive, then resumes detection on exit', async () => {
    const monitor = makeFakeMonitor()
    let calls = 0
    let appearance: 'dark' | 'light' = 'dark'
    let content = 'background = "#123456"'
    const desktop = new LinuxDesktopIntegration({ resolveAppearance: () => { calls++; return appearance }, spawnMonitor: (() => monitor.process) as never, pollIntervalMs: 2 })
    desktop.start()
    const manager = new ThemeManager({
      preferencePath: false, appearanceSource: desktop,
      omarchyCandidates: omarchyThemeCandidates('linux', {}, '/fixture'),
      enableEventSource: true, pollIntervalMs: 2, debounceMs: 1,
    }, { platform: 'linux', watcher: () => undefined, readFile: () => content })
    manager.start()
    try {
      const initialCalls = calls
      content = 'background = "#abcdef"'
      await Bun.sleep(20)
      expect(colors.background).toBe('#abcdef')
      expect(calls).toBe(initialCalls)
      appearance = 'light'
      monitor.process.stdout.emit('data')
      monitor.process.stdout.emit('data')
      expect(calls).toBe(initialCalls)
      await Bun.sleep(60)
      expect(calls).toBe(initialCalls + 1)
      expect(manager.getSnapshot().resolved).toBe('light')
      expect(calls).toBeGreaterThan(initialCalls)
      monitor.events.emit('exit', 1)
      const exitCalls = calls
      appearance = 'dark'
      await Bun.sleep(10)
      expect(calls).toBeGreaterThan(exitCalls)
      expect(manager.getSnapshot().resolved).toBe('dark')
    } finally { manager.dispose(); desktop.dispose() }
  })
  it('runs polling under an injected resolver and releases on dispose', () => {
    // With no event sources, start() falls back to a polling timer that the
    // constructor keeps tracked for reversible teardown.
    let systemTheme: 'light' | 'dark' = 'dark'
    const manager = new ThemeManager({
      preferencePath: false,
      resolveSystemTheme: () => systemTheme,
      omarchyCandidates: [],
      enableEventSource: false,
    })
    manager.start()
    manager.dispose()
    expect(manager.getSnapshot().resolved).toBe('dark')
  })

  it('falls back to polling when the system monitor errors and terminates it on disposal', async () => {
    let systemTheme: 'light' | 'dark' = 'dark'
    const monitor = makeFakeMonitor()
    const desktop = new LinuxDesktopIntegration({ resolveAppearance: () => systemTheme, spawnMonitor: (() => monitor.process) as never, pollIntervalMs: 1 })
    desktop.start()
    const manager = new ThemeManager({
      appearanceSource: desktop,
      preferencePath: false,
      resolveSystemTheme: () => systemTheme,
      pollIntervalMs: 1,
      omarchyCandidates: [],
      enableEventSource: true,
    }, {
      platform: 'linux',
      })

    manager.start()
    try {
      systemTheme = 'light'
      expect(() => monitor.events.emit('error', new Error('EACCES'))).not.toThrow()
      await Bun.sleep(10)
      expect(manager.getSnapshot().resolved).toBe('light')
    } finally {
      manager.dispose()
      desktop.dispose()
    }
    expect(monitor.killSignals).toEqual(['SIGTERM'])
  })

  it('falls back to polling when the system monitor exits early', async () => {
    let systemTheme: 'light' | 'dark' = 'dark'
    const monitor = makeFakeMonitor()
    const desktop = new LinuxDesktopIntegration({ resolveAppearance: () => systemTheme, spawnMonitor: (() => monitor.process) as never, pollIntervalMs: 1 })
    desktop.start()
    const manager = new ThemeManager({
      appearanceSource: desktop,
      preferencePath: false,
      resolveSystemTheme: () => systemTheme,
      pollIntervalMs: 1,
      omarchyCandidates: [],
      enableEventSource: true,
    }, {
      platform: 'linux',
      })

    manager.start()
    try {
      systemTheme = 'light'
      monitor.events.emit('exit', 1)
      await Bun.sleep(10)
      expect(manager.getSnapshot().resolved).toBe('light')
    } finally {
      manager.dispose()
      desktop.dispose()
    }
  })

  it('refreshes Omarchy colors while an explicit theme mode is selected', async () => {
    let content = 'background = "#140000"'
    let onChange: (() => void) | undefined
    const manager = new ThemeManager({
      preferencePath: false,
      resolveSystemTheme: () => 'dark',
      omarchyCandidates: [{ kind: 'state', path: '/tmp/fake-omarchy/theme/colors.toml', watchRoot: '/tmp/fake-omarchy' }], debounceMs: 1,
      enableEventSource: true,
    }, {
      platform: 'linux',
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
    await Bun.sleep(10)

    expect(colors.background).toBe('#220000')
    expect(manager.getSnapshot()).toMatchObject({ mode: 'light', resolved: 'light' })
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
      omarchyCandidates: [{ kind: 'state', path: '/tmp/fake-omarchy/theme/colors.toml', watchRoot: '/tmp/fake-omarchy' }], debounceMs: 1,
      enableEventSource: true,
    }, {
      platform: 'linux',
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
      omarchyCandidates: [{ kind: 'state', path: '/tmp/fake-omarchy/theme/colors.toml', watchRoot: '/tmp/fake-omarchy' }], debounceMs: 1,
      enableEventSource: true,
    }, {
      platform: 'linux',
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
      omarchyCandidates: [{ kind: 'state', path: '/tmp/fake-omarchy/theme/colors.toml', watchRoot: '/tmp/fake-omarchy' }], debounceMs: 1,
      enableEventSource: true,
    }, {
      platform: 'linux',
      watcher: () => watcher as { dispose(): void },
    })
    manager.start()
    expect(watcher.disposed()).toBe(false)
    manager.dispose()
    expect(watcher.disposed()).toBe(true)
  })
})

describe('source transitions', () => {
  it('recovers missing roots and watches real directory replacements without a palette reset', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join, dirname } = await import('node:path')
    const home = mkdtempSync(join(tmpdir(), 'heddlework-omarchy-'))
    const candidates = omarchyThemeCandidates('linux', {}, home)
    const path = candidates[0]!.path
    const manager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => 'dark', omarchyCandidates: candidates, enableEventSource: true, pollIntervalMs: 20, debounceMs: 2 }, { platform: 'linux', })
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2_000
      while (!predicate() && Date.now() < deadline) await Bun.sleep(5)
      expect(predicate()).toBe(true)
    }
    manager.start()
    try {
      expect(manager.getSnapshot().palette.applied).toBe('builtin')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'background = "#123456"')
      await until(() => colors.background === '#123456')
      const observed: string[] = []
      manager.subscribe(() => observed.push(colors.background))
      rmSync(dirname(path), { recursive: true })
      await until(() => manager.getSnapshot().palette.health === 'missing')
      expect(colors.background).toBe('#123456')
      mkdirSync(dirname(path))
      writeFileSync(path, 'background = "#654321"')
      await until(() => colors.background === '#654321')
      writeFileSync(path, 'background = "#abcdef"')
      await until(() => colors.background === '#abcdef')
      writeFileSync(path, 'background = "#12')
      await until(() => manager.getSnapshot().palette.health === 'malformed')
      expect(colors.background).toBe('#abcdef')
      expect(observed).not.toContain(darkColors.background)
    } finally {
      manager.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('retains provenance through canonical failures and replaces whole overlays on recovery', () => {
    const candidates = omarchyThemeCandidates('linux', {}, '/fixture')
    const documents = new Map<string, string>()
    const statePath = candidates[0]!.path
    const legacyPath = candidates[1]!.path
    documents.set(legacyPath, 'background = "#123456"\naccent = "#abcdef"')
    let denied = false
    const manager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => 'dark', omarchyCandidates: candidates }, {
      readFile: path => { if (denied && path === statePath) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return documents.get(path) },
    })
    try {
      expect(manager.getSnapshot().palette.source).toBe('legacy')
      documents.set(statePath, 'background = "#12')
      manager.refreshSystemTheme()
      expect(manager.getSnapshot().palette).toMatchObject({ applied: 'last-good', source: 'state', health: 'malformed', appliedSource: { kind: 'legacy' } })
      expect(colors.background).toBe('#123456')
      denied = true
      manager.refreshSystemTheme()
      expect(manager.getSnapshot().palette.health).toBe('read-error')
      denied = false
      documents.set(statePath, 'background = "#ABCDEF"')
      manager.refreshSystemTheme()
      expect(colors.background).toBe('#abcdef')
      expect(colors.primary).toBe(darkColors.primary)
      const snapshot = manager.getSnapshot()
      documents.set(statePath, 'background = "#abcdef" # same palette')
      manager.refreshSystemTheme()
      expect(manager.getSnapshot()).toBe(snapshot)
      documents.delete(statePath)
      manager.refreshSystemTheme()
      expect(manager.getSnapshot().palette).toMatchObject({ applied: 'last-good', source: 'state', health: 'missing' })
      expect(colors.background).toBe('#abcdef')
      manager.setMode('light')
      expect(colors.background).toBe('#abcdef')
    } finally { manager.dispose() }
  })

  it('coalesces bursts and ignores callbacks from disposed generations', async () => {
    let content = 'background = "#123456"'
    const callbacks: Array<() => void> = []
    const manager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => 'dark', omarchyCandidates: omarchyThemeCandidates('linux', {}, '/fixture'), enableEventSource: true, debounceMs: 1 }, {
      platform: 'linux', readFile: () => content,
      watcher: (_path, callback) => { callbacks.push(callback); return { dispose() {} } },
    })
    manager.start()
    let notifications = 0
    manager.subscribe(() => { notifications++ })
    content = 'background = "#654321"'
    const old = [...callbacks]
    old.forEach(callback => callback())
    await Bun.sleep(10)
    expect(notifications).toBe(1)
    manager.dispose()
    manager.dispose()
    manager.start()
    content = 'background = "#111111"'
    old.forEach(callback => callback())
    await Bun.sleep(10)
    expect(colors.background).toBe('#654321')
    callbacks.at(-1)?.()
    manager.dispose()
    await Bun.sleep(10)
    expect(colors.background).toBe('#654321')
  })
})

describe('omarchyThemeCandidates', () => {
  it('uses canonical state before legacy config and validates XDG roots', () => {
    expect(omarchyThemeCandidates('linux', { XDG_STATE_HOME: '/st', XDG_CONFIG_HOME: '/cf' }, '/home/u').map(c => c.path)).toEqual(['/st/omarchy/current/theme/colors.toml', '/cf/omarchy/current/theme/colors.toml'])
    expect(omarchyThemeCandidates('linux', { XDG_STATE_HOME: 'relative', XDG_CONFIG_HOME: '' }, '/home/u').map(c => c.path)).toEqual(['/home/u/.local/state/omarchy/current/theme/colors.toml', '/home/u/.config/omarchy/current/theme/colors.toml'])
    expect(omarchyThemeCandidates('darwin', {}, '/home/u')).toEqual([])
    expect(omarchyThemeCandidates('win32', {}, '/home/u')).toEqual([])
  })
})
