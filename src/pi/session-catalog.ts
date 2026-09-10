import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { basename, dirname, join, resolve } from 'node:path'
import { asRecord, contentText } from '../workbench/state.ts'
import { watchPiSessions } from './session-watch.ts'

export interface PiSessionSummary {
  id: string
  path: string
  cwd: string
  title: string
  name?: string | undefined
  firstMessage: string
  messageCount: number
  createdAt: number
  modifiedAt: number
  parentSession?: string | undefined
  lastAssistantText?: string | undefined
  lastAssistantStopReason?: string | undefined
}

export interface SessionCatalogDiagnostics {
  scanStarted?(scope: string): void
}

export interface SessionCatalogOptions {
  agentDir?: string
  limit?: number
  scope?: 'all' | 'cwd'
  concurrency?: number
  cachePath?: string | false
  diagnostics?: SessionCatalogDiagnostics
}

interface SessionFileMeta {
  path: string
  mtimeMs: number
  birthtimeMs: number
  size: number
}

interface SessionCacheEntry {
  mtimeMs: number
  size: number
  summary: PiSessionSummary
}

interface HeaderAccumulator {
  id: string
  cwd: string
  name?: string | undefined
  firstMessage: string
  foundFirstUser: boolean
  messageCount: number
  createdAt: number
  lastResponseAt: number
  parentSession?: string | undefined
  lastAssistantText?: string | undefined
  lastAssistantStopReason?: string | undefined
}

const READ_CHUNK_BYTES = 16 * 1024
const SESSION_TAIL_BYTES = 128 * 1024
const FULL_SCAN_BYTES = 128 * 1024
const DEFAULT_CONCURRENCY = 24
const SESSION_META_CONCURRENCY = 64

export class PiSessionCatalog {
  readonly #options: SessionCatalogOptions
  readonly #caches = new Map<string, Map<string, SessionCacheEntry>>()
  readonly #scans = new Map<string, Promise<PiSessionSummary[]>>()
  readonly #watches = new Map<string, { listeners: Set<() => void>; close: () => void }>()
  #persistQueue: Promise<void> = Promise.resolve()
  #persisted: PiSessionSummary[]

  constructor(options: SessionCatalogOptions = {}) {
    this.#options = options
    this.#persisted = readPersistedSessions(options.cachePath)
  }

