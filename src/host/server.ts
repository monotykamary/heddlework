import { existsSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { FlowRuntime } from '../flows/runtime.ts'
import { applyWorkbenchCommand, diffSnapshots, encodeFrames, FrameAssembler, isPatchEmpty, parseClientMessage, PROTOCOL_VERSION, serializeSnapshot, utf8ByteLength, MAX_WS_FRAME_BYTES, type ServerMessage, type WorkbenchSnapshot } from '../protocol/index.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import type { RemoteTerminalFrame, RemoteTerminalSnapshot } from '../protocol/terminal.ts'
import { CommandReplayCache } from './command-replay.ts'
import { timingSafeEqualToken } from './token.ts'

export interface WorkspaceHostOptions {
  controller: WorkbenchController
  flows: FlowRuntime
  workspacePath: string
  port: number
  hostname?: string
  token: string
  staticRoot?: string
  allowNetwork?: boolean
  allowedOrigins?: readonly string[]
  terminals?: TerminalSessionService
}
export interface WorkspaceHost {
  readonly url: string; readonly port: number; readonly hostname: string; readonly token: string; readonly workspacePath: string
  connectionCount(): number
  close(): Promise<void>
}
interface SocketData {
  lastSnapshot: WorkbenchSnapshot | undefined
  scheduled: boolean
  clientId: string | undefined
  assembler: FrameAssembler
  sender: ServerMessageSendQueue | undefined
  queue: Promise<void>
  queuedCommands: number
  transcriptSession: string | undefined
  transcriptLimit: number
}

export const DEFAULT_HOST_PORT = 4817
export const DEFAULT_HOST_BIND = '127.0.0.1'
export const SOCKET_TRANSCRIPT_TAIL = 400
export const SOCKET_TRANSCRIPT_MAX = 1_200
const SOCKET_TRANSCRIPT_PAGE = 120
const MAX_COMMAND_QUEUE = 32
export const MAX_SERVER_BUFFERED_BYTES = 8 * 1024 * 1024
export const MAX_SERVER_QUEUED_BYTES = 8 * 1024 * 1024
export const SERVER_MESSAGE_LIFETIME_MS = 30_000
const SEND_RETRY_MS = 25
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

export function createWorkspaceHost(options: WorkspaceHostOptions): WorkspaceHost {
  const hostname = options.hostname ?? DEFAULT_HOST_BIND
  if (!isLoopbackHost(hostname) && !options.allowNetwork) throw new Error('Non-loopback hosting requires HEDDLEWORK_HOST_ALLOW_NETWORK=1')
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin))
  if (!isLoopbackHost(hostname) && allowedOrigins.size === 0) throw new Error('Non-loopback hosting requires HEDDLEWORK_HOST_ORIGINS')
  if (!options.token || options.token.length < 32) throw new Error('Workspace host token must be at least 32 characters')
  const staticRoot = options.staticRoot && existsSync(options.staticRoot) ? realpathSync(options.staticRoot) : undefined
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>()
  const replay = new CommandReplayCache()
  let closed = false
  let terminalTimer: ReturnType<typeof setTimeout> | undefined
  const dirtyTerminals = new Set<string>()

  const server = Bun.serve<SocketData>({
    hostname,
    port: options.port,
    fetch(request, bunServer) {
      const url = new URL(request.url)
      if (url.pathname === '/ws') {
        if (request.method !== 'GET' || !validOrigin(request, hostname, allowedOrigins)) return secureResponse('Forbidden origin', 403)
        if (!authorized(request, options.token)) return secureResponse('Unauthorized', 401)
        const protocolHeaders = requestedProtocols(request).includes('heddlework-v2') ? { 'sec-websocket-protocol': 'heddlework-v2' } : undefined
        const upgraded = bunServer.upgrade(request, { ...(protocolHeaders ? { headers: protocolHeaders } : {}), data: { lastSnapshot: undefined, scheduled: false, clientId: undefined, assembler: new FrameAssembler(), sender: undefined, queue: Promise.resolve(), queuedCommands: 0, transcriptSession: undefined, transcriptLimit: SOCKET_TRANSCRIPT_TAIL } })
        return upgraded ? undefined : secureResponse('WebSocket upgrade failed', 426)
      }
      if (url.pathname === '/health') return new Response(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }), { headers: { ...SECURITY_HEADERS, 'content-type': 'application/json' } })
      if (staticRoot && request.method === 'GET') return serveStatic(staticRoot, request)
      return secureResponse('Heddlework workspace host', 404)
    },
    websocket: {
      backpressureLimit: MAX_SERVER_BUFFERED_BYTES,
      closeOnBackpressureLimit: false,
      open(socket) { socket.data.sender = new ServerMessageSendQueue(socket); sockets.add(socket) },
      drain(socket) { socket.data.sender?.drain() },
      close(socket) { sockets.delete(socket); socket.data.assembler.reset(); socket.data.sender?.dispose(); socket.data.sender = undefined },
      message(socket, raw) {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
        if (utf8ByteLength(text) > MAX_WS_FRAME_BYTES) { socket.close(1009, 'Frame too large'); return }
        let assembled: string | undefined
        try { assembled = socket.data.assembler.push(text) } catch (error) { send(socket, { kind: 'error', message: error instanceof Error ? error.message : String(error) }); socket.close(1009, 'Invalid frames'); return }
        if (assembled === undefined) return
        const message = parseClientMessage(assembled)
        if (!message) { send(socket, { kind: 'error', message: 'Malformed client message' }); return }
        if (message.kind === 'ping') { send(socket, { kind: 'pong' }); return }
        if (message.kind === 'hello') {
          if (message.protocol !== PROTOCOL_VERSION) { send(socket, { kind: 'error', message: `Unsupported protocol ${message.protocol}; host speaks ${PROTOCOL_VERSION}` }); socket.close(1002, 'Protocol mismatch'); return }
          if (socket.data.clientId && socket.data.clientId !== message.clientId) { socket.close(1008, 'Client identity changed'); return }
          socket.data.clientId = message.clientId
          const snapshot = socketSnapshot(socket, options.controller)
          socket.data.lastSnapshot = snapshot
          send(socket, { kind: 'welcome', protocol: PROTOCOL_VERSION, workspacePath: options.workspacePath, snapshot, flows: options.flows.getSnapshot(), ...(options.terminals ? { terminal: serializeRemoteTerminal(options.terminals) } : {}) })
          if (options.terminals) for (const session of options.terminals.getStateSnapshot().sessions) { const frame = serializeRemoteTerminalFrame(options.terminals, session.id); if (frame) send(socket, { kind: 'terminalFrame', frame }) }
          return
        }
        const clientId = socket.data.clientId
        if (!clientId) { send(socket, { kind: 'result', id: message.id, ok: false, error: 'Client hello is required' }); return }
        if (socket.data.queuedCommands >= MAX_COMMAND_QUEUE) { send(socket, { kind: 'result', id: message.id, ok: false, error: 'Command queue is full' }); return }
        socket.data.queuedCommands += 1
        socket.data.queue = socket.data.queue.then(async () => {
          if (closed || !sockets.has(socket)) throw new Error('Workspace host is closing')
          const result = await replay.execute(clientId, message.id, message.command, async () => {
            if (message.command.type === 'loadEarlierMessages') { await revealEarlierMessages(socket, options.controller); pushSocketSnapshot(socket, options.controller); return }
            return applyWorkbenchCommand(options.controller, message.command, options.terminals ? { terminals: options.terminals } : {})
          })
          if (!closed && sockets.has(socket)) send(socket, result)
        }).catch(() => undefined).finally(() => { socket.data.queuedCommands -= 1 })
      },
    },
  })

  const publish = (): void => {
    for (const socket of sockets) {
      if (!socket.data.clientId || socket.data.scheduled) continue
      socket.data.scheduled = true
      queueMicrotask(() => {
        socket.data.scheduled = false
        if (closed || !sockets.has(socket) || !socket.data.clientId) return
        const next = socketSnapshot(socket, options.controller)
        const patch = diffSnapshots(socket.data.lastSnapshot, next)
        socket.data.lastSnapshot = next
        if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
      })
    }
  }
  const unsubscribeController = options.controller.subscribe(publish)
  const unsubscribeFlows = options.flows.subscribe(() => { if (closed) return; const snapshot = options.flows.getSnapshot(); for (const socket of sockets) if (socket.data.clientId) send(socket, { kind: 'flows', snapshot }) })
  const unsubscribeTerminalState = options.terminals?.subscribeState(() => { if (closed || !options.terminals) return; const snapshot = serializeRemoteTerminal(options.terminals); for (const socket of sockets) if (socket.data.clientId) send(socket, { kind: 'terminal', snapshot }) })
  const unsubscribeTerminalFrames = options.terminals?.subscribeFrames((id) => {
    if (closed) return; dirtyTerminals.add(id); if (terminalTimer) return
    terminalTimer = setTimeout(() => { terminalTimer = undefined; if (closed || !options.terminals) return; for (const terminalId of dirtyTerminals) { const frame = serializeRemoteTerminalFrame(options.terminals, terminalId); if (frame) for (const socket of sockets) if (socket.data.clientId) send(socket, { kind: 'terminalFrame', frame }) }; dirtyTerminals.clear() }, 33)
  })
  const port = server.port ?? options.port
  const displayHost = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname
  return {
    url: `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}`,
    port, hostname, token: options.token, workspacePath: options.workspacePath,
    connectionCount: () => sockets.size,
    async close() { if (closed) return; closed = true; unsubscribeController(); unsubscribeFlows(); unsubscribeTerminalState?.(); unsubscribeTerminalFrames?.(); if (terminalTimer) clearTimeout(terminalTimer); dirtyTerminals.clear(); for (const socket of sockets) { socket.data.sender?.dispose(); socket.close(1001, 'Host shutting down') }; sockets.clear(); await server.stop(true) },
  }
}

