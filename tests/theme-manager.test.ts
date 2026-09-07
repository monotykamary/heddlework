import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThemeManager, detectSystemTheme, themePreferencePath } from '../src/ui/theme-manager.ts'
import { applyResolvedTheme, colors, darkColors, lightColors, nativeTheme } from '../src/ui/theme.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  applyResolvedTheme('dark')
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ThemeManager', () => {
  it('applies and persists explicit theme modes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'heddlework-theme-'))
    temporaryDirectories.push(directory)
    const preferencePath = join(directory, 'preferences.json')
    const manager = new ThemeManager({ preferencePath, resolveSystemTheme: () => 'dark' })

    manager.setMode('light')

    expect(manager.getSnapshot()).toMatchObject({ mode: 'light', resolved: 'light' })
    expect(colors.background).toBe(lightColors.background)
    expect(nativeTheme.appearance).toBe('light')
    expect(JSON.parse(readFileSync(preferencePath, 'utf8'))).toEqual({ themeMode: 'light' })

    const restored = new ThemeManager({ preferencePath, resolveSystemTheme: () => 'dark' })
    expect(restored.getSnapshot()).toMatchObject({ mode: 'light', resolved: 'light' })
    manager.dispose()
    restored.dispose()
  })

  it('tracks system appearance changes only in system mode', () => {
    let systemTheme: 'light' | 'dark' = 'dark'
    const manager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => systemTheme })
    let notifications = 0
    manager.subscribe(() => { notifications += 1 })

    systemTheme = 'light'
    manager.refreshSystemTheme()
    expect(manager.getSnapshot()).toMatchObject({ mode: 'system', resolved: 'light' })
    expect(colors.background).toBe(lightColors.background)
    expect(notifications).toBe(1)

    manager.setMode('dark')
    systemTheme = 'light'
    manager.refreshSystemTheme()
    expect(manager.getSnapshot()).toMatchObject({ mode: 'dark', resolved: 'dark' })
    expect(colors.background).toBe(darkColors.background)
    manager.dispose()
  })
})

describe('system theme detection', () => {
  it('reads macOS, Windows, and Linux appearance values', () => {
    expect(detectSystemTheme('darwin', () => 'Dark')).toBe('dark')
    expect(detectSystemTheme('darwin', () => undefined)).toBe('light')
    expect(detectSystemTheme('win32', () => '0')).toBe('dark')
    expect(detectSystemTheme('win32', () => '1')).toBe('light')
    expect(detectSystemTheme('linux', (_command, args) => args.at(-1) === 'color-scheme' ? "'prefer-dark'" : undefined)).toBe('dark')
  })

  it('uses platform-appropriate preference locations', () => {
    expect(themePreferencePath('darwin', {}, '/home/test')).toBe('/home/test/Library/Application Support/Heddlework/preferences.json')
    expect(themePreferencePath('linux', { XDG_CONFIG_HOME: '/config' }, '/home/test')).toBe('/config/heddlework/preferences.json')
    expect(themePreferencePath('win32', { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'C:\\Users\\test')).toContain('Heddlework')
  })
})
