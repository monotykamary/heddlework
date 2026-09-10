import { describe, expect, it } from 'bun:test'
import { commandFingerprint, CommandReplayCache } from '../src/host/command-replay.ts'

describe('command replay cache', () => {
  it('runs an admission command once and rejects id reuse', async () => {
    const cache = new CommandReplayCache()
    let runs = 0
    const command = { type: 'submit', text: 'hello' } as const
    const first = cache.execute('client', '1', command, async () => { runs += 1; await Bun.sleep(5) })
    const duplicate = cache.execute('client', '1', command, async () => { runs += 1 })
    expect(await first).toEqual({ kind: 'result', id: '1', ok: true })
    expect(await duplicate).toEqual({ kind: 'result', id: '1', ok: true })
    expect(runs).toBe(1)
    expect(await cache.execute('client', '1', { type: 'submit', text: 'different' }, async () => {})).toEqual({ kind: 'result', id: '1', ok: false, error: expect.stringContaining('reused') })
  })

  it('retains only a fixed-size cryptographic command fingerprint', () => {
    const command = { type: 'setEditorText', text: 'x'.repeat(1_000_000) } as const
    const fingerprint = commandFingerprint(command)
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(fingerprint).toBe(commandFingerprint(command))
    expect(fingerprint).not.toContain(command.text.slice(0, 100))
  })

  it('does not collide client and request ids containing delimiters', async () => {
    const cache = new CommandReplayCache()
    let runs = 0
    const command = { type: 'setEditorText', text: 'safe' } as const
    await expect(cache.execute('client:a', '1', command, async () => { runs += 1; return 'first' })).resolves.toEqual({ kind: 'result', id: '1', ok: true, value: 'first' })
    await expect(cache.execute('client', 'a:1', command, async () => { runs += 1; return 'second' })).resolves.toEqual({ kind: 'result', id: 'a:1', ok: true, value: 'second' })
    expect(runs).toBe(2)
  })

  it('bounds incomplete replay entries without dropping their duplicate protection', async () => {
    const cache = new CommandReplayCache(1)
    let finish: (() => void) | undefined
    let runs = 0
    const command = { type: 'setEditorText', text: 'pending' } as const
    const first = cache.execute('client', '1', command, () => new Promise<void>((resolve) => { runs += 1; finish = resolve }))
    const duplicate = cache.execute('client', '1', command, async () => { runs += 1 })
    await expect(cache.execute('client', '2', command, async () => { runs += 1 })).resolves.toEqual({ kind: 'result', id: '2', ok: false, error: expect.stringContaining('full') })
    expect(runs).toBe(1)
    finish?.()
    await expect(first).resolves.toEqual({ kind: 'result', id: '1', ok: true })
    await expect(duplicate).resolves.toEqual({ kind: 'result', id: '1', ok: true })
  })
})