function socketSnapshot(socket: Bun.ServerWebSocket<SocketData>, controller: WorkbenchController): WorkbenchSnapshot {
  const snapshot = serializeSnapshot(controller.getSnapshot())
  const session = snapshot.session.sessionFile
  if (socket.data.transcriptSession !== session) { socket.data.transcriptSession = session; socket.data.transcriptLimit = SOCKET_TRANSCRIPT_TAIL }
  if (snapshot.messages.length <= socket.data.transcriptLimit) return snapshot
  return { ...snapshot, messages: snapshot.messages.slice(-socket.data.transcriptLimit), messagesHasOlder: true }
}
function pushSocketSnapshot(socket: Bun.ServerWebSocket<SocketData>, controller: WorkbenchController): void { const next = socketSnapshot(socket, controller); const patch = diffSnapshots(socket.data.lastSnapshot, next); socket.data.lastSnapshot = next; if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch }) }
async function revealEarlierMessages(socket: Bun.ServerWebSocket<SocketData>, controller: WorkbenchController): Promise<void> {
  const before = controller.getSnapshot().messages.length
  if (socket.data.transcriptLimit < before) { socket.data.transcriptLimit = Math.min(SOCKET_TRANSCRIPT_MAX, socket.data.transcriptLimit + SOCKET_TRANSCRIPT_PAGE); return }
  socket.data.transcriptLimit = Math.min(SOCKET_TRANSCRIPT_MAX, socket.data.transcriptLimit + SOCKET_TRANSCRIPT_PAGE)
  await controller.loadEarlierMessages()
}

