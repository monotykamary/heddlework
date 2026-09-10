export const MAX_WS_FRAME_BYTES = 256 * 1024
export const MAX_ASSEMBLED_BYTES = 32 * 1024 * 1024
export const MAX_FRAME_COUNT = 256
export const MAX_PENDING_ASSEMBLIES = 4
export const MAX_PENDING_BYTES = 40 * 1024 * 1024
export const FRAME_ASSEMBLY_TIMEOUT_MS = 15_000
const FRAME_OVERHEAD_BUDGET = 256

export interface WireFrame { kind: 'frame'; id: string; index: number; count: number; data: string }
export function utf8ByteLength(text: string): number { return new TextEncoder().encode(text).length }
export function splitUtf8(text: string, maxBytes: number): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Frame payload budget must be positive')
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return [text]
  const decoder = new TextDecoder()
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + maxBytes, bytes.length)
    while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1
    if (end === offset) throw new Error('Frame payload budget cannot fit one UTF-8 code point')
    chunks.push(decoder.decode(bytes.subarray(offset, end)))
    offset = end
  }
  return chunks
}
export function isWireFrame(value: unknown): value is WireFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<WireFrame>
  return frame.kind === 'frame' && typeof frame.id === 'string' && frame.id.length > 0 && frame.id.length <= 128 && Number.isSafeInteger(frame.index) && Number.isSafeInteger(frame.count) && typeof frame.data === 'string'
}
export function encodeFrames(json: string, maxFrameBytes = MAX_WS_FRAME_BYTES): string[] {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new Error('WebSocket frame budget must be a positive integer')
  const total = utf8ByteLength(json)
  if (total > MAX_ASSEMBLED_BYTES) throw new Error(`Workspace message exceeds ${MAX_ASSEMBLED_BYTES} byte assembly limit`)
  if (total <= maxFrameBytes) return [json]
  if (maxFrameBytes <= FRAME_OVERHEAD_BUDGET + 4) throw new Error('WebSocket frame budget is too small for an envelope')
  const id = crypto.randomUUID()
  let budget = maxFrameBytes - FRAME_OVERHEAD_BUDGET
  for (let attempt = 0; attempt < 16 && budget > 0; attempt += 1) {
    const parts = splitUtf8(json, budget)
    if (parts.length > MAX_FRAME_COUNT) throw new Error(`Workspace message needs too many frames (${parts.length})`)
    const frames = parts.map((data, index) => JSON.stringify({ kind: 'frame', id, index, count: parts.length, data } satisfies WireFrame))
    const overflow = Math.max(...frames.map((frame) => utf8ByteLength(frame))) - maxFrameBytes
    if (overflow <= 0) return frames
    budget -= Math.max(32, overflow + 8)
  }
  throw new Error('WebSocket frame budget cannot fit a valid envelope')
}

interface Pending { count: number; parts: Array<string | undefined>; received: number; bytes: number; startedAt: number }
export class FrameAssembler {
  #pending = new Map<string, Pending>()
  #pendingBytes = 0
  reset(): void { this.#pending.clear(); this.#pendingBytes = 0 }
  get pendingAssemblyCount(): number { return this.#pending.size }
  get pendingBytes(): number { return this.#pendingBytes }
  push(raw: string, limits: { maxAssembledBytes?: number; maxFrameCount?: number; maxPendingAssemblies?: number; maxPendingBytes?: number; timeoutMs?: number; now?: number } = {}): string | undefined {
    const now = limits.now ?? Date.now()
    const assembledLimit = limits.maxAssembledBytes ?? MAX_ASSEMBLED_BYTES
    if (utf8ByteLength(raw) > assembledLimit) throw new Error('Workspace message exceeds assembly limits')
    const timeout = limits.timeoutMs ?? FRAME_ASSEMBLY_TIMEOUT_MS
    this.#expire(now, timeout)
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { if (this.#pending.size) throw new Error('Workspace stream was interrupted'); return raw }
    if (!isWireFrame(parsed)) { if (this.#pending.size) throw new Error('Workspace stream was interrupted'); return raw }
    const maxCount = limits.maxFrameCount ?? MAX_FRAME_COUNT
    if (parsed.count < 1 || parsed.count > maxCount || parsed.index! < 0 || parsed.index! >= parsed.count) throw new Error(`Invalid workspace frame ${parsed.index}/${parsed.count}`)
    let entry = this.#pending.get(parsed.id)
    if (!entry) {
      if (this.#pending.size >= (limits.maxPendingAssemblies ?? MAX_PENDING_ASSEMBLIES)) throw new Error('Too many pending workspace messages')
      entry = { count: parsed.count, parts: new Array<string | undefined>(parsed.count), received: 0, bytes: 0, startedAt: now }
      this.#pending.set(parsed.id, entry)
    } else if (entry.count !== parsed.count) throw new Error('Workspace frame count changed mid-stream')
    if (entry.parts[parsed.index!] !== undefined) throw new Error(`Duplicate workspace frame ${parsed.index}`)
    const added = utf8ByteLength(parsed.data)
    const aggregateLimit = limits.maxPendingBytes ?? MAX_PENDING_BYTES
    if (entry.bytes + added > assembledLimit || this.#pendingBytes + added > aggregateLimit) { this.#drop(parsed.id); throw new Error('Workspace message exceeds assembly limits') }
    entry.parts[parsed.index!] = parsed.data
    entry.received += 1; entry.bytes += added; this.#pendingBytes += added
    if (entry.received < entry.count) return undefined
    const result = entry.parts.join('')
    this.#drop(parsed.id)
    return result
  }
  #drop(id: string): void { const entry = this.#pending.get(id); if (entry) this.#pendingBytes -= entry.bytes; this.#pending.delete(id) }
  #expire(now: number, timeout: number): void { for (const [id, entry] of this.#pending) if (now - entry.startedAt > timeout) this.#drop(id) }
}
