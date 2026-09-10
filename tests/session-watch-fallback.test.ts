import { expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchPiSessions } from '../src/pi/session-watch.ts'

it('refreshes existing roots at the retry cadence when native watching is unsupported', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'heddlework-watch-fallback-'))
  let attempts = 0
  let changes = 0
  const close = watchPiSessions(directory, () => { changes += 1 }, {
    debounceMs: 1,
    retryMs: 25,
    watch: () => { attempts += 1; throw new Error('Native watch unsupported') },
  })
  try {
    const deadline = Date.now() + 2_000
    while (changes < 3 && Date.now() < deadline) await Bun.sleep(5)
    expect(attempts).toBeGreaterThanOrEqual(3)
    expect(changes).toBeGreaterThanOrEqual(3)
    close()
    const stoppedAt = changes
    await Bun.sleep(60)
    expect(changes).toBe(stoppedAt)
  } finally {
    close()
    await rm(directory, { recursive: true, force: true })
  }
})
