import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function generateHostToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

export function hostTokenPath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'host-token')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'host-token')
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'heddlework', 'host-token')
}

// Reads the persisted token or writes a fresh one with owner-only permissions. A false path keeps the token in memory.
export function loadOrCreateHostToken(path: string | false): string {
  if (!path) return generateHostToken()
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {
    // Fall through to creation.
  }
  const token = generateHostToken()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // The host still runs with an in-memory token when the state directory is unavailable.
  }
  return token
}

export function timingSafeEqualToken(expected: string, candidate: string | null | undefined): boolean {
  if (!candidate || candidate.length !== expected.length) return false
  let mismatch = 0
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ candidate.charCodeAt(index)
  return mismatch === 0
}
