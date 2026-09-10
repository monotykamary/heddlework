import { describe, expect, it } from 'bun:test'
import type { RemoteTerminalFrame, RemoteTerminalSnapshot } from '../src/protocol/terminal.ts'
import { createInitialState } from '../src/workbench/state.ts'
import { readConnectionSettings, workspaceSocketUrl, WorkspaceClient } from '../src/web/client.ts'

class FakeSocket extends EventTarget {
  static readonly OPEN = 1
  readyState = 0
  bufferedAmount = 0
  sent: string[] = []

  open(): void { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  send(value: string): void { this.sent.push(value) }
  receive(value: unknown): void { this.receiveRaw(JSON.stringify(value)) }
  receiveRaw(value: string): void { this.dispatchEvent(new MessageEvent('message', { data: value })) }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')) }
}

const token = 'a'.repeat(43)
const terminal = (id: string): RemoteTerminalSnapshot => ({ sessions: [{ id, name: id, title: id, cwd: '/workspace', cols: 80, rows: 24, status: 'running' }] })
const frame = (id: string, text: string): RemoteTerminalFrame => ({ id, cols: 80, rows: 24, cursorX: 0, cursorY: 0, cursorVisible: true, applicationCursor: false, bracketedPaste: false, title: id, lines: [text] })
const welcome = (terminalSnapshot?: RemoteTerminalSnapshot) => ({ kind: 'welcome', protocol: 2, workspacePath: '/workspace', snapshot: createInitialState('/workspace'), flows: { schedules: [], pending: [] }, ...(terminalSnapshot ? { terminal: terminalSnapshot } : {}) })

function fakeClient(): { client: WorkspaceClient; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const client = new WorkspaceClient(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket }, 'stable-client')
  return { client, sockets }
}

it('replays the same pending command id after reconnect', async () => {
  const original = globalThis.WebSocket
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket
  const { client, sockets } = fakeClient()
  try {
    client.connect('http://localhost:4817', token)
    sockets[0]!.open()
    sockets[0]!.receive(welcome())
    const pending = client.send({ type: 'setEditorText', text: 'durable' })
    await Bun.sleep(0)
    const first = sockets[0]!.sent.find((wire) => JSON.parse(wire).kind === 'command')!
    sockets[0]!.close()
    await Bun.sleep(520)
    sockets[1]!.open()
    sockets[1]!.receive(welcome())
    await Bun.sleep(0)
    const second = sockets[1]!.sent.find((wire) => JSON.parse(wire).kind === 'command')!
    expect(second).toBe(first)
    const id = JSON.parse(second).id
    sockets[1]!.receive({ kind: 'result', id, ok: true })
    await expect(pending).resolves.toBeUndefined()
  } finally {
    client.dispose()
    ;(globalThis as { WebSocket: unknown }).WebSocket = original
  }
})

describe('terminal frame lifecycle', () => {
  it('prunes authoritative terminal state, ignores orphan frames, and clears on dispose', () => {
    const { client, sockets } = fakeClient()
    const received: string[] = []
    client.onTerminalFrame((value) => received.push(value.id))
    client.connect('http://localhost:4817', token)
    const socket = sockets[0]!
    socket.open()
    socket.receive(welcome({ sessions: [...terminal('a').sessions, ...terminal('b').sessions] }))
    socket.receive({ kind: 'terminalFrame', frame: frame('a', 'A') })
    socket.receive({ kind: 'terminalFrame', frame: frame('b', 'B') })
    expect(client.terminalFrame('a')?.lines).toEqual(['A'])
    expect(client.terminalFrame('b')?.lines).toEqual(['B'])

    socket.receive({ kind: 'terminal', snapshot: terminal('b') })
    expect(client.terminalFrame('a')).toBeUndefined()
    expect(client.terminalFrame('b')?.lines).toEqual(['B'])
    socket.receive({ kind: 'terminalFrame', frame: frame('a', 'orphan') })
    expect(client.terminalFrame('a')).toBeUndefined()
    expect(received).toEqual(['a', 'b'])

    socket.receive(welcome(terminal('c')))
    expect(client.terminalFrame('b')).toBeUndefined()
    socket.receive({ kind: 'terminalFrame', frame: frame('c', 'C') })
    expect(client.terminalFrame('c')?.lines).toEqual(['C'])
    socket.close()
    expect(client.terminalFrame('c')).toBeUndefined()
    expect(client.getSnapshot().terminal).toBeUndefined()
    client.dispose()
  })

  it('does not carry an incomplete frame assembly into a new socket generation', () => {
    const { client, sockets } = fakeClient()
    client.connect('http://localhost:4817', token)
    const first = sockets[0]!
    first.open()
    first.receive(welcome(terminal('a')))
    const payload = JSON.stringify({ kind: 'terminalFrame', frame: frame('a', 'generation-safe') })
    const split = Math.floor(payload.length / 2)
    first.receiveRaw(JSON.stringify({ kind: 'frame', id: 'shared', index: 0, count: 2, data: payload.slice(0, split) }))

    client.connect('http://localhost:4817', token)
    const second = sockets[1]!
    second.open()
    second.receive(welcome(terminal('a')))
    expect(client.getSnapshot().status).toBe('open')
    second.receiveRaw(JSON.stringify({ kind: 'frame', id: 'shared', index: 1, count: 2, data: payload.slice(split) }))
    expect(client.terminalFrame('a')).toBeUndefined()
    client.dispose()
  })
})

describe('pairing credentials', () => {
  it('ignores legacy query tokens and keeps credentials out of websocket URLs', () => {
    const storage = { getItem: (key: string) => key === 'heddlework.token' ? 'stored-token' : 'http://stored.example' }
    expect(readConnectionSettings('?host=http://query.example&token=query-token', storage, 'http://origin.example')).toEqual({ host: 'http://query.example', token: 'stored-token' })
    expect(readConnectionSettings('?token=query-token', storage, 'http://origin.example', '#host=http://fragment.example&token=fragment-token')).toEqual({ host: 'http://fragment.example', token: 'fragment-token' })
    const socketUrl = workspaceSocketUrl(`https://workbench.example/base?token=${token}`)
    expect(socketUrl).toBe('wss://workbench.example/base/ws')
    expect(socketUrl).not.toContain(token)
  })

  it('sends pairing auth only in the websocket subprotocol', () => {
    let openedUrl = ''
    let openedProtocols: string[] | undefined
    const client = new WorkspaceClient((url, protocols) => { openedUrl = url; openedProtocols = protocols; return new FakeSocket() as unknown as WebSocket })
    client.connect('http://localhost:4817/?token=legacy', token)
    expect(openedUrl).toBe('ws://localhost:4817/ws')
    expect(openedProtocols).toEqual(['heddlework-v2', `auth.${token}`])
    client.dispose()
  })
})
