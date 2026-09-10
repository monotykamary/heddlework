import { describe, expect, it } from 'bun:test'
import { hasNativeTrafficLights } from '../src/ui/window-chrome.ts'

describe('window chrome environment', () => {
  it('reserves traffic-light space only in native macOS windows', () => {
    expect(hasNativeTrafficLights('darwin', false)).toBe(true)
    for (const platform of ['darwin', 'linux', 'win32', undefined]) {
      expect(hasNativeTrafficLights(platform, true)).toBe(false)
    }
    expect(hasNativeTrafficLights('linux', false)).toBe(false)
    expect(hasNativeTrafficLights('win32', false)).toBe(false)
  })
})
