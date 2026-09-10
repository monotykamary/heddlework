import { createHash } from 'node:crypto'
import type { ServerMessage, WorkbenchCommand } from '../protocol/index.ts'

interface Entry { fingerprint: string; result: Promise<Extract<ServerMessage, { kind: 'result' }>>; complete: boolean }

export class CommandReplayCache {
  readonly #entries = new Map<string, Entry>()
  readonly maxEntries: number
  constructor(maxEntries = 500) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Replay cache limit must be a positive integer')
    this.maxEntries = maxEntries
  }

  execute(clientId: string, requestId: string, command: WorkbenchCommand, run: () => Promise<unknown>): Promise<Extract<ServerMessage, { kind: 'result' }>> {
    const key = JSON.stringify([clientId, requestId])
    const fingerprint = commandFingerprint(command)
    const existing = this.#entries.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.resolve({ kind: 'result', id: requestId, ok: false, error: 'Request id was reused for a different command' })
      return existing.result
    }
    this.#trim(this.maxEntries - 1)
    if (this.#entries.size >= this.maxEntries) return Promise.resolve({ kind: 'result', id: requestId, ok: false, error: 'Command replay cache is full' })
    const entry: Entry = { fingerprint, complete: false, result: Promise.resolve({ kind: 'result', id: requestId, ok: false, error: 'Command did not run' }) }
    entry.result = run().then(
      (value) => value === undefined ? { kind: 'result', id: requestId, ok: true } : { kind: 'result', id: requestId, ok: true, value },
      (error: unknown) => ({ kind: 'result', id: requestId, ok: false, error: error instanceof Error ? error.message : String(error) }),
    ).then((result) => { entry.complete = true; this.#trim(); return result as Extract<ServerMessage, { kind: 'result' }> })
    this.#entries.set(key, entry)
    this.#trim()
    return entry.result
  }

  #trim(limit = this.maxEntries): void {
    if (this.#entries.size <= limit) return
    for (const [key, entry] of this.#entries) {
      if (!entry.complete) continue
      this.#entries.delete(key)
      if (this.#entries.size <= limit) break
    }
  }
}

export function commandFingerprint(command: WorkbenchCommand): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex')
}
