import type { RenderOptions } from '@gpuix/react'
import { browserProfilesRoot } from './browser/persistence.ts'

export function createWindowOptions(
  platform: NodeJS.Platform,
  debugFrameOverlay: NonNullable<RenderOptions['debugFrameOverlay']>,
  browserRootCachePath = browserProfilesRoot(platform),
  nativeBrowserEnabled = true,
): RenderOptions {
  const common = {
    title: 'Heddlework',
    width: 1240,
    height: 820,
    debugFrameOverlay,
    browserRootCachePath,
    nativeBrowserEnabled,
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
    ...(platform === 'linux' ? { appId: 'io.github.monotykamary.heddlework' } : {}),
    windowBackground: 'opaque',
    ...(platform === 'linux' ? { appId: 'io.github.monotykamary.heddlework', windowDecorations: 'auto' as const } : {}),
  }
}
