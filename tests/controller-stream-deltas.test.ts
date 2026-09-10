import { describe, expect, it } from 'bun:test'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

class ScriptedTransport implements AgentTransport {
  readonly #events = new Set<(event: RpcRecord) => void>()
  readonly #statuses = new Set<(status: TransportStatus) => void>()

  async start(): Promise<void> {
    this.#emitStatus({ state: 'running', pid: 1 })
  }

  async stop(): Promise<void> {
    this.#emitStatus({ state: 'stopped' })
  }

  onEvent(listener: (event: RpcRecord) => void): () => void {
    this.#events.add(listener)
    return () => { this.#events.delete(listener) }
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.#statuses.add(listener)
    return () => { this.#statuses.delete(listener) }
  }

  getStderr(): string {
    return ''
  }

  send(_record: RpcRecord): void {}

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    switch (command.type) {
      case 'get_state':
        return { model: null, thinkingLevel: 'off', isStreaming: false } as T
      case 'get_available_models':
        return { models: [] } as T
      case 'get_available_thinking_levels':
        return { levels: ['off'] } as T
      case 'get_session_stats':
        return { sessionId: 'scripted', totalMessages: 0, toolCalls: 0, cost: 0 } as T
      case 'get_fork_messages':
        return { messages: [] } as T
      case 'get_commands':
        return { commands: [] } as T
      default:
        return undefined as T
    }
  }

  emit(event: RpcRecord): void {
    for (const listener of this.#events) listener(event)
  }

  emitStatus(status: TransportStatus): void {
    this.#emitStatus(status)
  }

  #emitStatus(status: TransportStatus): void {
    for (const listener of this.#statuses) listener(status)
  }
}

function textDeltaEvent(delta: string): RpcRecord {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } }
}

async function createController(streamDeltaFrameMs = 4): Promise<{ controller: WorkbenchController; transport: ScriptedTransport }> {
  const transport = new ScriptedTransport()
  const controller = new WorkbenchController(transport, '/tmp/stream-delta-workspace', {
    ...testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })),
    streamDeltaFrameMs,
  })
  await controller.start()
  return { controller, transport }
}

describe('WorkbenchController stream delta coalescing', () => {
  it('collapses a burst of deltas into one frame-bounded state update', async () => {
    const { controller, transport } = await createController()
    try {
      // Let start()'s deferred session-list and workspace-diff refreshes
      // finish notifying before the burst is measured.
      await Bun.sleep(120)
      transport.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
      let notifications = 0
      controller.subscribe(() => { notifications += 1 })
      for (let index = 0; index < 50; index += 1) transport.emit(textDeltaEvent('x'))
      // The burst is queued, not applied: no notification and no live text yet.
      expect(notifications).toBe(0)
      expect(controller.getSnapshot().liveAssistant?.blocks.at(-1)?.text ?? '').toBe('')
      await Bun.sleep(60)
      expect(controller.getSnapshot().liveAssistant?.blocks.at(-1)?.text).toBe('x'.repeat(50))
      // One flush for the whole burst, not one update per delta.
      expect(notifications).toBe(1)
    } finally {
      await controller.dispose()
    }
  })

  it('flushes queued deltas before later non-delta events to preserve order', async () => {
    const { controller, transport } = await createController()
    try {
      transport.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
      for (let index = 0; index < 10; index += 1) transport.emit(textDeltaEvent('y'))
      transport.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} })
      const snapshot = controller.getSnapshot()
      expect(snapshot.liveAssistant?.blocks.at(-1)?.text).toBe('y'.repeat(10))
      expect(snapshot.liveTools.map((tool) => tool.id)).toEqual(['t1'])
      expect(snapshot.liveTools[0]?.status).toBe('running')
    } finally {
      await controller.dispose()
    }
  })

  it('drops queued deltas when the transport exits so a dead turn cannot resurface', async () => {
    const { controller, transport } = await createController()
    try {
      transport.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
      transport.emit({ type: 'agent_start' })
      transport.emit(textDeltaEvent('gone'))
      transport.emitStatus({ state: 'exited', message: 'Pi exited' })
      await Bun.sleep(60)
      expect(controller.getSnapshot().liveAssistant?.blocks.at(-1)?.text ?? '').toBe('')
      expect(controller.getSnapshot().connection).toBe('error')
    } finally {
      await controller.dispose()
    }
  })

  it('does not notify shell subscribers for editor-only patches', async () => {
    const { controller } = await createController()
    try {
      await Bun.sleep(120)
      let shell = 0
      controller.subscribeShell(() => { shell += 1 })
      controller.setEditorText('hello from the composer')
      expect(shell).toBe(0)
      expect(controller.getEditorSnapshot().editorText).toBe('hello from the composer')
      expect(controller.getShellSnapshot().editorText).not.toBe('hello from the composer')
    } finally {
      await controller.dispose()
    }
  })

  it('flushes pending deltas on dispose so the final state stays truthful', async () => {
    const { controller, transport } = await createController()
    transport.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    for (let index = 0; index < 5; index += 1) transport.emit(textDeltaEvent('z'))
    await controller.dispose()
    expect(controller.getSnapshot().liveAssistant?.blocks.at(-1)?.text).toBe('z'.repeat(5))
  })
})
