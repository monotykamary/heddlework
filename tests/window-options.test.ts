import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createWindowOptions } from '../src/window-options.ts'

describe('createWindowOptions', () => {
  test('matches the Linux desktop entry identity without changing macOS or Windows', () => {
    const appId = 'io.github.monotykamary.heddlework'
    const desktop = readFileSync(new URL(`../packaging/linux/${appId}.desktop`, import.meta.url), 'utf8')
    expect(createWindowOptions('linux', 'hidden', '/profiles')).toMatchObject({ appId })
    expect(desktop).toContain(`Icon=${appId}\n`)
    expect(desktop).toContain(`StartupWMClass=${appId}\n`)
    for (const platform of ['darwin', 'win32'] as const) {
      expect(createWindowOptions(platform, 'hidden', '/profiles')).not.toHaveProperty('appId')
    }
  })

  test('uses transparent custom chrome only on macOS', () => {
    expect(createWindowOptions('darwin', 'minimal', '/profiles')).toEqual({
      title: 'Heddlework',
      width: 1240,
      height: 820,
      debugFrameOverlay: 'minimal',
      browserRootCachePath: '/profiles',
      nativeBrowserEnabled: true,
      titlebarTransparent: true,
      windowBackground: 'blurred',
      trafficLightX: 16,
      trafficLightY: 17,
    })
  })

  test('can disable native browser initialization before the renderer starts', () => {
    expect(createWindowOptions('darwin', 'hidden', '/profiles', false)).toMatchObject({
      browserRootCachePath: '/profiles',
      nativeBrowserEnabled: false,
    })
  })

  test('leaves native titlebars available on Linux and Windows', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const options = createWindowOptions(platform, 'hidden', '/profiles')
      expect(options).toEqual({
        ...(platform === 'linux' ? { appId: 'io.github.monotykamary.heddlework' } : {}),
        title: 'Heddlework',
        width: 1240,
        height: 820,
        debugFrameOverlay: 'hidden',
        browserRootCachePath: '/profiles',
        nativeBrowserEnabled: true,
        windowBackground: 'opaque',
      })
      expect('titlebarTransparent' in options).toBeFalse()
      expect('trafficLightX' in options).toBeFalse()
      expect('trafficLightY' in options).toBeFalse()
    }
  })
})
