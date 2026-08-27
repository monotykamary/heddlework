import { describe, expect, it } from 'bun:test'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { PiSessionState, RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { moveQueuedInput, parseQueuedControl } from '../src/workbench/queue.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

class QueueTransport implements AgentTransport {
  readonly commands: RpcCommand[] = []
  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()
  streaming = false

  async start(): Promise<void> {
    for (const listener of this.statuses) listener({ state: 'running', pid: process.pid })
  }

  async stop(): Promise<void> {}
  send(): void {}
  getStderr(): string { return '' }
  onEvent(listener: (event: RpcRecord) => void): () => void { this.events.add(listener); return () => this.events.delete(listener) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener) }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    this.commands.push(command)
    if (command.type === 'get_state') {
      return { model: null, thinkingLevel: 'off', isStreaming: this.streaming, sessionId: 'queue-session', sessionFile: '/tmp/queue-session.jsonl' } satisfies PiSessionState as T
    }
    if (command.type === 'get_messages' || command.type === 'get_fork_messages') return { messages: [] } as T
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_session_stats') return { sessionId: 'queue-session', totalMessages: 0, toolCalls: 0, cost: 0 } as T
    if (command.type === 'prompt' && !command.streamingBehavior) {
      this.streaming = true
      this.emit({ type: 'agent_start' })
    }
    if (command.type === 'abort') {
      this.streaming = false
      this.emit({ type: 'agent_settled' })
    }
    if (command.type === 'new_session' || command.type === 'switch_session') return { cancelled: false } as T
    return undefined as T
  }

  settle(stopReason: 'stop' | 'error' = 'stop'): void {
    this.streaming = false
    this.emit({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason }], willRetry: false })
    this.emit({ type: 'agent_settled' })
  }

  private emit(event: RpcRecord): void {
    for (const listener of this.events) listener(event)
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe('owned workbench queue', () => {
  it('stages stopped submissions without starting Pi and resumes from the parked head', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-stopped', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('/new', { queue: true })
      await controller.submit('Start only when resumed', { queue: true })
      expect(controller.getSnapshot().session.isStreaming).toBe(false)
      expect(controller.getSnapshot().queue.paused).toBe(true)
      expect(controller.getSnapshot().queue.pauseReason).toBe('manual')
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['/new', 'Start only when resumed'])
      expect(transport.commands.filter((command) => command.type === 'prompt')).toHaveLength(0)

      controller.resumeQueue()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Start only when resumed')
        && controller.getSnapshot().queue.items.length === 0, 'the resumed prompt')
      expect(transport.commands.some((command) => command.type === 'new_session')).toBe(true)
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({ message: 'Start only when resumed' })
      expect(controller.getSnapshot().queue.items).toEqual([])
    } finally {
      await controller.dispose()
    }
  })

  it('keeps twenty raw rows editable and reorderable, steers explicitly, and pauses across abort', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-workspace', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start the active run')
      expect(controller.getSnapshot().session.isStreaming).toBe(true)

      for (let index = 1; index <= 20; index += 1) {
        controller.setEditorText(index === 1 ? '/skill:review keep this shorthand' : `Queued task ${index}`)
        await controller.submit(controller.getSnapshot().editorText)
      }
      expect(controller.getSnapshot().queue.items).toHaveLength(20)
      expect(transport.commands.filter((command) => command.type === 'prompt')).toHaveLength(1)

      const slash = controller.getSnapshot().queue.items[0]!
      const last = controller.getSnapshot().queue.items.at(-1)!
      controller.updateQueuedInput(slash.id, '/skill:review edited before expansion')
      controller.moveQueuedInput(last.id, 0)
      expect(controller.getSnapshot().queue.items[0]?.id).toBe(last.id)
      expect(controller.getSnapshot().queue.items[1]?.text).toBe('/skill:review edited before expansion')

      await controller.steerQueuedInput(slash.id)
      const steer = transport.commands.filter((command) => command.type === 'prompt').at(-1)!
      expect(steer).toMatchObject({ type: 'prompt', message: '/skill:review edited before expansion', streamingBehavior: 'steer' })
      expect(controller.getSnapshot().queue.items.some((item) => item.id === slash.id)).toBe(false)
      expect(controller.getSnapshot().queue.steering[0]).toBe('/skill:review edited before expansion')

      await controller.abort()
      await waitFor(() => controller.getSnapshot().queue.pauseReason === 'abort', 'the aborted queue to pause')
      expect(controller.getSnapshot().queue.paused).toBe(true)
      expect(controller.getSnapshot().queue.pauseReason).toBe('abort')
      expect(transport.commands.filter((command) => command.type === 'prompt')).toHaveLength(2)

      controller.resumeQueue()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Queued task 20')
        && !controller.getSnapshot().queue.items.some((item) => item.id === last.id), 'the queue to resume')
      const resumed = transport.commands.filter((command) => command.type === 'prompt').at(-1)!
      expect(resumed).toMatchObject({ type: 'prompt', message: 'Queued task 20' })
      expect('streamingBehavior' in resumed).toBe(false)
      expect(controller.getSnapshot().queue.items.some((item) => item.id === last.id)).toBe(false)
    } finally {
      await controller.dispose()
    }
  })

  it('dispatches exactly one queued row at each healthy settled boundary', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-drain', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      await controller.submit('/fabric prewalk')
      await controller.submit('Implement after prewalk')

      transport.settle()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === '/fabric prewalk')
        && controller.getSnapshot().queue.items.length === 1, 'the first queued prompt')
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({ message: '/fabric prewalk' })
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['Implement after prewalk'])

      transport.settle()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Implement after prewalk')
        && controller.getSnapshot().queue.items.length === 0, 'the second queued prompt')
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({ message: 'Implement after prewalk' })
      expect(controller.getSnapshot().queue.items).toEqual([])
    } finally {
      await controller.dispose()
    }
  })

  it('runs built-in controls in place and leaves extension commands raw', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-controls', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      await controller.submit('/compact focus on decisions')
      await controller.submit('/model provider/model')
      await controller.submit('/thinking off')
      await controller.submit('/new')
      await controller.submit('/reload')
      await controller.submit('/fabric prewalk')
      await controller.submit('Implement after controls')

      transport.settle()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === '/fabric prewalk')
        && controller.getSnapshot().queue.items.length === 1
        && controller.getSnapshot().queue.items[0]?.text === 'Implement after controls', 'the queued controls and extension command')
      const controlCommands = transport.commands.filter((command) => ['compact', 'set_model', 'set_thinking_level', 'new_session', 'switch_session'].includes(command.type))
      expect(controlCommands.map((command) => command.type)).toEqual(['compact', 'set_model', 'set_thinking_level', 'new_session', 'switch_session'])
      expect(controlCommands[0]).toMatchObject({ type: 'compact', customInstructions: 'focus on decisions' })
      expect(controlCommands.at(-1)).toMatchObject({ type: 'switch_session', sessionPath: '/tmp/queue-session.jsonl' })
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({ message: '/fabric prewalk' })
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['Implement after controls'])
    } finally {
      await controller.dispose()
    }
  })

  it('treats image-bearing slash text as a message instead of a control row', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-image-control', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      controller.queueInput('/new', [{ id: 'image-1', type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', previewPath: '/tmp/image.png', fileName: 'image.png', size: 5 }])
      transport.settle()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === '/new')
        && controller.getSnapshot().queue.items.length === 0, 'the image-bearing slash prompt')
      expect(transport.commands.filter((command) => command.type === 'new_session')).toHaveLength(0)
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({
        type: 'prompt',
        message: '/new',
        images: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      })
    } finally {
      await controller.dispose()
    }
  })

  it('holds the tail after a terminal run error', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-error', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      await controller.submit('Do not run after an error')
      transport.settle('error')
      await waitFor(() => controller.getSnapshot().queue.pauseReason === 'error', 'the errored queue to pause')
      expect(controller.getSnapshot().queue.paused).toBe(true)
      expect(controller.getSnapshot().queue.pauseReason).toBe('error')
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['Do not run after an error'])
      expect(transport.commands.filter((command) => command.type === 'prompt')).toHaveLength(1)

      controller.acceptAgentEvent({ type: 'agent_start' })
      controller.acceptAgentEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'stop' }], willRetry: false })
      controller.acceptAgentEvent({ type: 'agent_settled' })
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Do not run after an error')
        && controller.getSnapshot().queue.items.length === 0, 'the recovered queue prompt')
      expect(controller.getSnapshot().queue.paused).toBe(false)
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({ message: 'Do not run after an error' })
    } finally {
      await controller.dispose()
    }
  })

  it('moves stable rows without mutating the source array', () => {
    expect(parseQueuedControl('/compact focus')).toEqual({ kind: 'compact', instructions: 'focus' })
    expect(parseQueuedControl('/model openai/gpt-5')).toEqual({ kind: 'model', target: 'openai/gpt-5' })
    expect(parseQueuedControl('/skill:review')).toBeUndefined()
    const rows = ['a', 'b', 'c'].map((id, index) => ({ id, text: id, images: [], createdAt: index }))
    const moved = moveQueuedInput(rows, 'c', 0)
    expect(moved.map((row) => row.id)).toEqual(['c', 'a', 'b'])
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })
})
