import { describe, expect, it } from 'bun:test'
import { nativeBuildCommand, parseGpuixSourcePin } from '../scripts/gpuix-source.ts'

describe('pinned GPUix source provisioning', () => {
  const pin = { gpuixRepository: 'https://github.com/monotykamary/gpuix.git', zedRepository: 'https://github.com/monotykamary/zed.git', gpuixRevision: 'a'.repeat(40), zedRevision: 'b'.repeat(40) }
  it('requires immutable HTTPS source identities', () => {
    expect(parseGpuixSourcePin(pin)).toEqual(pin)
    for (const gpuixRevision of ['main', 'abc123', '--upload-pack=evil']) expect(() => parseGpuixSourcePin({ ...pin, gpuixRevision })).toThrow()
    expect(() => parseGpuixSourcePin({ ...pin, zedRepository: 'file:///tmp/repo' })).toThrow()
  })
  it('builds CEF on macOS unless explicitly disabled, and uses the Linux native profile', () => {
    expect(nativeBuildCommand('darwin', false)).toEqual(['bun', 'run', 'build:browser'])
    expect(nativeBuildCommand('darwin', true)).toEqual(['bun', 'run', 'build'])
    expect(nativeBuildCommand('linux', false)).toEqual(['bun', 'run', 'build:release'])
    expect(nativeBuildCommand('win32', false)).toEqual(['bun', 'run', 'build'])
  })
})
