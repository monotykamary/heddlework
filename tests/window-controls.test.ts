import { describe, expect, it } from 'bun:test'
import { readWindowState, sameWindowState, usesClientWindowChrome, windowControlActions, type NativeWindowState } from '../src/ui/window-controls.ts'

const state: NativeWindowState = { decorations: 'client', maximized: false, fullscreen: false, resizable: true, canMinimize: true, canMaximize: true }

describe('native window controls', () => {
  it('tolerates native startup and shutdown state reads', () => {
    expect(readWindowState({ getWindowState() { throw new Error('window closing') } })).toBeUndefined()
    expect(readWindowState({ getWindowState: () => state })).toBe(state)
  })
  it('uses compositor decoration state rather than assuming Linux has no buttons', () => {
    expect(usesClientWindowChrome('linux', false, state)).toBe(true)
    expect(usesClientWindowChrome('linux', false, { ...state, decorations: 'server' })).toBe(false)
    expect(usesClientWindowChrome('linux', true, state)).toBe(false)
    expect(usesClientWindowChrome('darwin', false, state)).toBe(false)
    expect(usesClientWindowChrome('linux', false, undefined)).toBe(false)
  })
  it('preserves equal snapshot identity and notices compositor state changes', () => {
    expect(sameWindowState(state, { ...state })).toBe(true)
    expect(sameWindowState(state, { ...state, maximized: true })).toBe(false)
    expect(sameWindowState(state, undefined)).toBe(false)
  })
  it('delegates to native operations and prefers graceful application shutdown', () => {
    const calls: string[] = []
    const renderer = { minimizeWindow: () => calls.push('minimize'), toggleMaximizeWindow: () => calls.push('maximize'), closeWindow: () => calls.push('native-close') }
    const actions = windowControlActions(renderer, state, () => calls.push('shutdown'))
    actions.minimize?.(); actions.maximize?.(); actions.close?.()
    expect(calls).toEqual(['minimize', 'maximize', 'shutdown'])
    windowControlActions(renderer, state).close?.()
    expect(calls.at(-1)).toBe('native-close')
    expect(windowControlActions(renderer, { ...state, resizable: false }).maximize).toBeUndefined()
    expect(windowControlActions(renderer, { ...state, fullscreen: true }).minimize).toBeUndefined()
    expect(windowControlActions(renderer, { ...state, fullscreen: true, resizable: false, canMaximize: false }).maximize).toBeDefined()
    expect(windowControlActions({}, state).maximize).toBeUndefined()
  })
})
