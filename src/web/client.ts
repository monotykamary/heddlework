import { applySnapshotPatch, encodeFrames, FrameAssembler, parseServerMessage, PROTOCOL_VERSION, type WorkbenchCommand, type WorkbenchSnapshot } from '../protocol/index.ts'
import type { FlowRuntimeSnapshot } from '../flows/types.ts'
import type { RemoteTerminalFrame, RemoteTerminalSnapshot } from '../protocol/terminal.ts'

export type WorkspaceClientStatus = 'connecting' | 'open' | 'closed'
export interface WorkspaceClientView { status: WorkspaceClientStatus; workspacePath: string; state: WorkbenchSnapshot | undefined; flows: FlowRuntimeSnapshot | undefined; terminal?: RemoteTerminalSnapshot | undefined; lastError?: string | undefined }
type SocketFactory = (url: string, protocols?: string[]) => WebSocket
interface PendingCommand { wire: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; sent: boolean }
const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 10_000
const MAX_PENDING_COMMANDS = 128
const MAX_CLIENT_BUFFERED_BYTES = 2 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 120_000

export class WorkspaceClient {
  readonly #socketFactory: SocketFactory
  readonly #clientId: string
  #socket: WebSocket | undefined
  #url = ''
  #token = ''
  #wantOpen = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #backoff = MIN_BACKOFF_MS
  #commandId = 0
  #pending = new Map<string, PendingCommand>()
  #listeners = new Set<() => void>()
  #terminalListeners = new Set<(frame: RemoteTerminalFrame) => void>()
  #terminalFrames = new Map<string, RemoteTerminalFrame>()
  #frames = new FrameAssembler()
  #view: WorkspaceClientView = { status: 'closed', workspacePath: '', state: undefined, flows: undefined }

