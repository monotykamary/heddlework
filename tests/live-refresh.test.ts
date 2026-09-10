import { describe, expect, it } from 'bun:test'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { PiMessage, PiSessionState, RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

class LiveTransport implements AgentTransport {
  state: PiSessionState = { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'live-test' }
  messages: PiMessage[] = []
  stateGate: Promise<PiSessionState> | undefined
  messagesGate: Promise<{ messages: PiMessage[] }> | undefined
  messagesError: Error | undefined
  messageReads = 0
  readonly requests: RpcCommand[] = []
  readonly events = new Set<(event: RpcRecord) => void>()

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  send(): void {}
  getStderr(): string { return '' }
  onStatus(_callback: (status: TransportStatus) => void): () => void { return () => undefined }
  onEvent(callback: (event: RpcRecord) => void): () => void { this.events.add(callback); return () => this.events.delete(callback) }

  emit(event: RpcRecord): void {
    if (event.type === 'agent_start') this.state = { ...this.state, isStreaming: true }
    if (event.type === 'agent_settled') this.state = { ...this.state, isStreaming: false }
    for (const callback of this.events) callback(event)
  }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    this.requests.push(command)
    if (command.type === 'get_state') return await (this.stateGate ?? this.state) as T
    if (command.type === 'get_messages') {
      this.messageReads += 1
      if (this.messagesError) throw this.messagesError
      return await (this.messagesGate ?? { messages: this.messages }) as T
    }
    if (command.type === 'get_tree') return undefined as T
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_commands') return { commands: [] } as T
    if (command.type === 'get_fork_messages') return { messages: [] } as T
    if (command.type === 'get_session_stats') return {} as T
    return undefined as T
  }
}

function createController(transport: LiveTransport): WorkbenchController {
  return new WorkbenchController(transport, '/tmp/live-refresh-test', {
    sessionCatalog: { list: async () => [], createWorkspaceSession: async () => { throw new Error('unused') } },
    workspaceDiff: { load: async () => ({ status: 'ready', branch: '', files: [], additions: 0, deletions: 0 }) },
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected refresh did not settle')
    await Bun.sleep(5)
  }
}

describe('live refresh correctness', () => {
  it('keeps a newer response and tool when an older transcript refresh finishes late', async () => {
    const transport = new LiveTransport()
    const controller = createController(transport)
    await controller.start()
    const oldAssistant: PiMessage = { role: 'assistant', content: 'old response', timestamp: 1 }
    const gate = deferred<{ messages: PiMessage[] }>()
    try {
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_start', message: oldAssistant })
      transport.messagesGate = gate.promise
      transport.emit({ type: 'message_end', message: oldAssistant })
      await waitFor(() => transport.messageReads === 2)

      transport.emit({ type: 'message_start', message: { role: 'assistant', timestamp: 2, content: [] } })
      transport.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'new response' } })
      transport.emit({ type: 'tool_execution_start', toolCallId: 'new-tool', toolName: 'read' })
      gate.resolve({ messages: [oldAssistant] })

      await waitFor(() => controller.getSnapshot().messages.length === 1)
      expect(controller.getSnapshot().liveAssistant?.blocks[0]?.text).toBe('new response')
      expect(controller.getSnapshot().liveTools[0]?.id).toBe('new-tool')
    } finally {
      gate.resolve({ messages: [] })
      await controller.dispose()
    }
  })

  it('discards an old transcript that resolves after a newer turn settles', async () => {
    const transport = new LiveTransport()
    const controller = createController(transport)
    await controller.start()
    const oldAssistant: PiMessage = { role: 'assistant', content: 'old response', timestamp: 10 }
    const newAssistant: PiMessage = { role: 'assistant', content: 'completed response', timestamp: 20 }
    const gate = deferred<{ messages: PiMessage[] }>()
    try {
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_start', message: oldAssistant })
      transport.messagesGate = gate.promise
      transport.emit({ type: 'message_end', message: oldAssistant })
      await waitFor(() => transport.messageReads === 2)

      transport.emit({ type: 'agent_settled' })
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 20 } })
      transport.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'completed response' } })
      transport.messages = [newAssistant]
      transport.emit({ type: 'message_end', message: newAssistant })
      transport.emit({ type: 'agent_settled' })

      gate.resolve({ messages: [oldAssistant] })
      transport.messagesGate = undefined
      await gate.promise
      await Promise.resolve()
      await Promise.resolve()
      expect(controller.getSnapshot().messages).not.toEqual([oldAssistant])
      expect(controller.getSnapshot().liveAssistant?.blocks[0]?.text).toBe('completed response')

      await waitFor(() => controller.getSnapshot().messages[0]?.timestamp === 20)
      expect(controller.getSnapshot().liveAssistant).toBeUndefined()
    } finally {
      gate.resolve({ messages: [] })
      await controller.dispose()
    }
  })

  it('clears stale live rows as soon as an unraced idle bootstrap is confirmed', async () => {
    const transport = new LiveTransport()
    const controller = createController(transport)
    await controller.start()
    try {
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 30 } })
      transport.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'stale overlay' } })
      transport.emit({ type: 'tool_execution_start', toolCallId: 'stale-tool', toolName: 'read' })
      transport.messagesError = new Error('transcript unavailable')
      transport.emit({ type: 'agent_settled' })

      await waitFor(() => transport.messageReads === 2)
      expect(controller.getSnapshot().session.isStreaming).toBe(false)
      expect(controller.getSnapshot().liveAssistant).toBeUndefined()
      expect(controller.getSnapshot().liveTools).toEqual([])
    } finally {
      await controller.dispose()
    }
  })

  it('does not let a stale idle bootstrap clear a stream or dispatch queued work', async () => {
    const transport = new LiveTransport()
    const gate = deferred<PiSessionState>()
    transport.stateGate = gate.promise
    const controller = createController(transport)
    controller.queueInput('wait for this live turn')
    const starting = controller.start()
    try {
      await Bun.sleep(0)
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'in progress' }], timestamp: 5 } })
      gate.resolve({ model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'live-test' })
      await starting

      expect(controller.getSnapshot().session.isStreaming).toBe(true)
      expect(controller.getSnapshot().liveAssistant?.blocks[0]?.text).toBe('in progress')
      expect(controller.getSnapshot().queue.items[0]?.text).toBe('wait for this live turn')
      expect(transport.requests.some((request) => request.type === 'prompt')).toBe(false)
    } finally {
      gate.resolve(transport.state)
      await starting
      await controller.dispose()
    }
  })

  it('collapses a delta burst but publishes the settled boundary immediately', async () => {
    const transport = new LiveTransport()
    const controller = createController(transport)
    await controller.start()
    let notifications = 0
    const unsubscribe = controller.subscribe(() => { notifications += 1 })
    try {
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 20 } })
      for (let index = 0; index < 100; index += 1) {
        transport.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } })
      }
      expect(controller.getSnapshot().liveAssistant?.blocks[0]?.text).toHaveLength(100)
      expect(notifications).toBe(1)

      transport.emit({ type: 'agent_settled' })
      expect(notifications).toBe(2)
      expect(controller.getSnapshot().session.isStreaming).toBe(false)
    } finally {
      unsubscribe()
      await controller.dispose()
    }
  })
})
