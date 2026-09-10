// Adapted from 0xCUB3/heddlework: browser clients never reserve native traffic-light space.
export function hasNativeTrafficLights(
  platform: string | undefined = typeof process === 'undefined' ? undefined : process.platform,
  browser = typeof document !== 'undefined',
): boolean {
  return platform === 'darwin' && !browser
}
