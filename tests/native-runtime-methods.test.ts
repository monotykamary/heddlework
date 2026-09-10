import { describe, expect, it } from 'bun:test'
import { assertNativeRuntime, REQUIRED_NATIVE_METHODS } from '../src/native-runtime.ts'

describe('native runtime compatibility', () => {
  it('rejects stock or mismatched runtime packages with repair instructions', () => {
    expect(() => assertNativeRuntime({})).toThrow('bun run setup:native')
    expect(() => assertNativeRuntime({ setTerminalFrame() {} })).toThrow('getWindowState')
    const methods = Object.fromEntries(REQUIRED_NATIVE_METHODS.map((name) => [name, () => {}]))
    expect(() => assertNativeRuntime(methods)).not.toThrow()
  })
})
