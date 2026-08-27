import type { RenderOptions } from '@gpuix/react'

export function createWindowOptions(
  platform: NodeJS.Platform,
  debugFrameOverlay: NonNullable<RenderOptions['debugFrameOverlay']>,
): RenderOptions {
  const common = {
    title: 'Heddlework',
    width: 1240,
    height: 820,
    debugFrameOverlay,
  }

  if (platform === 'darwin') {
    return {
      ...common,
      titlebarTransparent: true,
      windowBackground: 'blurred',
      trafficLightX: 16,
      trafficLightY: 17,
    }
  }

  return {
    ...common,
    windowBackground: 'opaque',
  }
}
