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
    this.emitStatus({ state: 'running', pid: 1 })
  }

  async stop(): Promise<void> {
    this.emitStatus({ state: 'stopped' })
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
    for (const listener of this.#statuses) listener(status)
  }
}

function textDeltaEvent(delta: string): RpcRecord {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } }
}

async function createController(): Promise<{ controller: WorkbenchController; transport: ScriptedTransport }> {
  const transport = new ScriptedTransport()
  const controller = new WorkbenchController(transport, '/tmp/stream-delta-workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
  await controller.start()
  return { controller, transport }
}

describe('WorkbenchController stream delta batching', () => {
  it('applies a delta burst to state and coalesces notifications', async () => {
    const { controller, transport } = await createController()
    try {
      await Bun.sleep(120)
      transport.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
      let notifications = 0
      controller.subscribe(() => { notifications += 1 })
      for (let index = 0; index < 50; index += 1) transport.emit(textDeltaEvent('x'))
      // State is current immediately (applied per event)...
      expect(controller.getSnapshot().liveAssistant?.blocks.at(-1)?.text).toBe('x'.repeat(50))
      // ...while the burst coalesces into one trailing listener notification.
      await Bun.sleep(60)
      expect(notifications).toBe(1)
    } finally {
      await controller.dispose()
    }
  })

  it('notifies editor subscribers immediately without touching the shell', async () => {
    const { controller } = await createController()
    try {
      await Bun.sleep(120)
      let editor = 0
      let shell = 0
      controller.subscribeEditor(() => { editor += 1 })
      controller.subscribeShell(() => { shell += 1 })
      controller.setEditorText('hello from the composer')
      expect(editor).toBe(1)
      expect(shell).toBe(0)
      expect(controller.getEditorSnapshot().editorText).toBe('hello from the composer')
    } finally {
      await controller.dispose()
    }
  })
})