export function hostConnectUrl(host: Pick<WorkspaceHost, 'url' | 'token'>): string { return `${host.url}/#token=${encodeURIComponent(host.token)}` }
export function serializeRemoteTerminal(service: TerminalSessionService): RemoteTerminalSnapshot { const snapshot = service.getStateSnapshot(); return { sessions: snapshot.sessions.map((session) => ({ id: session.id, name: session.name, title: session.title, cwd: session.cwd, cols: session.cols, rows: session.rows, status: session.status.kind, ...(session.status.kind === 'exited' ? { exitCode: session.status.exitCode } : {}) })), ...(snapshot.activeBottomId ? { activeId: snapshot.activeBottomId } : snapshot.activeRightId ? { activeId: snapshot.activeRightId } : {}) } }
export function serializeRemoteTerminalFrame(service: TerminalSessionService, id: string): RemoteTerminalFrame | undefined { const grid = service.grid(id); if (!grid) return undefined; return { id, cols: grid.cols, rows: grid.rows, cursorX: grid.cursorX, cursorY: grid.cursorY, cursorVisible: grid.cursorVisible, applicationCursor: grid.applicationCursor, bracketedPaste: grid.bracketedPaste, title: grid.title, lines: grid.viewport.slice(0, 80).map((row) => row.text.slice(0, 240).replace(/[ \t]+$/u, '')) } }
function authorized(request: Request, token: string): boolean {
  const header = request.headers.get('authorization')
  const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined
  const protocolToken = requestedProtocols(request).find((value) => value.startsWith('auth.'))?.slice(5)
  return timingSafeEqualToken(token, protocolToken) || timingSafeEqualToken(token, bearer)
}
function requestedProtocols(request: Request): string[] { return request.headers.get('sec-websocket-protocol')?.split(',').map((value) => value.trim()).filter(Boolean) ?? [] }
function validOrigin(request: Request, hostname: string, allowed: Set<string>): boolean {
  const raw = request.headers.get('origin')
  if (!raw) return true
  let origin: URL
  try { origin = new URL(raw) } catch { return false }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false
  if (allowed.has(origin.origin)) return true
  if (!isLoopbackHost(hostname) || !isLoopbackHost(origin.hostname)) return false
  const requested = new URL(request.url)
  return origin.port === requested.port
}
function normalizeOrigin(value: string): string { try { const url = new URL(value); return url.origin } catch { throw new Error(`Invalid allowed origin: ${value}`) } }
export function isLoopbackHost(hostname: string): boolean { const clean = hostname.replace(/^\[|\]$/g, '').toLowerCase(); return clean === 'localhost' || clean === '::1' || /^127(?:\.\d{1,3}){3}$/.test(clean) }
interface OutboundMessage {
  frames: string[]
  frameBytes: number[]
  nextFrame: number
  totalBytes: number
  expiresAt: number
}
interface OutboundSocket {
  getBufferedAmount(): number
  send(data: string): number
  close(code?: number, reason?: string): void
}
interface ServerMessageSendQueueOptions {
  maxBufferedBytes?: number
  maxQueuedBytes?: number
  messageLifetimeMs?: number
  maxFrameBytes?: number
  now?: () => number
}

