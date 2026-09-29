import { describe, expect, it } from 'bun:test'
import { terminalSurface } from '../src/ui/terminal-view.tsx'

const base = { projectionSuspended: false, nativeTerminal: true, directTerminal: true, sessionReady: true, hasSnapshot: true }

describe('terminalSurface', () => {
  it('mounts the native grid for a direct-frame session before its first frame arrives (remote hosts)', () => {
    expect(terminalSurface({ ...base, hasSnapshot: false })).toBe('native')
  })
  it('keeps the empty state while a direct-frame session does not exist yet', () => {
    expect(terminalSurface({ ...base, hasSnapshot: false, sessionReady: false })).toBe('empty')
  })
  it('keeps the existing native, DOM, and suspended paths', () => {
    expect(terminalSurface(base)).toBe('native')
    expect(terminalSurface({ ...base, directTerminal: false })).toBe('native')
    expect(terminalSurface({ ...base, directTerminal: false, hasSnapshot: false })).toBe('empty')
    expect(terminalSurface({ ...base, nativeTerminal: false, directTerminal: false })).toBe('grid')
    expect(terminalSurface({ ...base, nativeTerminal: false, directTerminal: false, hasSnapshot: false })).toBe('empty')
    expect(terminalSurface({ ...base, projectionSuspended: true })).toBe('none')
  })
})
