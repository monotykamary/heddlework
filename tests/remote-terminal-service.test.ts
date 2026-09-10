import { expect, it } from 'bun:test'
import { RemoteTerminalService } from '../src/client/remote-terminal-service.ts'
import { applyTerminalCommand, type RemoteTerminalFrame, type RemoteTerminalSnapshot, type TerminalCommand } from '../src/protocol/terminal.ts'
import { MemoryTerminalBackend } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import type { WorkspaceClient } from '../src/web/client.ts'

function serializeTerminal(terminals: TerminalSessionService): RemoteTerminalSnapshot {
  const snapshot = terminals.getStateSnapshot()
  return {
    sessions: snapshot.sessions.map((session) => ({
      id: session.id,
      name: session.name,
      title: session.title,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      status: session.status.kind,
      ...(session.status.kind === 'exited' ? { exitCode: session.status.exitCode } : {}),
    })),
    ...(snapshot.activeBottomId ? { activeId: snapshot.activeBottomId } : {}),
  }
}

function createCommandClient(terminals: TerminalSessionService): {
  client: WorkspaceClient
  commands: TerminalCommand[]
  dispose(): void
} {
  let terminal = serializeTerminal(terminals)
  const listeners = new Set<() => void>()
  const commands: TerminalCommand[] = []
  const unsubscribeTerminal = terminals.subscribeState(() => {
    terminal = serializeTerminal(terminals)
    for (const listener of listeners) listener()
  })
  const client = {
    getSnapshot: () => ({ terminal }),
    terminalFrame: () => undefined,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onTerminalFrame: () => () => {},
    send: (command: TerminalCommand) => { commands.push(command); return applyTerminalCommand(terminals, command) },
    reportError: (error: unknown) => { throw error },
  } as unknown as WorkspaceClient
  return { client, commands, dispose: unsubscribeTerminal }
}

it('keeps external-store snapshots stable and separates frames from state changes', async () => {
  let terminal: RemoteTerminalSnapshot = {
    sessions: [{ id: 'one', name: 'one', title: 'shell', cwd: '/workspace', cols: 4, rows: 1, status: 'running' }],
  }
  let frame: RemoteTerminalFrame = {
    id: 'one', cols: 4, rows: 1, cursorX: 0, cursorY: 0, cursorVisible: true,
    applicationCursor: false, bracketedPaste: false, title: 'shell', lines: ['old'],
  }
  const stateListeners = new Set<() => void>()
  const frameListeners = new Set<(frame: RemoteTerminalFrame) => void>()
  const client = {
    getSnapshot: () => ({ terminal }),
    terminalFrame: () => frame,
    subscribe: (listener: () => void) => { stateListeners.add(listener); return () => stateListeners.delete(listener) },
    onTerminalFrame: (listener: (frame: RemoteTerminalFrame) => void) => { frameListeners.add(listener); return () => frameListeners.delete(listener) },
  } as unknown as WorkspaceClient
  const service = new RemoteTerminalService(client)
  try {
    const initial = service.getSnapshot()
    const initialState = service.getStateSnapshot()
    const initialGrid = service.grid('one')
    expect(service.getSnapshot()).toBe(initial)
    expect(service.getStateSnapshot()).toBe(initialState)
    expect(service.grid('one')).toBe(initialGrid)

    let stateChanges = 0
    let frameChanges = 0
    service.subscribeState(() => { stateChanges += 1 })
    service.subscribeFrames(() => { frameChanges += 1 })
    frame = { ...frame, lines: ['new'] }
    for (const listener of frameListeners) listener(frame)
    expect(service.getSnapshot()).not.toBe(initial)
    expect(service.getSnapshot()).toBe(service.getSnapshot())
    expect(service.getStateSnapshot()).toBe(initialState)
    expect(service.grid('one')).not.toBe(initialGrid)
    expect(service.grid('one')).toBe(service.grid('one'))
    expect(service.grid('one')?.viewport[0]?.text).toBe('new')
    expect(stateChanges).toBe(0)
    expect(frameChanges).toBe(1)

    service.select('right', 'one')
    const selected = service.getStateSnapshot()
    expect(selected.activeRightId).toBe('one')
    expect(selected).not.toBe(initialState)
    service.select('right', 'one')
    expect(service.getStateSnapshot()).toBe(selected)
    expect(stateChanges).toBe(1)

    terminal = { sessions: [] }
    for (const listener of stateListeners) listener()
    expect(service.getStateSnapshot().sessions).toEqual([])
    expect(service.grid('one')).toBeUndefined()
  } finally {
    await service.dispose()
  }
  expect(stateListeners.size).toBe(0)
  expect(frameListeners.size).toBe(0)
  expect(service.getStateSnapshot().sessions).toEqual([])
})

it('opens distinct remote terminals rather than reusing the first PTY', async () => {
  const terminals = new TerminalSessionService({ cwd: '/workspace', backend: new MemoryTerminalBackend(), appearancePath: false })
  try {
    const first = await applyTerminalCommand(terminals, { type: 'openTerminal', cols: 30, rows: 8 })
    const second = await applyTerminalCommand(terminals, { type: 'openTerminal', cols: 40, rows: 10 })
    expect(first).not.toBe(second)
    expect(terminals.getStateSnapshot().sessions.map(({ cols, rows }) => ({ cols, rows }))).toEqual([
      { cols: 30, rows: 8 }, { cols: 40, rows: 10 },
    ])
  } finally {
    await terminals.dispose()
  }
})