export function boundedServerFrames(message: ServerMessage, maxFrameBytes = MAX_WS_FRAME_BYTES): string[] {
  return encodeFrames(JSON.stringify(message), maxFrameBytes)
}

export class ServerMessageSendQueue {
  readonly #socket: OutboundSocket
  readonly #maxBufferedBytes: number
  readonly #maxQueuedBytes: number
  readonly #messageLifetimeMs: number
  readonly #maxFrameBytes: number
  readonly #now: () => number
  #active: OutboundMessage | undefined
  #pending: OutboundMessage[] = []
  #queuedBytes = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(socket: OutboundSocket, options: ServerMessageSendQueueOptions = {}) {
    this.#socket = socket
    this.#maxBufferedBytes = options.maxBufferedBytes ?? MAX_SERVER_BUFFERED_BYTES
    this.#maxQueuedBytes = options.maxQueuedBytes ?? MAX_SERVER_QUEUED_BYTES
    this.#messageLifetimeMs = options.messageLifetimeMs ?? SERVER_MESSAGE_LIFETIME_MS
    this.#maxFrameBytes = options.maxFrameBytes ?? MAX_WS_FRAME_BYTES
    this.#now = options.now ?? Date.now
  }

  get hasActiveMessage(): boolean { return this.#active !== undefined }
  get queuedBytes(): number { return this.#queuedBytes }

  enqueue(message: ServerMessage): void {
    if (this.#disposed) return
    let outbound: OutboundMessage
    try {
      const frames = boundedServerFrames(message, this.#maxFrameBytes)
      const frameBytes = frames.map(utf8ByteLength)
      outbound = { frames, frameBytes, nextFrame: 0, totalBytes: frameBytes.reduce((total, bytes) => total + bytes, 0), expiresAt: this.#now() + this.#messageLifetimeMs }
    } catch {
      this.#fail(1011, 'Could not send workspace message')
      return
    }
    if (this.#active) {
      if (outbound.totalBytes > this.#maxQueuedBytes - this.#queuedBytes) { this.#fail(1013, 'Client is too slow'); return }
      this.#pending.push(outbound)
      this.#queuedBytes += outbound.totalBytes
    } else this.#active = outbound
    this.#pump()
  }

  drain(): void {
    if (this.#disposed) return
    this.#pump()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#active = undefined
    this.#pending = []
    this.#queuedBytes = 0
  }

  #pump(): void {
    if (this.#disposed) return
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    try {
      while (this.#active) {
        if (this.#now() >= this.#active.expiresAt) { this.#fail(1013, 'Client is too slow'); return }
        if (this.#active.nextFrame >= this.#active.frames.length) {
          this.#active = this.#pending.shift()
          if (this.#active) this.#queuedBytes -= this.#active.totalBytes
          continue
        }
        // Bun ServerWebSocket exposes getBufferedAmount(), not the browser bufferedAmount property.
        const buffered = this.#socket.getBufferedAmount()
        const frameBytes = this.#active.frameBytes[this.#active.nextFrame]!
        if (!Number.isFinite(buffered) || buffered < 0) throw new Error('Invalid WebSocket buffer state')
        if (frameBytes > this.#maxBufferedBytes) throw new Error('WebSocket frame exceeds outbound buffer limit')
        if (buffered + frameBytes > this.#maxBufferedBytes) { this.#schedule(); return }
        const status = this.#socket.send(this.#active.frames[this.#active.nextFrame]!)
        if (status === 0) { this.#fail(1013, 'Client is too slow'); return }
        this.#active.nextFrame += 1
        if (status < 0) { this.#schedule(); return }
      }
    } catch {
      this.#fail(1011, 'Could not send workspace message')
    }
  }

  #schedule(): void {
    if (!this.#active || this.#disposed) return
    const remaining = this.#active.expiresAt - this.#now()
    if (remaining <= 0) { this.#fail(1013, 'Client is too slow'); return }
    this.#timer = setTimeout(() => { this.#timer = undefined; this.#pump() }, Math.min(SEND_RETRY_MS, remaining))
  }

  #fail(code: number, reason: string): void {
    if (this.#disposed) return
    this.dispose()
    this.#socket.close(code, reason)
  }
}

function send(socket: Bun.ServerWebSocket<SocketData>, message: ServerMessage): void { socket.data.sender?.enqueue(message) }
function secureResponse(body: string, status: number): Response { return new Response(body, { status, headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store' } }) }
function serveStatic(root: string, request: Request): Response {
  let decoded: string
  const pathname = new URL(request.url).pathname
  try { decoded = decodeURIComponent(pathname) } catch { return secureResponse('Bad path', 400) }
  if (decoded.includes('\0')) return secureResponse('Bad path', 400)
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const candidate = resolve(root, relative || 'index.html')
  if (candidate !== root && !candidate.startsWith(root + sep)) return secureResponse('Forbidden', 403)
  let target = existsSync(candidate) && statSync(candidate).isFile() ? candidate : undefined
  if (!target) {
    if (!isSpaNavigation(request, relative)) return secureResponse('Not found', 404)
    target = join(root, 'index.html')
  }
  if (!existsSync(target)) return secureResponse('Not found', 404)
  let realTarget: string
  try { realTarget = realpathSync(target) } catch { return secureResponse('Not found', 404) }
  if (realTarget !== root && !realTarget.startsWith(root + sep)) return secureResponse('Forbidden', 403)
  const headers: Record<string, string> = { ...SECURITY_HEADERS, 'cache-control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600', 'content-type': contentType(target) }
  return new Response(Bun.file(realTarget), { headers })
}
function isSpaNavigation(request: Request, relativePath: string): boolean {
  if (extname(relativePath)) return false
  const mode = request.headers.get('sec-fetch-mode')
  const destination = request.headers.get('sec-fetch-dest')
  const acceptsHtml = request.headers.get('accept')?.split(',').some((value) => value.trim().split(';', 1)[0] === 'text/html') ?? false
  return mode === 'navigate' || destination === 'document' || acceptsHtml
}
function contentType(path: string): string {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream'
}
