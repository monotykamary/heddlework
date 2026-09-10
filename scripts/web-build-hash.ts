import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Asset names are stable, so the service worker version must include their bytes.
export function webBuildHash(directory: string, assets: readonly string[]): string {
  const hash = createHash('sha256')
  for (const name of assets.filter((name) => name !== 'sw.js' && !name.endsWith('.map')).toSorted()) {
    const bytes = readFileSync(resolve(directory, name))
    hash.update(JSON.stringify([name, bytes.length]))
    hash.update(bytes)
  }
  return hash.digest('hex').slice(0, 16)
}
