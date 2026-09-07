import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ColorPalette } from './theme.ts'

export interface OmarchyThemeCandidate {
  kind: 'state' | 'legacy'
  path: string
  watchRoot: string
}

export interface ThemePaletteStatus {
  applied: 'builtin' | 'current' | 'last-good'
  source: 'none' | OmarchyThemeCandidate['kind']
  path?: string
  health: 'ok' | 'missing' | 'malformed' | 'read-error'
  appliedSource?: OmarchyThemeCandidate | undefined
}

export interface OmarchySourceState {
  overlay?: Partial<ColorPalette> | undefined
  canonicalActive: boolean
  status: ThemePaletteStatus
}

export function omarchyThemeCandidates(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): OmarchyThemeCandidate[] {
  if (platform !== 'linux') return []
  const base = (value: string | undefined, fallback: string) => value && isAbsolute(value) ? value : join(home, fallback)
  return [
    { kind: 'state' as const, root: base(environment.XDG_STATE_HOME, '.local/state') },
    { kind: 'legacy' as const, root: base(environment.XDG_CONFIG_HOME, '.config') },
  ].map(({ kind, root }) => ({ kind, watchRoot: join(root, 'omarchy/current'), path: join(root, 'omarchy/current/theme/colors.toml') }))
}

const mappings: Record<string, readonly (keyof ColorPalette)[]> = {
  background: ['background', 'window', 'panel'], foreground: ['text'], accent: ['primary', 'info'],
  muted: ['textMuted', 'textFaint'], border: ['borderStrong'], sidebar: ['sidebar'], selection: ['code', 'message', 'composer'],
}
const aliases: Record<string, string> = { bg: 'background', fg: 'foreground', panel: 'sidebar' }

// A deliberately small data-only grammar, including legacy bare hex values.
export function parseOmarchyPalette(document: string): Partial<ColorPalette> | undefined {
  const overlay: Partial<ColorPalette> = {}
  const seen = new Set<string>()
  for (const raw of document.split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) break // Remaining assignments belong to tables, not the root.
    const keyMatch = /^([\w-]+)/u.exec(line)
    const rawKey = keyMatch?.[1]?.toLowerCase().replaceAll('-', '_')
    if (!rawKey) continue
    const key = Object.hasOwn(aliases, rawKey) ? aliases[rawKey]! : rawKey
    if (!Object.hasOwn(mappings, key)) continue
    if (seen.has(rawKey)) return undefined
    seen.add(rawKey)
    const match = /^[\w-]+\s*=\s*(?:"(#[\da-fA-F]{6}(?:[\da-fA-F]{2})?)"|'(#[\da-fA-F]{6}(?:[\da-fA-F]{2})?)'|(#[\da-fA-F]{6}(?:[\da-fA-F]{2})?))\s*(?:#.*)?$/u.exec(line)
    const value = match && (match[1] ?? match[2] ?? match[3])
    if (!value) return undefined
    for (const target of mappings[key]!) overlay[target] = value.toLowerCase()
  }
  return seen.size ? overlay : undefined
}

export function readOmarchyPalette(candidates: readonly OmarchyThemeCandidate[], previous?: OmarchySourceState, read: (path: string) => string | undefined = path => readFileSync(path, 'utf8')): OmarchySourceState {
  if (!candidates.length) return { canonicalActive: false, status: { applied: 'builtin', source: 'none', health: 'ok' } }
  let attempted = candidates[0]!
  let health: ThemePaletteStatus['health'] = 'missing'
  for (const candidate of candidates) {
    attempted = candidate
    let content: string | undefined
    try {
      content = read(candidate.path)
      health = content === undefined ? 'missing' : 'malformed'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      health = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'read-error'
    }
    const overlay = content === undefined ? undefined : parseOmarchyPalette(content)
    if (overlay) return {
      overlay, canonicalActive: candidate.kind === 'state' || previous?.canonicalActive === true,
      status: { applied: 'current', source: candidate.kind, path: candidate.path, health: 'ok', appliedSource: candidate },
    }
    if (health !== 'missing' || previous?.canonicalActive) break
  }
  return {
    overlay: previous?.overlay, canonicalActive: previous?.canonicalActive ?? false,
    status: { applied: previous?.overlay ? 'last-good' : 'builtin', source: attempted.kind, path: attempted.path, health, appliedSource: previous?.status.appliedSource },
  }
}
