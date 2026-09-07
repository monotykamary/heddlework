import { describe, expect, it } from 'bun:test'
import { dispatchTerminalKey, encodeTerminalKey, resolveTerminalCommand, wrapBracketedPaste, type TerminalKeyEffects, type TerminalKeyEvent } from '../src/terminal/keys.ts'

const ESC = String.fromCharCode(27)

describe('encodeTerminalKey', () => {
  it('encodes printable, control, navigation, and editing keys', () => {
    expect(encodeTerminalKey({ key: 'a', keyChar: 'a' })).toBe('a')
    expect(encodeTerminalKey({ key: 'enter' })).toBe('\r')
    expect(encodeTerminalKey({ key: 'c', modifiers: { ctrl: true } })).toBe(String.fromCharCode(3))
    expect(encodeTerminalKey({ key: 'up' })).toBe(ESC + '[A')
    expect(encodeTerminalKey({ key: 'up' }, true)).toBe(ESC + 'OA')
    expect(encodeTerminalKey({ key: 'backspace' })).toBe(String.fromCharCode(0x7f))
    expect(encodeTerminalKey({ key: 'arrowdown' })).toBe(ESC + '[B')
    expect(encodeTerminalKey({ key: 'ctrl-c' })).toBe(String.fromCharCode(3))
    expect(encodeTerminalKey({ keyChar: String.fromCharCode(3) })).toBe(String.fromCharCode(3))
    expect(encodeTerminalKey({ keyChar: String.fromCharCode(8) })).toBe(String.fromCharCode(0x7f))
  })

  it('lets the view handle copy and paste shortcuts', () => {
    expect(encodeTerminalKey({ key: 'c', modifiers: { cmd: true } })).toBeUndefined()
    expect(encodeTerminalKey({ key: 'v', modifiers: { cmd: true } })).toBeUndefined()
  })

  it('wraps bracketed paste when the emulator enabled it', () => {
    expect(wrapBracketedPaste('hi', false)).toBe('hi')
    expect(wrapBracketedPaste('hi', true)).toBe(ESC + '[200~hi' + ESC + '[201~')
  })
})

describe('resolveTerminalCommand', () => {
  // WP-01 catch-first: Ctrl+Shift+C must never dispatch through the interrupt
  // (ETX) path. The old view ordered an unqualified ctrl 'c' interrupt before the
  // copy branch, so Ctrl+Shift+C reached interrupt handling first.
  it('Linux Ctrl+Shift+C is a copy, not an interrupt', () => {
    expect(resolveTerminalCommand({ key: 'c', modifiers: { ctrl: true, shift: true } }, 'linux')).toBe('copy')
  })

  it('Linux plain Ctrl+C stays exactly one interrupt', () => {
    expect(resolveTerminalCommand({ key: 'c', modifiers: { ctrl: true } }, 'linux')).toBe('interrupt')
  })

  it('Linux Ctrl+Shift+C with encoding-shy form key string is a copy', () => {
    expect(resolveTerminalCommand({ key: 'ctrl-shift-c' }, 'linux')).toBe('copy')
  })

  it('macOS Command+C is a copy', () => {
    expect(resolveTerminalCommand({ key: 'c', modifiers: { cmd: true } }, 'darwin')).toBe('copy')
  })

  it('macOS plain Ctrl+C stays an interrupt', () => {
    expect(resolveTerminalCommand({ key: 'c', modifiers: { ctrl: true } }, 'darwin')).toBe('interrupt')
  })

  it('paste is preserved for Cmd+V and Ctrl+V', () => {
    expect(resolveTerminalCommand({ key: 'v', modifiers: { cmd: true } }, 'darwin')).toBe('paste')
    expect(resolveTerminalCommand({ key: 'v', modifiers: { ctrl: true } }, 'linux')).toBe('paste')
  })

  it('plain lowercase c is not a terminal command', () => {
    expect(resolveTerminalCommand({ key: 'c' }, 'linux')).toBe('none')
    expect(resolveTerminalCommand({ key: 'x' }, 'linux')).toBe('none')
  })
})

describe('dispatchTerminalKey (shared production seam) - always run', () => {
  // Exercises the SAME function TerminalView.onKeyDown calls, with injected
  // clipboard/PTY sinks, so acceptance is not hostage to a native GPUI renderer.
  function run(event: TerminalKeyEvent) {
    const writes: string[] = []
    const copies: string[] = []
    const effects: TerminalKeyEffects = {
      platform: 'linux',
      grid: {
        viewport: [{ text: 'alpha' }, { text: 'beta' }],
        bracketedPaste: false,
        applicationCursor: false,
      },
      write: (data: string) => writes.push(data),
      copy: (text: string) => { copies.push(text); const p = Promise.reject(new Error('clipboard unavailable')); p.catch(() => {}); return p },
      readPaste: () => Promise.resolve('pasted'),
    }
    dispatchTerminalKey(event, effects)
    return { writes, copies }
  }

  it('Ctrl+Shift+C copies and writes zero PTY bytes, even when clipboard fails', async () => {
    const { writes, copies } = run({ key: 'c', modifiers: { ctrl: true, shift: true } })
    await Bun.sleep(1)
    expect(copies).toEqual(['alpha\nbeta'])
    expect(writes).toEqual([])
  })

  it('plain Ctrl+C writes exactly one ETX and never copies', () => {
    const { writes, copies } = run({ key: 'c', modifiers: { ctrl: true } })
    expect(writes).toEqual([String.fromCharCode(3)])
    expect(copies).toEqual([])
  })

  it('ordinary keys fall through to encoding unchanged', () => {
    const { writes } = run({ key: 'x' })
    expect(writes).toEqual(['x'])
  })

  it('paste via Ctrl+V writes wrapped bracketed text when enabled', async () => {
    const writes: string[] = []
    const effects: TerminalKeyEffects = {
      platform: 'linux',
      grid: { viewport: [{ text: 'a' }], bracketedPaste: true, applicationCursor: false },
      write: (data: string) => writes.push(data),
      copy: () => {},
      readPaste: () => Promise.resolve('hi'),
    }
    dispatchTerminalKey({ key: 'v', modifiers: { ctrl: true } }, effects)
    await Bun.sleep(1)
    expect(writes).toEqual([ESC + '[200~hi' + ESC + '[201~'])
  })
})