  constructor(socketFactory: SocketFactory = (url, protocols) => new WebSocket(url, protocols), clientId = createClientId()) { this.#socketFactory = socketFactory; this.#clientId = clientId }
  connect(url: string, token: string): void {
    const normalized = normalizeHostUrl(url)
    if (!token || token.length < 32) throw new Error('A valid pairing token is required')
    this.disconnect()
    this.#url = normalized; this.#token = token; this.#wantOpen = true; this.#backoff = MIN_BACKOFF_MS
    this.#open()
  }
  disconnect(): void {
    this.#wantOpen = false
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    const socket = this.#socket; this.#socket = undefined; socket?.close()
    this.#frames.reset()
    this.#terminalFrames.clear()
    for (const [id, pending] of this.#pending) { clearTimeout(pending.timer); pending.reject(new Error('Disconnected')); this.#pending.delete(id) }
    this.#set({ status: 'closed', workspacePath: '', state: undefined, flows: undefined, terminal: undefined, lastError: undefined })
  }
  dispose(): void { this.disconnect(); this.#url = ''; this.#token = ''; this.#listeners.clear(); this.#terminalListeners.clear() }
  reconnect(): void { if (!this.#url) return; const url = this.#url, token = this.#token; this.disconnect(); this.connect(url, token) }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  getSnapshot(): WorkspaceClientView { return this.#view }
  onTerminalFrame(listener: (frame: RemoteTerminalFrame) => void): () => void { this.#terminalListeners.add(listener); return () => { this.#terminalListeners.delete(listener) } }
  terminalFrame(id: string): RemoteTerminalFrame | undefined { return this.#terminalFrames.get(id) }
  get url(): string { return this.#url }

  send(command: WorkbenchCommand): Promise<unknown> {
    if (!this.#wantOpen) return Promise.reject(new Error('Not connected'))
    if (this.#pending.size >= MAX_PENDING_COMMANDS) return Promise.reject(new Error('Too many pending commands'))
    const id = `${++this.#commandId}`
    const wire = JSON.stringify({ kind: 'command', id, command })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('Command timed out')) }, COMMAND_TIMEOUT_MS)
      this.#pending.set(id, { wire, resolve, reject, timer, sent: false })
      this.#flush()
    })
  }
  sendAndReport(command: WorkbenchCommand): Promise<void> { return this.send(command).then(() => undefined, (error: unknown) => { this.reportError(error) }) }
  reportError(error: unknown): void { this.#set({ lastError: error instanceof Error ? error.message : String(error) }) }

  #open(): void {
    if (!this.#wantOpen) return
    this.#set({ status: 'connecting' })
    this.#frames.reset()
    const frames = new FrameAssembler()
    this.#frames = frames
    let socket: WebSocket
    try { socket = this.#socketFactory(workspaceSocketUrl(this.#url), ['heddlework-v2', `auth.${this.#token}`]) } catch (error) { this.reportError(error); this.#schedule(); return }
    this.#socket = socket
    socket.addEventListener('open', () => { if (this.#socket !== socket) return; this.#sendRaw(JSON.stringify({ kind: 'hello', protocol: PROTOCOL_VERSION, clientId: this.#clientId })) })
    socket.addEventListener('message', (event) => {
      if (this.#socket !== socket || typeof event.data !== 'string') return
      let assembled: string | undefined
      try { assembled = frames.push(event.data) } catch (error) { this.reportError(error); socket.close(1009, 'Invalid frames'); return }
      if (assembled === undefined) return
      const message = parseServerMessage(assembled)
      if (!message) { this.reportError(new Error('Malformed host message')); return }
      if (message.kind === 'welcome') {
        if (message.protocol !== PROTOCOL_VERSION) { this.reportError(new Error('Host protocol is incompatible')); socket.close(); return }
        this.#backoff = MIN_BACKOFF_MS
        this.#pruneTerminalFrames(message.terminal)
        this.#set({ status: 'open', workspacePath: message.workspacePath, state: message.snapshot, flows: message.flows, terminal: message.terminal, lastError: undefined })
        for (const pending of this.#pending.values()) pending.sent = false
        this.#flush(); return
      }
      if (message.kind === 'patch' && this.#view.state) { this.#set({ state: applySnapshotPatch(this.#view.state, message.patch) }); return }
      if (message.kind === 'flows') { this.#set({ flows: message.snapshot }); return }
      if (message.kind === 'terminal') { this.#pruneTerminalFrames(message.snapshot); this.#set({ terminal: message.snapshot }); return }
      if (message.kind === 'terminalFrame') {
        if (!this.#view.terminal?.sessions.some((session) => session.id === message.frame.id)) return
        this.#terminalFrames.set(message.frame.id, message.frame)
        for (const listener of this.#terminalListeners) listener(message.frame)
        return
      }
      if (message.kind === 'result') {
        const pending = this.#pending.get(message.id); if (!pending) return
        this.#pending.delete(message.id); clearTimeout(pending.timer)
        if (message.ok) pending.resolve('value' in message ? message.value : undefined); else pending.reject(new Error(message.error))
        return
      }
      if (message.kind === 'error') this.reportError(new Error(message.message))
    })
    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return
      this.#socket = undefined
      frames.reset()
      this.#terminalFrames.clear()
      for (const pending of this.#pending.values()) pending.sent = false
      this.#set({ status: this.#wantOpen ? 'connecting' : 'closed', terminal: undefined })
      this.#schedule()
    })
    socket.addEventListener('error', () => { if (this.#socket === socket) this.#set({ lastError: 'Socket error' }) })
  }
  #flush(): void {
    const socket = this.#socket
    if (!socket || socket.readyState !== WebSocket.OPEN || this.#view.status !== 'open') return
    for (const pending of this.#pending.values()) {
      if (pending.sent) continue
      if (socket.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) return
      pending.sent = true
      try { this.#sendRaw(pending.wire) } catch (error) { pending.sent = false; this.reportError(error); socket.close(); return }
    }
  }
  #sendRaw(payload: string): void { const socket = this.#socket; if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Socket is not open'); for (const frame of encodeFrames(payload)) socket.send(frame) }
  #schedule(): void {
    if (!this.#wantOpen || this.#timer) return
    const delay = this.#backoff; this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS)
    this.#timer = setTimeout(() => { this.#timer = undefined; this.#open() }, delay)
  }
  #pruneTerminalFrames(snapshot: RemoteTerminalSnapshot | undefined): void {
    const ids = new Set(snapshot?.sessions.map((session) => session.id) ?? [])
    for (const id of this.#terminalFrames.keys()) if (!ids.has(id)) this.#terminalFrames.delete(id)
  }
  #set(patch: Partial<WorkspaceClientView>): void { this.#view = { ...this.#view, ...patch }; for (const listener of this.#listeners) listener() }
}

export function workspaceSocketUrl(hostUrl: string): string {
  const host = normalizeHostUrl(hostUrl)
  const url = new URL(host); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`; url.search = ''; url.hash = ''
  return url.toString()
}
export function normalizeHostUrl(value: string): string {
  const input = value.trim(); const url = new URL(input.includes('://') ? input : `http://${input}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Host URL must use HTTP or HTTPS')
  if (url.username || url.password) throw new Error('Host URL must not contain credentials')
  url.search = ''; url.hash = ''; return url.toString().replace(/\/+$/, '')
}
export function readConnectionSettings(search = '', storage?: Pick<Storage, 'getItem'>, origin = '', hash = ''): { host: string; token: string } {
  const query = new URLSearchParams(search.replace(/^\?/, ''))
  const fragment = new URLSearchParams(hash.replace(/^#/, ''))
  return { host: fragment.get('host') ?? query.get('host') ?? storage?.getItem('heddlework.host') ?? origin, token: fragment.get('token') ?? storage?.getItem('heddlework.token') ?? '' }
}
function createClientId(): string { return `web-${crypto.randomUUID()}` }