  cached(cwd: string, limit = this.#options.limit): PiSessionSummary[] {
    const sessions = (this.#options.scope ?? 'all') === 'cwd'
      ? this.#persisted.filter((session) => resolve(session.cwd) === resolve(cwd))
      : this.#persisted
    return limit === undefined ? sessions : sessions.slice(0, Math.max(0, limit))
  }

  async list(cwd: string, limit = this.#options.limit): Promise<PiSessionSummary[]> {
    const scoped = (this.#options.scope ?? 'all') === 'cwd'
    const key = scoped ? resolve(cwd) : '*'
    let scan = this.#scans.get(key)
    if (!scan) {
      let cache = this.#caches.get(key)
      if (!cache) {
        cache = new Map()
        this.#caches.set(key, cache)
      }
      const { limit: _limit, diagnostics: _diagnostics, ...options } = this.#options
      this.#options.diagnostics?.scanStarted?.(key)
      scan = listPiSessionsCached(cwd, options, cache).then(async (sessions) => {
        const previousByPath = new Map(this.#persisted.map((session) => [session.path, session]))
        const stableScope = sessions.map((session) => {
          const previous = previousByPath.get(session.path)
          return previous && sameSummary(previous, session) ? previous : session
        })
        const scannedPaths = new Set(stableScope.map((session) => session.path))
        const nextPersisted = scoped
          ? [
              ...this.#persisted.filter((session) => (
                resolve(session.cwd) !== key && !scannedPaths.has(session.path)
              )),
              ...stableScope,
            ].sort((left, right) => right.modifiedAt - left.modifiedAt)
          : stableScope
        const changed = !sameSummaryList(this.#persisted, nextPersisted)
        if (changed) {
          this.#persisted = nextPersisted
          const snapshot = nextPersisted
          this.#persistQueue = this.#persistQueue.then(() => persistSessions(this.#options.cachePath, snapshot))
          await this.#persistQueue
        }
        return stableScope
      }).finally(() => {
        if (this.#scans.get(key) === scan) this.#scans.delete(key)
      })
      this.#scans.set(key, scan)
    }
    const sessions = await scan
    return limit === undefined ? sessions : sessions.slice(0, Math.max(0, limit))
  }

  subscribe(cwd: string, listener: () => void): () => void {
    const scoped = (this.#options.scope ?? 'all') === 'cwd'
    const root = scoped
      ? getPiSessionDirectory(cwd, this.#options.agentDir)
      : getPiSessionRoot(this.#options.agentDir)
    let entry = this.#watches.get(root)
    if (!entry) {
      const listeners = new Set<() => void>()
      entry = {
        listeners,
        close: watchPiSessions(root, () => {
          for (const callback of listeners) callback()
        }, { recursive: !scoped }),
      }
      this.#watches.set(root, entry)
    }
    entry.listeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      entry!.listeners.delete(listener)
      if (entry!.listeners.size === 0 && this.#watches.get(root) === entry) {
        entry!.close()
        this.#watches.delete(root)
      }
    }
  }

  async createWorkspaceSession(cwd: string): Promise<PiSessionSummary> {
    const workspace = resolve(cwd)
    const id = randomUUID()
    const timestamp = new Date().toISOString()
    const directory = getPiSessionDirectory(workspace, this.#options.agentDir)
    const path = join(directory, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`)
    await mkdir(directory, { recursive: true })
    await writeFile(path, `${JSON.stringify({ type: 'session', version: 3, id, timestamp, cwd: workspace })}\n`, { encoding: 'utf8', flag: 'wx' })
    return { id, path, cwd: workspace, title: '(no messages)', firstMessage: '', messageCount: 0, createdAt: Date.parse(timestamp), modifiedAt: Date.parse(timestamp) }
  }
}

function sameSummary(left: PiSessionSummary, right: PiSessionSummary): boolean {
  const keys = Object.keys(left) as (keyof PiSessionSummary)[]
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

function sameSummaryList(left: readonly PiSessionSummary[], right: readonly PiSessionSummary[]): boolean {
  return left.length === right.length && left.every((session, index) => session === right[index])
}

export function listPiSessions(cwd: string, options: SessionCatalogOptions = {}): Promise<PiSessionSummary[]> {
  return listPiSessionsCached(cwd, options, new Map())
}

async function listPiSessionsCached(
  cwd: string,
  options: SessionCatalogOptions,
  cache: Map<string, SessionCacheEntry>,
): Promise<PiSessionSummary[]> {
  const paths = await listSessionPaths(cwd, options)
  const metas = (await mapConcurrent(paths, options.concurrency ?? SESSION_META_CONCURRENCY, sessionMeta))
    .filter((meta): meta is SessionFileMeta => meta !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  const livePaths = new Set(metas.map((meta) => meta.path))
  for (const path of cache.keys()) if (!livePaths.has(path)) cache.delete(path)
  const sessions = (await mapConcurrent(metas, options.concurrency ?? DEFAULT_CONCURRENCY, (meta) => readPiSessionSummary(meta, cache)))
    .filter((session): session is PiSessionSummary => session !== null)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
  return options.limit === undefined ? sessions : sessions.slice(0, Math.max(0, options.limit))
}

async function listSessionPaths(cwd: string, options: SessionCatalogOptions): Promise<string[]> {
  if ((options.scope ?? 'all') === 'cwd') return jsonlFiles(getPiSessionDirectory(cwd, options.agentDir))
  const root = getPiSessionRoot(options.agentDir)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name))
  const nested = await mapConcurrent(directories, 12, jsonlFiles)
  return nested.flat()
}

async function jsonlFiles(directory: string): Promise<string[]> {
  try {
    const names = await readdir(directory)
    return names.filter((name) => name.endsWith('.jsonl')).map((name) => join(directory, name))
  } catch {
    return []
  }
}

async function sessionMeta(path: string): Promise<SessionFileMeta | null> {
  try {
    const fileStats = await stat(path)
    return {
      path,
      mtimeMs: fileStats.mtimeMs,
      birthtimeMs: fileStats.birthtimeMs,
      size: fileStats.size,
    }
  } catch {
    return null
  }
}

export function sessionSidebarCachePath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'sessions.json')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'sessions.json')
  return join(environment.XDG_CACHE_HOME ?? join(home, '.cache'), 'heddlework', 'sessions.json')
}

function readPersistedSessions(path: string | false | undefined): PiSessionSummary[] {
  if (!path) return []
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: unknown }
    if (!Array.isArray(value.sessions)) return []
    return value.sessions.filter(isSessionSummary).sort((left, right) => right.modifiedAt - left.modifiedAt)
  } catch {
    return []
  }
}

async function persistSessions(path: string | false | undefined, sessions: PiSessionSummary[]): Promise<void> {
  if (!path) return
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ version: 1, sessions })}\n`, 'utf8')
  } catch {
    // A fresh filesystem scan still populates the current run when persistence is unavailable.
  }
}

function isSessionSummary(value: unknown): value is PiSessionSummary {
  if (!value || typeof value !== 'object') return false
  const session = value as Record<string, unknown>
  return typeof session.id === 'string' && typeof session.path === 'string' && typeof session.cwd === 'string' && typeof session.title === 'string' && typeof session.firstMessage === 'string' && typeof session.messageCount === 'number' && typeof session.createdAt === 'number' && typeof session.modifiedAt === 'number'
}

export function getPiSessionRoot(configuredAgentDir?: string): string {
  if (!configuredAgentDir && process.env.PI_CODING_AGENT_SESSION_DIR) return resolve(expandTilde(process.env.PI_CODING_AGENT_SESSION_DIR))
  const agentDir = resolve(expandTilde(configuredAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')))
  return join(agentDir, 'sessions')
}

export function getPiSessionDirectory(cwd: string, configuredAgentDir?: string): string {
  const resolvedCwd = resolve(cwd)
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(getPiSessionRoot(configuredAgentDir), safePath)
}

async function readPiSessionSummary(
  meta: SessionFileMeta,
  cache: Map<string, SessionCacheEntry>,
): Promise<PiSessionSummary | null> {
  const cached = cache.get(meta.path)
  if (cached?.mtimeMs === meta.mtimeMs && cached.size === meta.size) return cached.summary
  const accumulator: HeaderAccumulator = {
    id: '',
    cwd: '',
    firstMessage: '',
    foundFirstUser: false,
    messageCount: 0,
    createdAt: meta.birthtimeMs || meta.mtimeMs,
    lastResponseAt: 0,
  }
  const scanToEnd = meta.size <= FULL_SCAN_BYTES
  let reachedEnd = false
  let handle
  try {
    handle = await open(meta.path, 'r')
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let position = 0
    while (position < meta.size) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, meta.size - position))
      const result = await handle.read(buffer, 0, buffer.length, position)
      if (result.bytesRead === 0) break
      position += result.bytesRead
      pending += decoder.write(buffer.subarray(0, result.bytesRead))
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        const foundFirstUser = consumeSessionLine(line, accumulator)
        if (foundFirstUser && !scanToEnd) break
        newline = pending.indexOf('\n')
      }
      if (accumulator.foundFirstUser && !scanToEnd) break
    }
    if (position >= meta.size) {
      pending += decoder.end()
      if (pending.trim()) consumeSessionLine(pending.replace(/\r$/, ''), accumulator)
      reachedEnd = true
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }

  if (!accumulator.id) return null
  if (!reachedEnd) {
    const tail = await latestSessionTail(meta)
    if (tail.nameFound) accumulator.name = tail.name
    accumulator.lastResponseAt = Math.max(accumulator.lastResponseAt, tail.lastResponseAt)
    if (tail.lastAssistantText !== undefined) accumulator.lastAssistantText = tail.lastAssistantText
    if (tail.lastAssistantStopReason !== undefined) accumulator.lastAssistantStopReason = tail.lastAssistantStopReason
  }
  const fallback = accumulator.firstMessage || (accumulator.messageCount === 0 ? 'New thread' : '(image or attachment)')
  const summary: PiSessionSummary = {
    id: accumulator.id,
    path: meta.path,
    cwd: accumulator.cwd,
    title: accumulator.name ?? compactTitle(fallback),
    ...(accumulator.name ? { name: accumulator.name } : {}),
    firstMessage: fallback,
    messageCount: accumulator.messageCount,
    createdAt: accumulator.createdAt,
    modifiedAt: accumulator.lastResponseAt || accumulator.createdAt,
    ...(accumulator.parentSession ? { parentSession: accumulator.parentSession } : {}),
    ...(accumulator.lastAssistantText ? { lastAssistantText: accumulator.lastAssistantText } : {}),
    ...(accumulator.lastAssistantStopReason ? { lastAssistantStopReason: accumulator.lastAssistantStopReason } : {}),
  }
  cache.set(meta.path, { mtimeMs: meta.mtimeMs, size: meta.size, summary })
  return summary
}

function consumeSessionLine(line: string, accumulator: HeaderAccumulator): boolean {
  if (!line.trim()) return false
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return false
  }
  if (!accumulator.id) {
    if (entry.type !== 'session' || typeof entry.id !== 'string') return false
    accumulator.id = entry.id
    accumulator.cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
    accumulator.parentSession = typeof entry.parentSession === 'string' ? entry.parentSession : undefined
    accumulator.createdAt = timestampMs(entry.timestamp) ?? accumulator.createdAt
    return false
  }
  if (entry.type === 'session_info') {
    accumulator.name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined
    return false
  }
  if (entry.type !== 'message') return false
  accumulator.messageCount++
  const message = asRecord(entry.message)
  if (message.role === 'assistant') {
    const responseAt = timestampMs(message.timestamp) ?? timestampMs(entry.timestamp)
    if (responseAt) accumulator.lastResponseAt = Math.max(accumulator.lastResponseAt, responseAt)
    accumulator.lastAssistantText = contentText(message.content).trim().slice(0, 4_000)
    accumulator.lastAssistantStopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined
  }
  if (message.role !== 'user' || accumulator.foundFirstUser) return false
  accumulator.foundFirstUser = true
  accumulator.firstMessage = contentText(message.content).trim()
  return true
}

async function latestSessionTail(meta: SessionFileMeta): Promise<{ nameFound: boolean; name?: string; lastResponseAt: number; lastAssistantText?: string; lastAssistantStopReason?: string }> {
  if (meta.size <= 0) return { nameFound: false, lastResponseAt: 0 }
  let handle
  try {
    handle = await open(meta.path, 'r')
    const size = Math.min(SESSION_TAIL_BYTES, meta.size)
    const offset = meta.size - size
    const buffer = Buffer.allocUnsafe(size)
    const result = await handle.read(buffer, 0, size, offset)
    let text = buffer.subarray(0, result.bytesRead).toString('utf8')
    if (offset > 0) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }
    let nameFound = false
    let name: string | undefined
    let lastResponseAt = 0
    let lastAssistantText: string | undefined
    let lastAssistantStopReason: string | undefined
    for (const line of text.split('\n')) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (entry.type === 'session_info') {
          nameFound = true
          name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined
          continue
        }
        if (entry.type !== 'message') continue
        const message = asRecord(entry.message)
        if (message.role !== 'assistant') continue
        const responseAt = timestampMs(message.timestamp) ?? timestampMs(entry.timestamp)
        if (responseAt) lastResponseAt = Math.max(lastResponseAt, responseAt)
        lastAssistantText = contentText(message.content).trim().slice(0, 4_000)
        lastAssistantStopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined
      } catch {
        continue
      }
    }
    return { nameFound, ...(name ? { name } : {}), lastResponseAt, ...(lastAssistantText ? { lastAssistantText } : {}), ...(lastAssistantStopReason ? { lastAssistantStopReason } : {}) }
  } catch {
    return { nameFound: false, lastResponseAt: 0 }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function mapConcurrent<Input, Output>(
  values: Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= values.length) return
      output[index] = await mapper(values[index]!)
    }
  })
  await Promise.all(workers)
  return output
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function compactTitle(value: string): string {
  const firstLine = value.split('\n', 1)[0]?.trim() || '(no messages)'
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine
}

function expandTilde(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

export function sessionProjectName(session: Pick<PiSessionSummary, 'cwd'>): string {
  return basename(session.cwd) || session.cwd || 'Unknown project'
}

export function isCurrentPiSession(
  session: Pick<PiSessionSummary, 'id' | 'path'>,
  current: { sessionId?: string | undefined; sessionFile?: string | undefined },
): boolean {
  if (current.sessionFile) return session.path === current.sessionFile
  return Boolean(current.sessionId) && session.id === current.sessionId
}
