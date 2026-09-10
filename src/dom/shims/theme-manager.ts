import { applyResolvedTheme, type ResolvedTheme } from '../../ui/theme.ts'
export type ThemeMode = 'system' | ResolvedTheme
export interface ThemeSnapshot { mode: ThemeMode; resolved: ResolvedTheme }
function systemTheme(): ResolvedTheme { return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark' }
export class ThemeManager {
  readonly #listeners = new Set<() => void>()
  #snapshot: ThemeSnapshot
  #media: MediaQueryList | undefined
  constructor() { const mode = readMode(); this.#snapshot = { mode, resolved: mode === 'system' ? systemTheme() : mode }; applyResolvedTheme(this.#snapshot.resolved) }
  readonly subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  readonly getSnapshot = (): ThemeSnapshot => this.#snapshot
  setMode(mode: ThemeMode): void { const resolved = mode === 'system' ? systemTheme() : mode; if (mode === this.#snapshot.mode && resolved === this.#snapshot.resolved) return; this.#snapshot = { mode, resolved }; applyResolvedTheme(resolved); try { localStorage.setItem('heddlework.theme', mode) } catch {}; this.#emit() }
  start(): void { if (this.#media || typeof matchMedia !== 'function') return; this.#media = matchMedia('(prefers-color-scheme: light)'); this.#media.addEventListener('change', this.refreshSystemTheme) }
  refreshSystemTheme = (): void => { if (this.#snapshot.mode !== 'system') return; const resolved = systemTheme(); if (resolved === this.#snapshot.resolved) return; this.#snapshot = { mode: 'system', resolved }; applyResolvedTheme(resolved); this.#emit() }
  dispose(): void { this.#media?.removeEventListener('change', this.refreshSystemTheme); this.#media = undefined; this.#listeners.clear() }
  #emit(): void { for (const listener of this.#listeners) listener() }
}
function readMode(): ThemeMode { try { const value = localStorage.getItem('heddlework.theme'); return value === 'light' || value === 'dark' || value === 'system' ? value : 'system' } catch { return 'system' } }
export function detectSystemTheme(): ResolvedTheme { return systemTheme() }
export function themePreferencePath(): string { return '' }
export const defaultThemeManager = new ThemeManager()