it('fills only empty remote placements when spawning through the host command service', async () => {
  const terminals = new TerminalSessionService({ cwd: '/workspace', backend: new MemoryTerminalBackend(), appearancePath: false })
  const harness = createCommandClient(terminals)
  const remote = new RemoteTerminalService(harness.client)
  try {
    const first = await remote.spawn()
    expect(remote.getStateSnapshot().activeBottomId).toBe(first)
    expect(remote.getStateSnapshot().activeRightId).toBe(first)

    let stateChanges = 0
    const unsubscribe = remote.subscribeState(() => { stateChanges += 1 })
    const second = await remote.spawn({ cwd: '/not-forwarded', shell: '/not-forwarded', cols: 35, rows: 9 })
    expect(remote.getStateSnapshot().activeBottomId).toBe(first)
    expect(remote.getStateSnapshot().activeRightId).toBe(first)
    expect(stateChanges).toBe(1)

    remote.select('right', second)
    expect(remote.getStateSnapshot().activeBottomId).toBe(first)
    expect(remote.getStateSnapshot().activeRightId).toBe(second)
    expect(stateChanges).toBe(2)
    expect(harness.commands.at(-1)).toEqual({ type: 'openTerminal', cols: 35, rows: 9 })
    expect(terminals.getStateSnapshot().sessions.find((session) => session.id === second)).toMatchObject({ cwd: '/workspace', cols: 35, rows: 9 })
    unsubscribe()
  } finally {
    await remote.dispose()
    harness.dispose()
    await terminals.dispose()
  }
})

it('arbitrates remote pane sizes locally and resends after an explicit claim', async () => {
  const terminals = new TerminalSessionService({ cwd: '/workspace', backend: new MemoryTerminalBackend(), appearancePath: false })
  const harness = createCommandClient(terminals)
  const remote = new RemoteTerminalService(harness.client)
  try {
    const id = await remote.spawn()
    remote.claimSize(id, 'bottom')
    remote.resize(id, 100, 30, 'bottom')
    expect(terminals.getStateSnapshot().sessions[0]).toMatchObject({ cols: 100, rows: 30 })

    remote.resize(id, 120, 40, 'right')
    expect(terminals.getStateSnapshot().sessions[0]).toMatchObject({ cols: 100, rows: 30 })

    remote.claimSize(id, 'right')
    remote.resize(id, 120, 40, 'right')
    expect(terminals.getStateSnapshot().sessions[0]).toMatchObject({ cols: 120, rows: 40 })

    terminals.resize(id, 90, 20)
    remote.claimSize(id, 'right')
    remote.resize(id, 120, 40, 'right')
    expect(terminals.getStateSnapshot().sessions[0]).toMatchObject({ cols: 120, rows: 40 })
  } finally {
    await remote.dispose()
    harness.dispose()
    await terminals.dispose()
  }
})

it('applies host resizes without claiming a native placement', async () => {
  const terminals = new TerminalSessionService({ cwd: '/workspace', backend: new MemoryTerminalBackend(), appearancePath: false })
  try {
    const id = await terminals.spawn()
    await applyTerminalCommand(terminals, { type: 'resizeTerminal', id, cols: 1_000, rows: 1_000 })
    expect(terminals.getStateSnapshot().sessions[0]).toMatchObject({ cols: 240, rows: 80 })

    terminals.resize(id, 90, 30, 'right')
    expect(terminals.getStateSnapshot().sessions[0]).toMatchObject({ cols: 90, rows: 30 })
    await applyTerminalCommand(terminals, { type: 'resizeTerminal', id, cols: 200, rows: 70 })
    expect(terminals.getStateSnapshot().sessions[0]).toMatchObject({ cols: 200, rows: 70 })

    terminals.resize(id, 50, 20, 'bottom')
    expect(terminals.getStateSnapshot().sessions[0]).toMatchObject({ cols: 200, rows: 70 })
    terminals.resize(id, 100, 35, 'right')
    expect(terminals.getStateSnapshot().sessions[0]).toMatchObject({ cols: 100, rows: 35 })
  } finally {
    await terminals.dispose()
  }
})

it('retries a deduplicated remote resize after sending fails', async () => {
  const terminal: RemoteTerminalSnapshot = {
    sessions: [{ id: 'one', name: 'one', title: 'shell', cwd: '/workspace', cols: 80, rows: 24, status: 'running' }],
  }
  let attempts = 0
  let errors = 0
  const client = {
    getSnapshot: () => ({ terminal }),
    terminalFrame: () => undefined,
    subscribe: () => () => {},
    onTerminalFrame: () => () => {},
    send: () => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error('send failed')) : Promise.resolve()
    },
    reportError: () => { errors += 1 },
  } as unknown as WorkspaceClient
  const remote = new RemoteTerminalService(client)
  try {
    remote.resize('one', 100, 30, 'bottom')
    await Promise.resolve()
    await Promise.resolve()
    remote.resize('one', 100, 30, 'bottom')
    await Promise.resolve()
    remote.resize('one', 100, 30, 'bottom')
    expect(attempts).toBe(2)
    expect(errors).toBe(1)
  } finally {
    await remote.dispose()
  }
})
