import { describe, expect, test } from 'bun:test'
import { createWindowOptions } from '../src/window-options.ts'

describe('createWindowOptions', () => {
  test('uses transparent custom chrome only on macOS', () => {
    expect(createWindowOptions('darwin', 'minimal')).toEqual({
      title: 'Heddlework',
      width: 1240,
      height: 820,
      debugFrameOverlay: 'minimal',
      titlebarTransparent: true,
      windowBackground: 'blurred',
      trafficLightX: 16,
      trafficLightY: 17,
    })
  })

  test('leaves native titlebars available on Linux and Windows', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const options = createWindowOptions(platform, 'hidden')
      expect(options).toEqual({
        title: 'Heddlework',
        width: 1240,
        height: 820,
        debugFrameOverlay: 'hidden',
        windowBackground: 'opaque',
      })
      expect('titlebarTransparent' in options).toBeFalse()
      expect('trafficLightX' in options).toBeFalse()
      expect('trafficLightY' in options).toBeFalse()
    }
  })
})
