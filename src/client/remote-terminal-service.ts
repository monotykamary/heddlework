import type { WorkspaceClient } from '../web/client.ts'
import { MAX_TERMINAL_WRITE_CHARS, type RemoteTerminalFrame, type RemoteTerminalSnapshot } from '../protocol/terminal.ts'
import type { TerminalAppearance, TerminalGridSnapshot, TerminalPlacement, TerminalServiceSnapshot, TerminalSessionId, TerminalSpawnRequest } from '../terminal/types.ts'
import type { TerminalSessionService } from '../terminal/service.ts'

const DEFAULT_APPEARANCE: TerminalAppearance = { fontFamily: 'ui-monospace', nerdFontFamily: 'Symbols Nerd Font Mono', ligaturesEnabled: true, nerdFontEnabled: false, muteEmojiColors: true }
const FG = { kind: 'default-fg' } as const
const BG = { kind: 'default-bg' } as const
const EMPTY_REMOTE: RemoteTerminalSnapshot = { sessions: [] }

export class RemoteTerminalService {
  readonly #client: WorkspaceClient
  readonly #listeners = new Set<() => void>()
  readonly #stateListeners = new Set<() => void>()
  readonly #frameListeners = new Set<(id: string) => void>()
  #remote: RemoteTerminalSnapshot = { sessions: [] }
  #appearance = DEFAULT_APPEARANCE
  #activeBottomId: string | undefined
  #activeRightId: string | undefined
  #generation = 0
  #snapshot: TerminalServiceSnapshot
  #stateSnapshot: TerminalServiceSnapshot
  readonly #grids = new WeakMap<RemoteTerminalFrame, TerminalGridSnapshot>()
  #unsubscribeClient: () => void
  #unsubscribeFrames: () => void
  readonly #sizeOwners = new Map<string, TerminalPlacement>()
  readonly #sizes = new Map<string, string>()
  constructor(client: WorkspaceClient) {
    this.#client = client
    this.#pull()
    this.#snapshot = this.#createSnapshot()
    this.#stateSnapshot = this.#snapshot
    this.#unsubscribeClient = client.subscribe(() => { if (this.#pull()) this.#emitState() })
    this.#unsubscribeFrames = client.onTerminalFrame((frame) => {
      this.#generation += 1
      this.#snapshot = { ...this.#snapshot, generation: this.#generation }
      for (const listener of this.#frameListeners) listener(frame.id)
      for (const listener of this.#listeners) listener()
    })
  }
  readonly subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  readonly subscribeState = (listener: () => void) => { this.#stateListeners.add(listener); return () => { this.#stateListeners.delete(listener) } }
  readonly subscribeFrames = (listener: (id: string) => void) => { this.#frameListeners.add(listener); return () => { this.#frameListeners.delete(listener) } }
  readonly getSnapshot = (): TerminalServiceSnapshot => this.#snapshot
  readonly getStateSnapshot = (): TerminalServiceSnapshot => this.#stateSnapshot

  grid(id: TerminalSessionId | undefined): TerminalGridSnapshot | undefined {
    if (!id || !this.#remote.sessions.some((session) => session.id === id)) return undefined
    const frame = this.#client.terminalFrame(id)
    if (!frame) return undefined
    let grid = this.#grids.get(frame)
    if (!grid) {
      grid = gridFromFrame(frame)
      this.#grids.set(frame, grid)
    }
    return grid
  }
  setAppearance(patch: Partial<TerminalAppearance>): void { this.#appearance = { ...this.#appearance, ...patch }; this.#emitState() }
  resetAppearance(): void { this.#appearance = DEFAULT_APPEARANCE; this.#emitState() }
  async spawn(request: TerminalSpawnRequest = {}): Promise<TerminalSessionId> {
    const value = await this.#client.send({
      type: 'openTerminal',
      ...(request.cols === undefined ? {} : { cols: request.cols }),
      ...(request.rows === undefined ? {} : { rows: request.rows }),
    })
    if (typeof value !== 'string') throw new Error('Host did not return a terminal id')
    let changed = false
    if (!this.#activeBottomId) { this.#activeBottomId = value; changed = true }
    if (!this.#activeRightId) { this.#activeRightId = value; changed = true }
    if (changed) this.#emitState()
    return value
  }
  async ensureSession(placement: TerminalPlacement = 'bottom', size?: { cols: number; rows: number }): Promise<TerminalSessionId> { const active = placement === 'bottom' ? this.#activeBottomId : this.#activeRightId; const existing = active && this.#remote.sessions.some((session) => session.id === active) ? active : this.#remote.sessions[0]?.id; const id = existing ?? await this.spawn(); this.select(placement, id); if (size) this.resize(id, size.cols, size.rows, placement); return id }
  select(placement: TerminalPlacement, id: TerminalSessionId | undefined): void {
    const active = placement === 'bottom' ? this.#activeBottomId : this.#activeRightId
    if (active === id) return
    if (placement === 'bottom') this.#activeBottomId = id
    else this.#activeRightId = id
    this.#emitState()
  }
  write(id: TerminalSessionId, data: string): void { for (let offset = 0; offset < data.length; offset += MAX_TERMINAL_WRITE_CHARS) void this.#client.send({ type: 'writeTerminal', id, data: data.slice(offset, offset + MAX_TERMINAL_WRITE_CHARS) }).catch((error) => this.#client.reportError(error)) }
  claimSize(id: TerminalSessionId, owner: TerminalPlacement): void {
    if (!this.#remote.sessions.some((session) => session.id === id)) return
    this.#sizeOwners.set(id, owner)
    this.#sizes.delete(id)
  }
  resize(id: TerminalSessionId, cols: number, rows: number, owner?: TerminalPlacement): void {
    if (!this.#remote.sessions.some((session) => session.id === id)) return
    const currentOwner = this.#sizeOwners.get(id)
    if (owner && currentOwner && currentOwner !== owner) return
    if (owner) this.#sizeOwners.set(id, owner)
    const key = `${Math.floor(cols)}x${Math.floor(rows)}`
    if (this.#sizes.get(id) === key) return
    this.#sizes.set(id, key)
    void this.#client.send({ type: 'resizeTerminal', id, cols, rows }).catch((error) => {
      if (this.#sizes.get(id) === key) this.#sizes.delete(id)
      this.#client.reportError(error)
    })
  }
  setScrollOffset(_id: TerminalSessionId, _offset: number): void {}
  async close(id: TerminalSessionId): Promise<void> { await this.#client.send({ type: 'closeTerminal', id }); this.#sizeOwners.delete(id); this.#sizes.delete(id) }
  async dispose(): Promise<void> { this.#unsubscribeClient(); this.#unsubscribeFrames(); this.#remote = EMPTY_REMOTE; this.#activeBottomId = undefined; this.#activeRightId = undefined; this.#sizeOwners.clear(); this.#sizes.clear(); this.#listeners.clear(); this.#stateListeners.clear(); this.#frameListeners.clear(); this.#emitState() }
  #pull(): boolean { const next = this.#client.getSnapshot().terminal ?? EMPTY_REMOTE; if (next === this.#remote) return false; this.#remote = next; const ids = new Set(next.sessions.map((session) => session.id)); for (const id of this.#sizeOwners.keys()) if (!ids.has(id)) this.#sizeOwners.delete(id); for (const id of this.#sizes.keys()) if (!ids.has(id)) this.#sizes.delete(id); const preferred = next.activeId && ids.has(next.activeId) ? next.activeId : next.sessions[0]?.id; if (!this.#activeBottomId || !ids.has(this.#activeBottomId)) this.#activeBottomId = preferred; if (this.#activeRightId && !ids.has(this.#activeRightId)) this.#activeRightId = undefined; return true }
  #createSnapshot(): TerminalServiceSnapshot { return { sessions: this.#remote.sessions.map((session) => ({ id: session.id, name: session.name, title: session.title, cwd: session.cwd, cols: session.cols, rows: session.rows, status: session.status === 'running' ? { kind: 'running' } : { kind: 'exited', exitCode: session.exitCode ?? null } })), activeBottomId: this.#activeBottomId, activeRightId: this.#activeRightId, appearance: this.#appearance, generation: this.#generation } }
  #emitState(): void {
    this.#generation += 1
    this.#snapshot = this.#createSnapshot()
    this.#stateSnapshot = this.#snapshot
    for (const listener of this.#stateListeners) listener()
    for (const listener of this.#listeners) listener()
  }
}
export function asTerminalSessionService(remote: RemoteTerminalService): TerminalSessionService { return remote as unknown as TerminalSessionService }
function gridFromFrame(frame: RemoteTerminalFrame): TerminalGridSnapshot { const viewport = Array.from({ length: frame.rows }, (_, row) => { const text = frame.lines[row] ?? ''; const characters = Array.from(text).slice(0, frame.cols); const cells = Array.from({ length: frame.cols }, (_, column) => ({ ch: characters[column] ?? ' ', fg: FG, bg: BG, attrs: 0 })); return { text, cells } }); return { cols: frame.cols, rows: frame.rows, cursorX: frame.cursorX, cursorY: frame.cursorY, cursorVisible: frame.cursorVisible, applicationCursor: frame.applicationCursor, bracketedPaste: frame.bracketedPaste, title: frame.title, viewport, scrollback: 0, scrollOffset: 0 } }
