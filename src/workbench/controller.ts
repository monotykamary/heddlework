import { resolve } from 'node:path'
import { isCurrentPiSession, type PiSessionSummary } from '../pi/session-catalog.ts'
import { parseBuiltinSlashCommand, slashCommandsFromRpc, type ParsedBuiltinSlashCommand } from '../pi/slash-commands.ts'
import {
  PiSessionHistoryPager,
  SESSION_HISTORY_PAGE_CONVERSATION_MESSAGES,
  SESSION_HISTORY_PAGE_MAX_MESSAGES,
  SESSION_HISTORY_PAGE_MESSAGES,
  type SessionHistoryPage,
} from '../pi/session-history.ts'
import {
  sessionTreeFrom,
  sessionTreeLeafDescendsFrom,
  sessionTreeOptions,
  treeNavigationLeavesBranch,
  type PiSessionTree,
} from '../pi/session-tree.ts'
import type { AgentTransport, TransportStatus } from '../pi/transport.ts'
import {
  encodeFabricBridgeRequest,
  parseFabricBridgeEvent,
  type FabricBridgeEvent,
  type FabricPeerCard,
} from '../pi/fabric-bridge.ts'
import {
  errorMessage,
  isExtensionUiRequest,
  type ComposerImage,
  type PiForkMessage,
  type PiMessage,
  type PiModel,
  type PiSessionState,
  type PiSessionStats,
  type RpcRecord,
  type RpcSlashCommand,
  type ThinkingLevel,
} from '../pi/types.ts'
import {
  addNotice,
  applyRpcEvent,
  contentText,
  createInitialState,
  type NoticeKind,
  type ThreadPriority,
  type WorkbenchState,
  type WorkbenchUiRequest,
} from './state.ts'
import {
  createQueueState,
  moveQueuedInput,
  moveQueuedInputToLaneTail,
  queueLaneHead,
  queuedInputControl,
  type QueuedControl,
  type QueuedInput,
  type QueueInputDraft,
  type QueueLane,
} from './queue.ts'
import type { QueueStoreService } from './queue-store.ts'
import { normalizeThreadLabels, type ThreadMetadataStoreService } from './thread-metadata-store.ts'
import type { AskUserSubmissionAnswer } from './ask-user.ts'
import { WorkbenchDialogCoordinator } from './dialog-coordinator.ts'
import type { SessionCatalogService, WorkspaceDiffService } from './services.ts'

const SESSION_PAGE_SIZE = 120
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 15_000
const MAX_RECONNECT_ATTEMPTS = 10
// Stream deltas (live assistant/tool text) are projection-only state, so they
// apply at frame cadence: token-rate events collapse into one state update per
// frame instead of one per token. Any other event flushes the queue first to
// keep transcript ordering, and session transitions drop deltas that belong to
// the previous live turn. The terminal service frames its output the same way.
const STREAM_DELTA_FRAME_MS = 32
const HISTORY_NAVIGATION_LOAD_OPTIONS = {
  minimumConversationMessages: SESSION_HISTORY_PAGE_CONVERSATION_MESSAGES,
  maximumMessages: SESSION_HISTORY_PAGE_MAX_MESSAGES,
} as const

export interface NavigateTreeOptions {
  summarize?: boolean | undefined
  customInstructions?: string | undefined
  replaceInstructions?: boolean | undefined
  label?: string | undefined
  preserveQueue?: boolean | undefined
}

export interface WorkbenchControllerDependencies {
  sessionCatalog: SessionCatalogService
  workspaceDiff: WorkspaceDiffService
  transportEvents?: 'direct' | 'external'
  transportOwnership?: 'controller' | 'provider'
  queueStore?: QueueStoreService | undefined
  threadMetadataStore?: ThreadMetadataStoreService | undefined
  /** Stream-delta frame cadence in milliseconds; tests may tighten it. */
  streamDeltaFrameMs?: number | undefined
}

export class WorkbenchController {
  readonly #transport: AgentTransport
  readonly #sessionCatalog: SessionCatalogService
  readonly #workspaceDiff: WorkspaceDiffService
  readonly #queueStore: QueueStoreService | undefined
  readonly #threadMetadataStore: ThreadMetadataStoreService | undefined
  readonly #dialogs: WorkbenchDialogCoordinator
  readonly #stopTransportOnDispose: boolean
  readonly #listeners = new Set<() => void>()
  readonly #shellListeners = new Set<() => void>()
  readonly #editorListeners = new Set<() => void>()
  #state: WorkbenchState
  #shellSnapshot: WorkbenchState
  #editorSnapshot: { editorText: string; editorImages: ComposerImage[] }
  #started = false
  #connecting = false
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectAttempts = 0
  #disposed = false
  #sessionLimit = SESSION_PAGE_SIZE
  #sessionRefresh: Promise<void> | undefined
  #sessionTransitionDepth = 0
  #historyPager: PiSessionHistoryPager | undefined
  #sessionTree: PiSessionTree | undefined
  #nextQueueId = 0
  #nextUiRequestId = 0
  #nextFabricRequestId = 0
  #queueDispatch: Promise<void> | undefined
  readonly #fabricPeerRequests = new Map<string, (peers: FabricPeerCard[]) => void>()
  #compactionHold = false
  #pauseAfterTools = false
  #runGeneration = 0
  #refreshGeneration = 0
  readonly #streamDeltas: RpcRecord[] = []
  #streamDeltaTimer: ReturnType<typeof setTimeout> | undefined
  readonly #streamDeltaFrameMs: number
  #unsubscribeEvent: () => void
  #unsubscribeStatus: () => void

  constructor(transport: AgentTransport, workspacePath: string, dependencies: WorkbenchControllerDependencies) {
    this.#transport = transport
    this.#sessionCatalog = dependencies.sessionCatalog
    this.#workspaceDiff = dependencies.workspaceDiff
    this.#queueStore = dependencies.queueStore
    this.#threadMetadataStore = dependencies.threadMetadataStore
    this.#stopTransportOnDispose = dependencies.transportOwnership !== 'provider'
    this.#streamDeltaFrameMs = dependencies.streamDeltaFrameMs ?? STREAM_DELTA_FRAME_MS
    this.#state = {
      ...createInitialState(workspacePath),
      queue: dependencies.queueStore?.load(workspacePath) ?? createQueueState(),
      threadLifecycle: dependencies.threadMetadataStore?.load() ?? {},
    }
    this.#dialogs = new WorkbenchDialogCoordinator({
      getState: () => this.#state,
      patch: (patch) => this.#patch(patch),
      setState: (update) => this.#setState(update),
      send: (record) => this.#transport.send(record),
    })
    const cachedSessions = this.#sessionCatalog.cached?.(workspacePath, this.#sessionLimit + 1) ?? []
    if (cachedSessions.length > 0) {
      this.#state = { ...this.#state, sessions: cachedSessions.slice(0, this.#sessionLimit), sessionsLoading: true, sessionsHasMore: cachedSessions.length > this.#sessionLimit }
    }
    this.#shellSnapshot = this.#state
    this.#editorSnapshot = { editorText: this.#state.editorText, editorImages: this.#state.editorImages }
    if (dependencies.transportEvents === 'external') {
      this.#unsubscribeEvent = () => undefined
      this.#unsubscribeStatus = () => undefined
    } else {
      this.#unsubscribeEvent = transport.onEvent(this.acceptAgentEvent)
      this.#unsubscribeStatus = transport.onStatus(this.acceptAgentStatus)
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly subscribeShell = (listener: () => void): (() => void) => {
    this.#shellListeners.add(listener)
    return () => this.#shellListeners.delete(listener)
  }

  readonly subscribeEditor = (listener: () => void): (() => void) => {
    this.#editorListeners.add(listener)
    return () => this.#editorListeners.delete(listener)
  }

  readonly getSnapshot = (): WorkbenchState => this.#state
  readonly getShellSnapshot = (): WorkbenchState => this.#shellSnapshot
  readonly getEditorSnapshot = (): { editorText: string; editorImages: ComposerImage[] } => this.#editorSnapshot

  readonly loadEarlierMessages = async (): Promise<void> => {
    const pager = this.#historyPager
    if (!pager || !this.#state.messagesHasOlder || this.#state.messagesLoadingEarlier) return
    this.#patch({ messagesLoadingEarlier: true })
    try {
      const page = await pager.loadEarlier(SESSION_HISTORY_PAGE_MESSAGES, HISTORY_NAVIGATION_LOAD_OPTIONS)
      if (pager !== this.#historyPager) return
      const known = new Set(this.#state.messages.flatMap((message) => messageEntryId(message) ? [messageEntryId(message)!] : []))
      const older = page.messages.filter((message) => !known.has(messageEntryId(message) ?? ''))
      this.#patch({
        messages: [...older, ...this.#state.messages],
        messagesHasOlder: page.hasOlder,
        messagesLoadingEarlier: false,
      })
    } catch (error) {
      if (pager !== this.#historyPager) return
      this.#patch({ messagesHasOlder: false, messagesLoadingEarlier: false })
      this.#setState((state) => addNotice(state, 'warning', `Could not load earlier transcript: ${errorMessage(error)}`))
    }
  }

  readonly acceptAgentEvent = (event: RpcRecord): void => this.#handleEvent(event)
  readonly acceptAgentStatus = (status: TransportStatus): void => this.#handleStatus(status)

    notify(kind: NoticeKind, message: string): void {
    this.#setState((state) => addNotice(state, kind, message))
  }

  async start(): Promise<void> {
    if (this.#started || this.#connecting) return
    this.#clearReconnectTimer()
    this.#connecting = true
    this.#patch({ connection: 'connecting', connectionMessage: 'Starting Pi…' })
    void this.refreshSessions()
    try {
      await this.#transport.start()
      this.#started = true
      await this.#bootstrap(true)
    } catch (error) {
      this.#patch({
        connection: 'error',
        connectionMessage: errorMessage(error),
      })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      this.#scheduleReconnect()
    } finally {
      this.#connecting = false
    }
  }

  async reconnect(): Promise<void> {
    this.#clearReconnectTimer()
    this.#started = false
    await this.#transport.stop()
    await this.start()
  }

  async submit(text: string, options: { queue?: boolean } = {}): Promise<void> {
    const message = text.trim()
    const editorImages = this.#state.editorImages
    if ((!message && editorImages.length === 0) || this.#state.connection !== 'connected') return
    if (editorImages.length === 0 && message === '/queue-drain') {
      this.#patch({ editorText: '', editorImages: [] })
      await this.drainQueueMessages()
      return
    }
    if (editorImages.length === 0 && message === '/pause') {
      this.#patch({ editorText: '', editorImages: [] })
      await this.pause()
      return
    }
    const queuedControl = editorImages.length === 0 ? queuedInputControl({ text: message, images: [] }) : undefined
    if (!options.queue && (queuedControl?.kind === 'fabric-prewalk' || queuedControl?.kind === 'fabric-await')) {
      this.#patch({ editorText: '', editorImages: [] })
      this.queueInput(message, [], { lane: this.#state.session.isStreaming ? 'steer' : 'followUp' })
      this.#drainAvailableQueueLane()
      return
    }
    if (this.#state.session.isStreaming || options.queue) {
      this.#patch({ editorText: '', editorImages: [] })
      this.queueInput(message, editorImages, {
        paused: Boolean(options.queue && !this.#state.session.isStreaming),
        lane: this.#state.session.isStreaming && !options.queue ? 'steer' : 'followUp',
      })
      return
    }
    this.#patch({ editorText: '', editorImages: [] })
    const command = editorImages.length === 0 ? parseBuiltinSlashCommand(message) : undefined
    if (command) {
      await this.#runBuiltinSlashCommand(command, false)
      return
    }
    await this.#sendPrompt(message, editorImages, true)
  }

  queueInput(text: string, images: readonly ComposerImage[] = [], options: { paused?: boolean; lane?: 'steer' | 'followUp' } = {}): QueuedInput | undefined {
    const [item] = this.enqueueQueueInputs([{ text, images, ...(options.lane ? { lane: options.lane } : {}) }], { start: false, ...(options.paused === undefined ? {} : { paused: options.paused }) })
    return item
  }

  enqueueQueueInputs(inputs: readonly QueueInputDraft[], options: { start?: boolean; paused?: boolean } = {}): QueuedInput[] {
    const createdAt = Date.now()
    const items = inputs.flatMap((input, index): QueuedInput[] => {
      const text = input.text.trim()
      const images = input.images ?? []
      if (!text && images.length === 0) return []
      return [{
        id: `queue-${createdAt}-${++this.#nextQueueId}`,
        text,
        images: images.map((image) => ({ ...image })),
        createdAt: createdAt + index,
        ...(input.lane ? { lane: input.lane } : {}),
        ...(input.paused ? { paused: true } : {}),
        ...(input.flow ? { flow: { ...input.flow } } : {}),
      }]
    })
    if (items.length === 0) return []
    const wasEmpty = this.#state.queue.items.length === 0
    const resetPause = wasEmpty && !options.paused
    this.#patch({
      queue: {
        ...this.#state.queue,
        items: [...this.#state.queue.items, ...items],
        ...(options.paused ? { paused: true, pauseReason: 'manual' as const } : {}),
        ...(resetPause ? { paused: false, pauseReason: undefined } : {}),
      },
    })
    if (options.start) this.#drainQueue()
    return items
  }

  hasQueuedFlow(runId: string): boolean {
    return this.#state.queue.items.some((item) => item.flow?.runId === runId)
  }

  removeQueuedFlow(runId: string): void {
    const dispatchingId = this.#state.queue.dispatchingId
    const items = this.#state.queue.items.filter((item) => item.flow?.runId !== runId || item.id === dispatchingId)
    this.#patch({ queue: { ...this.#state.queue, items, ...(items.length === 0 ? { paused: false, pauseReason: undefined } : {}) } })
  }

  updateQueuedInput(id: string, text: string): void {
    const item = this.#state.queue.items.find((candidate) => candidate.id === id)
    if (!item || this.#state.queue.dispatchingId === id) return
    const message = text.trim()
    if (!message && item.images.length === 0) {
      this.removeQueuedInput(id)
      return
    }
    this.#patch({
      queue: {
        ...this.#state.queue,
        items: this.#state.queue.items.map((candidate) => candidate.id === id ? { ...candidate, text: message } : candidate),
      },
    })
  }

  removeQueuedInput(id: string): void {
    if (this.#state.queue.dispatchingId === id) return
    const items = this.#state.queue.items.filter((item) => item.id !== id)
    this.#patch({ queue: { ...this.#state.queue, items, ...(items.length === 0 ? { paused: false, pauseReason: undefined } : {}) } })
  }

  moveQueuedInput(id: string, targetIndex: number): void {
    if (this.#state.queue.dispatchingId) return
    this.#patch({ queue: { ...this.#state.queue, items: moveQueuedInput(this.#state.queue.items, id, targetIndex) } })
  }

  moveQueuedInputToLane(id: string, lane: QueueLane): void {
    if (this.#state.queue.dispatchingId === id) return
    this.#patch({ queue: { ...this.#state.queue, items: moveQueuedInputToLaneTail(this.#state.queue.items, id, lane) } })
    this.#drainAvailableQueueLane()
  }

  toggleQueuedInputPause(id: string): void {
    if (this.#state.queue.dispatchingId === id) return
    const item = this.#state.queue.items.find((candidate) => candidate.id === id)
    if (!item) return
    this.#patch({
      queue: {
        ...this.#state.queue,
        items: this.#state.queue.items.map((candidate) => candidate.id === id ? { ...candidate, paused: !candidate.paused } : candidate),
      },
    })
    if (item.paused) this.#drainAvailableQueueLane()
  }

  async queueFabricPeerGate(): Promise<void> {
    const peers = await this.#requestFabricPeers()
    if (peers.length === 0) {
      this.#setState((state) => addNotice(state, 'warning', 'No live Pi Fabric peers are available'))
      return
    }
    const options = [
      'All active peers',
      ...peers.map((peer) => `${peer.label} · ${peer.status}${peer.model ? ` · ${peer.model}` : ''}`),
    ]
    const peerIds = new Map(options.slice(1).map((option, index) => [option, peers[index]!.id]))
    this.#dialogs.showLocalSelect('Wait for Fabric peers to settle', options, (response) => {
      if (!response.value) return
      const peer = peerIds.get(response.value)
      this.queueInput(`/fabric await${peer ? ` ${peer}` : ''}`, [], { lane: 'followUp' })
      this.#drainAvailableQueueLane()
    })
  }

  cancelBlockingQueueActivity(): void {
    const { dispatchingId, blockingActivity } = this.#state.queue
    if (!dispatchingId || blockingActivity !== 'fabric-await') return
    this.#transport.send({
      type: 'prompt',
      message: encodeFabricBridgeRequest({
        action: 'cancel',
        requestId: this.#newFabricRequestId('cancel'),
        targetId: dispatchingId,
      }),
    })
    const items = this.#state.queue.items.filter((item) => item.id !== dispatchingId)
    this.#patch({
      queue: {
        ...this.#state.queue,
        items,
        paused: items.length > 0,
        pauseReason: items.length > 0 ? 'manual' : undefined,
        dispatchingId: undefined,
        blockingActivity: undefined,
        blockingNote: undefined,
      },
    })
  }

  async steerQueuedInput(id: string): Promise<void> {
    const item = this.#state.queue.items.find((candidate) => candidate.id === id)
    if (!item || !this.#state.session.isStreaming || this.#state.queue.dispatchingId) return
    if (queuedInputControl(item)) return
    this.#patch({ queue: { ...this.#state.queue, dispatchingId: id } })
    try {
      await this.#transport.request({
        type: 'prompt',
        message: item.text,
        ...(item.images.length > 0 ? { images: item.images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })) } : {}),
        streamingBehavior: 'steer',
      })
      this.#patch({
        queue: {
          ...this.#state.queue,
          items: this.#state.queue.items.filter((candidate) => candidate.id !== id),
          steering: [item.text || 'Image attachment', ...this.#state.queue.steering.filter((text) => text !== item.text)],
          dispatchingId: undefined,
        },
      })
    } catch (error) {
      this.#patch({ queue: { ...this.#state.queue, dispatchingId: undefined } })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  resumeQueue(): void {
    this.#pauseAfterTools = false
    this.#patch({ queue: { ...this.#state.queue, paused: false, pauseReason: undefined } })
    this.#drainQueue()
  }

  async drainQueueMessages(): Promise<void> {
    if (this.#state.queue.dispatchingId || this.#compactionHold) {
      this.#setState((state) => addNotice(state, 'warning', 'The queue can drain after the current control or compaction finishes'))
      return
    }
    const messages = this.#state.queue.items.filter((item) => !item.flow && !queuedInputControl(item))
    if (messages.length === 0) {
      this.#setState((state) => addNotice(state, 'info', this.#state.queue.items.length === 0 ? 'Queue is empty' : 'No ordinary message rows can be drained; Flow and control rows keep their boundaries'))
      return
    }
    const ids = new Set(messages.map((item) => item.id))
    const wasStreaming = this.#state.session.isStreaming
    const text = messages.map((item) => item.text).filter(Boolean).join('\n\n')
    const images = messages.flatMap((item) => item.images)
    this.#patch({ queue: { ...this.#state.queue, paused: false, pauseReason: undefined, dispatchingId: messages[0]!.id } })
    try {
      const accepted = wasStreaming
        ? await this.#transport.request({
            type: 'prompt',
            message: text,
            ...(images.length > 0 ? { images: images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })) } : {}),
            streamingBehavior: 'steer',
          }).then(() => true)
        : await this.#sendPrompt(text, images, false)
      if (!accepted) throw new Error('Pi did not accept the drained queue')
      this.#patch({
        queue: {
          ...this.#state.queue,
          items: this.#state.queue.items.filter((item) => !ids.has(item.id)),
          ...(wasStreaming ? { steering: [...this.#state.queue.steering, text || `${images.length} image attachments`] } : {}),
          dispatchingId: undefined,
        },
      })
    } catch (error) {
      this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'error', dispatchingId: undefined } })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async pause(): Promise<void> {
    this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'manual' } })
    if (!this.#state.session.isStreaming) return
    if (this.#state.liveTools.some((tool) => tool.status !== 'complete')) {
      this.#pauseAfterTools = true
      this.#setState((state) => addNotice(state, 'info', 'Pause armed; in-flight tools will finish before Pi stops'))
      return
    }
    try {
      await this.#transport.request({ type: 'abort' })
      this.#patch({ activity: 'Pausing' })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async abort(): Promise<void> {
    this.#pauseAfterTools = false
    this.cancelBlockingQueueActivity()
    if (this.#state.queue.items.length > 0) this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'abort' } })
    try {
      await this.#transport.request({ type: 'abort' })
      this.#patch({ activity: 'Aborting' })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async newSession(): Promise<void> {
    if (this.#state.session.isStreaming) return
    this.#sessionTransitionDepth += 1
    this.#refreshGeneration += 1
    try {
      this.#dialogs.cancelAll()
      this.#discardStreamDeltas()
      const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'new_session' })
      if (result.cancelled) return
      this.#historyPager = undefined
      this.#patch({
        messages: [],
        messagesHasOlder: false,
        messagesLoadingEarlier: false,
        forkMessages: [],
        liveAssistant: undefined,
        liveTools: [],
        editorText: '',
        editorImages: [],
        notices: [],
        statusItems: {},
        widgets: {},
        dialog: undefined,
        dialogQueue: [],
        questionnaireSubmitting: undefined,
        questionnaireCollapsed: undefined,
        queue: createQueueState(),
      })
      await this.#bootstrap(false)
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    } finally {
      this.#sessionTransitionDepth = Math.max(0, this.#sessionTransitionDepth - 1)
      this.#resumeQueueAfterTransition()
    }
  }

  async switchWorkspace(workspacePath: string, options: { confirmed?: boolean } = {}): Promise<void> {
    const target = resolve(workspacePath)
    if (target === resolve(this.#state.workspacePath)) return
    if (this.#state.connection !== 'connected') {
      this.#setState((state) => addNotice(state, 'warning', 'Reconnect Pi before switching sessions'))
      return
    }
    if (this.#state.session.isStreaming && !options.confirmed) {
      this.#patch({ pendingNavigation: { kind: 'workspace', workspacePath: target, runGeneration: this.#runGeneration } })
      return
    }
    this.#patch({ activity: 'Opening project', pendingNavigation: undefined })
    try {
      const session = await this.#sessionCatalog.createWorkspaceSession(target)
      await this.switchSession(session, options.confirmed ? { confirmed: true } : {})
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', `Could not open project: ${errorMessage(error)}`))
    }
  }

  async switchSession(session: PiSessionSummary, options: { confirmed?: boolean } = {}): Promise<void> {
    if (isCurrentPiSession(session, this.#state.session)) return
    if (this.#state.connection !== 'connected') {
      this.#setState((state) => addNotice(state, 'warning', 'Reconnect Pi before switching sessions'))
      return
    }
    if (this.#sessionTransitionDepth > 0) return
    if (this.#state.session.isStreaming && !options.confirmed) {
      this.#patch({ pendingNavigation: { kind: 'session', session, runGeneration: this.#runGeneration } })
      return
    }
    this.#sessionTransitionDepth += 1
    this.#refreshGeneration += 1
    const refreshGeneration = this.#refreshGeneration
    try {
      this.#dialogs.cancelAll()
      this.#discardStreamDeltas()
      this.#patch({ activity: 'Opening thread', pendingNavigation: undefined })
      if (this.#state.session.isStreaming) {
        this.#pauseAfterTools = false
        try {
          await this.#transport.request({ type: 'abort' })
        } catch {
          // switch_session still replaces the live turn; a failed abort must not pin the sidebar
        }
      }
      const result = await this.#transport.request<{ cancelled?: boolean }>({
        type: 'switch_session',
        sessionPath: session.path,
      })
      if (result.cancelled) {
        this.#patch({ activity: 'Ready' })
        return
      }
      const workspacePath = session.cwd ? resolve(session.cwd) : this.#state.workspacePath
      this.#historyPager = undefined
      this.#patch({
        workspacePath,
        messages: [],
        messagesHasOlder: false,
        messagesLoadingEarlier: false,
        forkMessages: [],
        liveAssistant: undefined,
        liveTools: [],
        editorText: '',
        editorImages: [],
        notices: [],
        statusItems: {},
        widgets: {},
        dialog: undefined,
        dialogQueue: [],
        questionnaireSubmitting: undefined,
        questionnaireCollapsed: undefined,
        queue: resolve(workspacePath) === resolve(this.#state.workspacePath) ? this.#state.queue : this.#queueStore?.load(workspacePath) ?? createQueueState(),
        workspaceDiff: { status: 'idle', branch: '', files: [], additions: 0, deletions: 0 },
      })
      await this.#bootstrap(false)
      if (this.#refreshGeneration !== refreshGeneration) return
      if (options.confirmed) this.#setState((state) => addNotice(state, 'info', 'Stopped the previous run to open this thread'))
      void this.refreshSessions()
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    } finally {
      this.#sessionTransitionDepth = Math.max(0, this.#sessionTransitionDepth - 1)
      this.#resumeQueueAfterTransition()
    }
  }

  async confirmPendingNavigation(): Promise<void> {
    const pending = this.#state.pendingNavigation
    if (!pending) return
    if (pending.runGeneration !== this.#runGeneration) {
      this.#patch({ pendingNavigation: undefined })
      return
    }
    this.#patch({ pendingNavigation: undefined })
    if (pending.kind === 'session') await this.switchSession(pending.session, { confirmed: true })
    else await this.switchWorkspace(pending.workspacePath, { confirmed: true })
  }

  cancelPendingNavigation(): void {
    if (!this.#state.pendingNavigation) return
    this.#patch({ pendingNavigation: undefined })
  }

  async refreshSessions(): Promise<void> {
    if (this.#sessionRefresh) return this.#sessionRefresh
    this.#patch({ sessionsLoading: true })
    const task = (async () => {
      try {
        const sessions = await this.#sessionCatalog.list(this.#state.workspacePath, this.#sessionLimit + 1)
        this.#patch({
          sessions: sessions.slice(0, this.#sessionLimit),
          sessionsLoading: false,
          sessionsHasMore: sessions.length > this.#sessionLimit,
        })
      } catch (error) {
        this.#patch({ sessionsLoading: false })
        this.#setState((state) => addNotice(state, 'warning', `Could not list sessions: ${errorMessage(error)}`))
      }
    })().finally(() => {
      if (this.#sessionRefresh === task) this.#sessionRefresh = undefined
    })
    this.#sessionRefresh = task
    return task
  }

  async loadMoreSessions(): Promise<void> {
    if (this.#state.sessionsLoading || !this.#state.sessionsHasMore) return
    this.#sessionLimit += SESSION_PAGE_SIZE
    await this.refreshSessions()
  }

  async openSessionTree(options: { preserveQueue?: boolean } = {}): Promise<void> {
    if (this.#state.session.isStreaming) return
    try {
      const sessionTree = await this.#requestSessionTree()
      const selections = sessionTreeOptions(sessionTree)
      if (selections.length === 0) {
        this.#setState((state) => addNotice(state, 'warning', 'The current Pi session tree is empty'))
        return
      }
      this.#dialogs.showLocalTree('Navigate session tree\nSelect any point to continue in this session', selections, (response) => {
        if (response.value) this.#chooseTreeNavigation(sessionTree, response.value, options.preserveQueue ?? false)
      })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'warning', errorMessage(error)))
    }
  }

  async navigateTree(entryId: string, options: NavigateTreeOptions = {}): Promise<void> {
    if (!entryId || this.#state.session.isStreaming) return
    this.#patch({ activity: options.summarize ? 'Summarizing branch' : 'Navigating session tree' })
    try {
      const result = await this.#transport.request<{ cancelled?: boolean; editorText?: string }>({
        type: 'navigate_tree',
        entryId,
        ...(options.summarize === undefined ? {} : { summarize: options.summarize }),
        ...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
        ...(options.replaceInstructions === undefined ? {} : { replaceInstructions: options.replaceInstructions }),
        ...(options.label === undefined ? {} : { label: options.label }),
      })
      if (result.cancelled) {
        this.#patch({ activity: 'Ready' })
        return
      }
      this.#historyPager = undefined
      this.#patch({ notices: [], queue: options.preserveQueue ? this.#state.queue : createQueueState() })
      await this.#bootstrap(false)
      if (result.editorText !== undefined) this.#patch({ editorText: result.editorText, editorImages: [] })
      this.#setState((state) => addNotice(state, 'info', 'Navigated within the current Pi session'))
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  #chooseTreeNavigation(sessionTree: PiSessionTree, entryId: string, preserveQueue: boolean): void {
    if (!treeNavigationLeavesBranch(sessionTree, entryId)) {
      void this.navigateTree(entryId, { preserveQueue })
      return
    }
    const withoutSummary = 'Continue without summary — Keep the abandoned branch only in session history'
    const withSummary = 'Summarize abandoned branch — Carry its important context onto the selected branch'
    const withCustomSummary = 'Summarize with custom focus — Add instructions for what Pi should preserve'
    this.#dialogs.showLocalSelect('Leave the active branch\nChoose how context should carry forward', [withoutSummary, withSummary, withCustomSummary], (response) => {
      if (response.value === withoutSummary) {
        void this.navigateTree(entryId, { preserveQueue })
      } else if (response.value === withSummary) {
        void this.navigateTree(entryId, { summarize: true, preserveQueue })
      } else if (response.value === withCustomSummary) {
        this.#dialogs.showLocalInput('Branch summary focus', 'What should Pi preserve from the branch?', (input) => {
          const customInstructions = input.value?.trim()
          if (customInstructions) void this.navigateTree(entryId, { summarize: true, customInstructions, preserveQueue })
        })
      }
    })
  }

  async cloneSession(): Promise<void> {
    if (this.#state.session.isStreaming) return
    try {
      const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'clone' })
      if (result.cancelled) return
      this.#patch({ notices: [], queue: createQueueState() })
      await this.#bootstrap(false)
      this.#setState((state) => addNotice(state, 'info', 'Cloned thread into a new Pi session'))
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async forkFrom(entryId: string, options: { preserveQueue?: boolean } = {}): Promise<void> {
    if (!entryId || this.#state.session.isStreaming) return
    try {
      const result = await this.#transport.request<{ text?: string; cancelled?: boolean }>({ type: 'fork', entryId })
      if (result.cancelled) return
      this.#patch({ notices: [], queue: options.preserveQueue ? this.#state.queue : createQueueState() })
      await this.#bootstrap(false)
      this.#patch({ editorText: result.text ?? '', editorImages: [] })
      this.#setState((state) => addNotice(state, 'info', 'Branched from the selected turn'))
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async exportSession(): Promise<string | undefined> {
    try {
      const data = await this.#transport.request<{ path: string }>({ type: 'export_html' })
      this.#setState((state) => addNotice(state, 'info', `Exported session to ${data.path}`))
      return data.path
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      return undefined
    }
  }

  async setModel(model: PiModel): Promise<void> {
    try {
      await this.#transport.request({ type: 'set_model', provider: model.provider, modelId: model.id })
      const [session, levels] = await Promise.all([
        this.#transport.request<PiSessionState>({ type: 'get_state' }),
        this.#getThinkingLevels(),
      ])
      this.#patch({ session, thinkingLevels: levels })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    try {
      await this.#transport.request({ type: 'set_thinking_level', level })
      this.#patch({ session: { ...this.#state.session, thinkingLevel: level } })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async compact(): Promise<void> {
    if (this.#state.session.isStreaming) return
    await this.#runBuiltinSlashCommand({ name: 'compact', argument: '' }, false)
  }

  completeUiRequest(id: number): void {
    if (this.#state.uiRequest?.id === id) this.#patch({ uiRequest: undefined })
  }

  setEditorText(text: string): void {
    this.#patch({ editorText: text })
  }

  addEditorImage(image: ComposerImage): void {
    const acceptedInputs = this.#state.session.model?.input
    if (acceptedInputs && !acceptedInputs.includes('image')) {
      this.#setState((state) => addNotice(state, 'warning', 'The selected model does not accept images'))
      return
    }
    if (this.#state.editorImages.some((candidate) => candidate.data === image.data)) return
    if (this.#state.editorImages.length >= 8) {
      this.#setState((state) => addNotice(state, 'warning', 'A prompt can include at most 8 images'))
      return
    }
    this.#patch({ editorImages: [...this.#state.editorImages, image] })
  }

  removeEditorImage(id: string): void {
    this.#patch({ editorImages: this.#state.editorImages.filter((image) => image.id !== id) })
  }

  dismissNotice(id: number): void {
    this.#patch({ notices: this.#state.notices.filter((notice) => notice.id !== id) })
  }

  clearNotices(): void {
    this.#patch({ notices: [] })
  }

  settleThread(path: string): void {
    const current = this.#state.threadLifecycle[path] ?? {}
    const { snoozedUntil: _snoozedUntil, unsettledAt: _unsettledAt, ...retained } = current
    const threadLifecycle = {
      ...this.#state.threadLifecycle,
      [path]: { ...retained, settledAt: Date.now() },
    }
    this.#setState((state) => addNotice({ ...state, threadLifecycle }, 'info', 'Thread moved to Settled'))
  }

  snoozeThread(path: string, snoozedUntil: number): void {
    const current = this.#state.threadLifecycle[path] ?? {}
    const { settledAt: _settledAt, unsettledAt: _unsettledAt, ...retained } = current
    const threadLifecycle = {
      ...this.#state.threadLifecycle,
      [path]: { ...retained, snoozedUntil },
    }
    const time = new Date(snoozedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    this.#setState((state) => addNotice({ ...state, threadLifecycle }, 'info', `Snoozed until ${time}`))
  }

  wakeThread(path: string): void {
    const current = this.#state.threadLifecycle[path] ?? {}
    const { settledAt: _settledAt, snoozedUntil: _snoozedUntil, ...retained } = current
    const threadLifecycle = {
      ...this.#state.threadLifecycle,
      [path]: { ...retained, unsettledAt: Date.now() },
    }
    this.#setState((state) => addNotice({ ...state, threadLifecycle }, 'info', 'Thread returned to Active'))
  }

  setThreadPriority(path: string, priority: ThreadPriority | undefined): void {
    const current = this.#state.threadLifecycle[path] ?? {}
    const { priority: _priority, ...retained } = current
    this.#patch({ threadLifecycle: {
      ...this.#state.threadLifecycle,
      [path]: priority === undefined ? retained : { ...retained, priority },
    } })
  }

  setThreadLabels(path: string, labels: readonly string[]): void {
    const current = this.#state.threadLifecycle[path] ?? {}
    const { labels: _labels, ...retained } = current
    const normalized = normalizeThreadLabels(labels)
    this.#patch({ threadLifecycle: {
      ...this.#state.threadLifecycle,
      [path]: normalized.length === 0 ? retained : { ...retained, labels: normalized },
    } })
  }

  markThreadRead(path: string, updatedAt: number): void {
    this.markThreadsRead([{ path, updatedAt }])
  }

  markThreadsRead(threads: readonly { path: string; updatedAt: number }[]): void {
    let threadLifecycle = this.#state.threadLifecycle
    for (const { path, updatedAt } of threads) {
      const current = threadLifecycle[path] ?? {}
      if ((current.readAt ?? 0) >= updatedAt) continue
      if (threadLifecycle === this.#state.threadLifecycle) threadLifecycle = { ...threadLifecycle }
      threadLifecycle[path] = { ...current, readAt: updatedAt }
    }
    if (threadLifecycle !== this.#state.threadLifecycle) this.#patch({ threadLifecycle })
  }

  async refreshWorkspaceDiff(): Promise<void> {
    const workspacePath = this.#state.workspacePath
    this.#patch({
      workspaceDiff: {
        status: 'loading',
        branch: this.#state.workspaceDiff.branch,
        files: this.#state.workspaceDiff.files,
        additions: this.#state.workspaceDiff.additions,
        deletions: this.#state.workspaceDiff.deletions,
      },
    })
    const workspaceDiff = await this.#workspaceDiff.load(workspacePath)
    if (this.#state.workspacePath === workspacePath) this.#patch({ workspaceDiff })
  }

  respondToDialog(response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    this.#dialogs.respond(response)
  }

  submitAskUserQuestionnaire(toolCallId: string, answers: readonly AskUserSubmissionAnswer[]): void {
    this.#dialogs.submitQuestionnaire(toolCallId, answers)
  }

  cancelAskUserQuestionnaire(toolCallId: string): void {
    this.#dialogs.cancelQuestionnaire(toolCallId)
  }

  setAskUserQuestionnaireCollapsed(toolCallId: string, collapsed: boolean): void {
    this.#dialogs.setQuestionnaireCollapsed(toolCallId, collapsed)
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    this.#flushStreamDeltas()
    this.#clearReconnectTimer()
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
    this.#dialogs.dispose()
    for (const resolvePeers of this.#fabricPeerRequests.values()) resolvePeers([])
    this.#fabricPeerRequests.clear()
    this.#unsubscribeEvent()
    this.#unsubscribeStatus()
    if (this.#stopTransportOnDispose) await this.#transport.stop()
    this.#listeners.clear()
    this.#shellListeners.clear()
    this.#editorListeners.clear()
  }

  async #sendPrompt(message: string, images: readonly ComposerImage[], restoreDraft: boolean): Promise<boolean> {
    const previousMessages = this.#state.messages
    const previousSession = this.#state.session
    const previousActivity = this.#state.activity
    const optimisticContent = images.length > 0
      ? [
          ...(message ? [{ type: 'text' as const, text: message }] : []),
          ...images.map(({ data, mimeType, previewPath }) => ({ type: 'image' as const, data, mimeType, previewPath })),
        ]
      : message
    const optimistic: PiMessage = {
      role: 'user',
      content: optimisticContent,
      timestamp: Date.now(),
      workbenchOptimistic: true,
    }
    this.#runGeneration += 1
    this.#patch({
      messages: [...previousMessages, optimistic],
      session: { ...previousSession, isStreaming: true },
      activity: 'Sending',
    })
    try {
      await this.#transport.request({
        type: 'prompt',
        message,
        ...(images.length > 0 ? { images: images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })) } : {}),
      })
      return true
    } catch (error) {
      this.#patch({
        messages: previousMessages,
        session: previousSession,
        activity: previousActivity,
        ...(restoreDraft ? { editorText: message, editorImages: images.map((image) => ({ ...image })) } : {}),
      })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      this.#scheduleRefresh(true)
      return false
    }
  }

  #drainAvailableQueueLane(): void {
    if (this.#state.session.isStreaming) this.#drainSteering()
    else this.#drainQueue()
  }

  #drainSteering(): void {
    if (this.#queueDispatch) return
    const task = this.#drainSteeringHead()
    this.#queueDispatch = task
    void task.finally(() => {
      if (this.#queueDispatch !== task) return
      this.#queueDispatch = undefined
      if (!this.#state.session.isStreaming && this.#hasDispatchableIdleHead()) queueMicrotask(() => this.#drainQueue())
    })
  }

  async #drainSteeringHead(): Promise<void> {
    const { queue, session, connection } = this.#state
    if (queue.paused || queue.dispatchingId || !session.isStreaming || connection !== 'connected' || this.#compactionHold) return
    const item = queueLaneHead(queue.items, 'steer')
    if (!item || item.paused) return
    const control = queuedInputControl(item)
    if (control && control.kind !== 'fabric-prewalk' && control.kind !== 'fabric-await') return
    this.#patch({ queue: { ...queue, dispatchingId: item.id } })
    if (control?.kind === 'fabric-prewalk' || control?.kind === 'fabric-await') {
      await this.#startFabricQueueControl(item, control, true)
      return
    }
    const command = item.images.length === 0 ? parseBuiltinSlashCommand(item.text) : undefined
    try {
      const accepted = command
        ? await this.#runBuiltinSlashCommand(command, true, item)
        : await this.#transport.request({
            type: 'prompt',
            message: item.text,
            ...(item.images.length > 0 ? { images: item.images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })) } : {}),
            streamingBehavior: 'steer',
          }).then(() => true)
      if (!accepted) throw new Error('Pi did not accept the queued steering row')
      this.#patch({
        queue: {
          ...this.#state.queue,
          items: this.#state.queue.items.filter((candidate) => candidate.id !== item.id),
          steering: command ? this.#state.queue.steering : [...this.#state.queue.steering, item.text || 'Image attachment'],
          dispatchingId: undefined,
        },
      })
    } catch (error) {
      this.#failQueueDispatch(error)
    }
  }

  #drainQueue(): void {
    if (this.#queueDispatch) return
    const task = this.#drainQueueHead()
    this.#queueDispatch = task
    void task.finally(() => {
      if (this.#queueDispatch !== task) return
      this.#queueDispatch = undefined
      if (!this.#state.session.isStreaming && this.#hasDispatchableIdleHead()) queueMicrotask(() => this.#drainQueue())
    })
  }

  async #drainQueueHead(): Promise<void> {
    const { queue, session, connection } = this.#state
    if (queue.paused || queue.dispatchingId || session.isStreaming || connection !== 'connected' || this.#compactionHold || this.#sessionTransitionDepth > 0) return
    const steerHead = queueLaneHead(queue.items, 'steer')
    const followUpHead = queueLaneHead(queue.items, 'followUp')
    const item = steerHead && !steerHead.paused ? steerHead : followUpHead && !followUpHead.paused ? followUpHead : undefined
    if (!item) return
    this.#patch({ queue: { ...queue, dispatchingId: item.id } })
    const control = queuedInputControl(item)
    if (control?.kind === 'fabric-prewalk' || control?.kind === 'fabric-await') {
      await this.#startFabricQueueControl(item, control, false)
      return
    }
    const command = item.images.length === 0 ? parseBuiltinSlashCommand(item.text) : undefined
    const accepted = command
      ? await this.#runBuiltinSlashCommand(command, true, item)
      : await this.#sendPrompt(item.text, item.images, false)
    if (!accepted) {
      this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'error', dispatchingId: undefined } })
      return
    }
    this.#patch({
      queue: {
        ...this.#state.queue,
        items: this.#state.queue.items.filter((candidate) => candidate.id !== item.id),
        dispatchingId: undefined,
      },
    })
    if (!command && item.text.startsWith('/')) this.#scheduleRefresh(true)
  }

  #hasDispatchableIdleHead(): boolean {
    const { queue, connection } = this.#state
    if (queue.paused || queue.dispatchingId || this.#state.session.isStreaming || connection !== 'connected' || this.#compactionHold || this.#sessionTransitionDepth > 0) return false
    return [queueLaneHead(queue.items, 'steer'), queueLaneHead(queue.items, 'followUp')]
      .some((item) => item !== undefined && !item.paused)
  }

  async #startFabricQueueControl(item: QueuedInput, control: Extract<QueuedControl, { kind: 'fabric-prewalk' | 'fabric-await' }>, steering: boolean): Promise<void> {
    const activity = control.kind === 'fabric-prewalk' ? 'fabric-prewalk' : 'fabric-await'
    const note = control.kind === 'fabric-prewalk'
      ? 'Arming Fabric prewalk…'
      : control.peer ? `Waiting for ${control.peer} to settle…` : 'Waiting for Fabric peers to settle…'
    this.#patch({ queue: { ...this.#state.queue, blockingActivity: activity, blockingNote: note } })
    try {
      await this.#transport.request({
        type: 'prompt',
        message: encodeFabricBridgeRequest(control.kind === 'fabric-prewalk'
          ? { action: 'prewalk', requestId: item.id }
          : { action: 'await', requestId: item.id, ...(control.peer ? { peer: control.peer } : {}) }),
        ...(steering ? { streamingBehavior: 'steer' as const } : {}),
      })
    } catch (error) {
      if (this.#state.queue.dispatchingId === item.id) this.#failQueueDispatch(error)
    }
  }

  #failQueueDispatch(error: unknown): void {
    this.#patch({
      queue: {
        ...this.#state.queue,
        paused: true,
        pauseReason: 'error',
        dispatchingId: undefined,
        blockingActivity: undefined,
        blockingNote: undefined,
      },
    })
    this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
  }

  async #runBuiltinSlashCommand(command: ParsedBuiltinSlashCommand, queued: boolean, queuedItem?: QueuedInput): Promise<boolean> {
    try {
      switch (command.name) {
        case 'settings':
          this.#requestUi({ kind: 'settings' })
          return true
        case 'model': {
          if (!command.argument) {
            this.#requestUi({ kind: 'model' })
            return true
          }
          const target = resolveModelReference(this.#state.models, command.argument)
          if (!target) {
            this.#setState((state) => addNotice(state, 'warning', 'Use /model provider/model or choose a model from the picker'))
            return false
          }
          await this.#transport.request({ type: 'set_model', ...target })
          await this.#bootstrap(false)
          return true
        }
        case 'thinking': {
          const level = command.argument as ThinkingLevel
          if (!command.argument) {
            this.#requestUi({ kind: 'thinking' })
            return true
          }
          if (!this.#state.thinkingLevels.includes(level)) {
            this.#setState((state) => addNotice(state, 'warning', `Unsupported thinking level: ${command.argument}`))
            return false
          }
          await this.#transport.request({ type: 'set_thinking_level', level })
          await this.#bootstrap(false)
          return true
        }
        case 'export': {
          const outputPath = parsePathArgument(command.argument)
          if (command.argument && !outputPath) {
            this.#setState((state) => addNotice(state, 'warning', 'Usage: /export [file.html]'))
            return false
          }
          if (outputPath?.toLowerCase().endsWith('.jsonl')) {
            this.#setState((state) => addNotice(state, 'warning', 'Pi RPC only exposes HTML export; JSONL branch export remains interactive-only'))
            return true
          }
          const data = await this.#transport.request<{ path?: string }>({ type: 'export_html', ...(outputPath ? { outputPath } : {}) })
          this.#setState((state) => addNotice(state, 'info', data?.path ? `Exported session to ${data.path}` : 'Session exported'))
          return true
        }
        case 'copy': {
          const data = await this.#transport.request<{ text?: string | null }>({ type: 'get_last_assistant_text' })
          if (!data?.text) {
            this.#setState((state) => addNotice(state, 'warning', 'No assistant message to copy yet'))
            return true
          }
          this.#requestUi({ kind: 'copy', text: data.text })
          return true
        }
        case 'name': {
          if (!command.argument) {
            const currentName = this.#state.session.sessionName
            this.#setState((state) => addNotice(state, currentName ? 'info' : 'warning', currentName ? `Session name: ${currentName}` : 'Usage: /name <name>'))
            return true
          }
          await this.#transport.request({ type: 'set_session_name', name: command.argument })
          this.#patch({ session: { ...this.#state.session, sessionName: command.argument } })
          void this.refreshSessions()
          this.#setState((state) => addNotice(state, 'info', `Session name set: ${command.argument}`))
          return true
        }
        case 'session': {
          const stats = await this.#transport.request<PiSessionStats>({ type: 'get_session_stats' })
          this.#patch({ stats })
          this.#setState((state) => addNotice(state, 'info', formatSessionNotice(this.#state.session, stats)))
          return true
        }
        case 'tree':
          await this.openSessionTree({ preserveQueue: queued })
          return true
        case 'fork': {
          const messages = this.#state.forkMessages
          if (messages.length === 0) {
            this.#setState((state) => addNotice(state, 'warning', 'No user messages are available to fork'))
            return true
          }
          const options = messages.map((message, index) => `${index + 1}. ${compactCommandText(message.text)}`)
          const entryIds = new Map(options.map((option, index) => [option, messages[index]!.entryId]))
          this.#dialogs.showLocalSelect('Fork from a previous message', options, (response) => {
            const entryId = response.value ? entryIds.get(response.value) : undefined
            if (entryId) void this.forkFrom(entryId, { preserveQueue: queued })
          })
          return true
        }
        case 'clone': {
          const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'clone' })
          if (result.cancelled) return false
          this.#historyPager = undefined
          this.#patch({ notices: [], queue: queued ? { ...this.#state.queue, steering: [], followUp: [] } : createQueueState() })
          await this.#bootstrap(false)
          this.#setState((state) => addNotice(state, 'info', 'Cloned thread into a new Pi session'))
          return true
        }
        case 'new': {
          this.#sessionTransitionDepth += 1
          try {
            this.#dialogs.cancelAll()
            const parentSession = queuedItem
              ? queuedItem.flow?.phase === 'new-session'
                ? queuedItem.flow.taskIndex > 0 ? this.#state.session.sessionFile : undefined
                : this.#state.session.sessionFile
              : undefined
            const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'new_session', ...(parentSession ? { parentSession } : {}) })
            if (result.cancelled) return false
            this.#historyPager = undefined
            this.#patch({
              messages: [],
              messagesHasOlder: false,
              messagesLoadingEarlier: false,
              forkMessages: [],
              liveAssistant: undefined,
              liveTools: [],
              editorText: '',
              editorImages: [],
              notices: [],
              statusItems: {},
              widgets: {},
              dialog: undefined,
              dialogQueue: [],
              uiRequest: undefined,
              questionnaireSubmitting: undefined,
              questionnaireCollapsed: undefined,
              queue: queued ? { ...this.#state.queue, steering: [], followUp: [] } : createQueueState(),
            })
            await this.#bootstrap(false)
            return true
          } finally {
            this.#sessionTransitionDepth = Math.max(0, this.#sessionTransitionDepth - 1)
            this.#resumeQueueAfterTransition()
          }
        }
        case 'compact': {
          this.#patch({ activity: 'Compacting context' })
          const result = await this.#transport.request({ type: 'compact', ...(command.argument ? { customInstructions: command.argument } : {}) })
          await this.#refreshStats()
          await this.#refreshMessages()
          this.#appendCompactionMessage(result)
          this.#setState((state) => addNotice({ ...state, activity: 'Ready' }, 'info', 'Context compacted'))
          return true
        }
        case 'resume':
          await this.refreshSessions()
          this.#requestUi({ kind: 'sessions' })
          return true
        case 'reload': {
          const sessionFile = this.#state.session.sessionFile
          if (!sessionFile) {
            this.#setState((state) => addNotice(state, 'warning', '/reload requires a persisted Pi session'))
            return false
          }
          this.#connecting = true
          try {
            this.#started = false
            this.#patch({ queue: { ...this.#state.queue, steering: [], followUp: [] } })
            await this.#transport.stop()
            await this.#transport.start()
            this.#started = true
            const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'switch_session', sessionPath: sessionFile })
            if (result.cancelled) {
              await this.#bootstrap(false)
              return false
            }
            await this.#bootstrap(false)
          } finally {
            this.#connecting = false
          }
          return true
        }
        case 'quit':
          this.#requestUi({ kind: 'quit' })
          return true
        case 'scoped-models':
        case 'import':
        case 'share':
        case 'changelog':
        case 'hotkeys':
        case 'trust':
        case 'login':
        case 'logout':
          this.#setState((state) => addNotice(state, 'warning', interactiveOnlyCommandMessage(command.name)))
          return true
      }
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      return false
    }
  }

  #requestUi(request: { kind: 'settings' | 'sessions' | 'model' | 'thinking' | 'quit' } | { kind: 'copy'; text: string }): void {
    const uiRequest = { id: ++this.#nextUiRequestId, ...request } as WorkbenchUiRequest
    this.#patch({ uiRequest })
  }

  async #bootstrap(includeModels: boolean): Promise<void> {
    const refreshGeneration = this.#refreshGeneration
    const stale = () => this.#disposed || this.#refreshGeneration !== refreshGeneration
    const [session, sessionTree] = await Promise.all([
      this.#transport.request<PiSessionState>({ type: 'get_state' }),
      this.#tryRequestSessionTree(),
    ])
    if (stale()) return
    this.#sessionTree = sessionTree
    this.#reconnectAttempts = 0
    this.#patch({
      connection: 'connected',
      connectionMessage: 'Connected',
      session,
      liveAssistant: undefined,
      liveTools: [],
      activity: session.isStreaming ? 'Working' : 'Ready',
    })
    const tasks = await Promise.allSettled([
      this.#loadInitialTranscript(session, sessionTree?.leafId),
      includeModels
        ? this.#transport.request<{ models: PiModel[] }>({ type: 'get_available_models' })
        : Promise.resolve({ models: this.#state.models }),
      this.#getThinkingLevels(),
      this.#transport.request<PiSessionStats>({ type: 'get_session_stats' }),
      this.#transport.request<{ messages: PiForkMessage[] }>({ type: 'get_fork_messages' }),
      this.#transport.request<{ commands: RpcSlashCommand[] }>({ type: 'get_commands' }),
    ])
    const [messagesResult, modelsResult, levelsResult, statsResult, forkMessagesResult, commandsResult] = tasks
    if (stale()) return
    this.#historyPager = messagesResult.status === 'fulfilled' ? messagesResult.value.pager : undefined
    this.#patch({
      messages: messagesResult.status === 'fulfilled' ? messagesResult.value.page.messages : this.#state.messages,
      messagesHasOlder: messagesResult.status === 'fulfilled' ? messagesResult.value.page.hasOlder : false,
      messagesLoadingEarlier: false,
      forkMessages: forkMessagesResult.status === 'fulfilled' ? forkMessagesFrom(forkMessagesResult.value) : this.#state.forkMessages,
      models: modelsResult.status === 'fulfilled' ? modelsResult.value.models : this.#state.models,
      thinkingLevels: levelsResult.status === 'fulfilled' ? levelsResult.value : this.#state.thinkingLevels,
      stats: statsResult.status === 'fulfilled' ? statsResult.value : this.#state.stats,
      commands: commandsResult.status === 'fulfilled' ? slashCommandsFromRpc(commandsResult.value) : this.#state.commands,
    })
    void this.refreshWorkspaceDiff()
    if (!session.isStreaming) this.#resumeQueueAfterTransition()
  }

  // A transition blocks draining while it is in flight; once the outermost one
  // finishes, queued input must get another chance instead of idling forever.
  #resumeQueueAfterTransition(): void {
    if (this.#sessionTransitionDepth > 0) return
    queueMicrotask(() => {
      if (this.#sessionTransitionDepth === 0 && !this.#state.session.isStreaming) this.#drainQueue()
    })
  }

  async #loadInitialTranscript(session: PiSessionState, leafId?: string | null): Promise<{ page: SessionHistoryPage; pager: PiSessionHistoryPager | undefined }> {
    if (session.sessionFile) {
      const pager = new PiSessionHistoryPager(session.sessionFile, leafId)
      try {
        const page = await pager.loadEarlier(SESSION_HISTORY_PAGE_MESSAGES, HISTORY_NAVIGATION_LOAD_OPTIONS)
        return { page, pager }
      } catch {
        // Fall through to RPC for unsaved, unavailable, or legacy sessions.
      }
    }
    const result = await this.#transport.request<{ messages: PiMessage[] }>({ type: 'get_messages' })
    return { page: { messages: result.messages, hasOlder: false }, pager: undefined }
  }

  async #requestSessionTree(): Promise<PiSessionTree> {
    const value = await this.#transport.request({ type: 'get_tree' })
    const sessionTree = sessionTreeFrom(value)
    if (!sessionTree) throw new Error('This Pi version does not expose session tree navigation to RPC clients')
    this.#sessionTree = sessionTree
    return sessionTree
  }

  async #tryRequestSessionTree(): Promise<PiSessionTree | undefined> {
    try {
      const value = await this.#transport.request({ type: 'get_tree' })
      return sessionTreeFrom(value)
    } catch {
      return undefined
    }
  }

  async #getThinkingLevels(): Promise<ThinkingLevel[]> {
    const data = await this.#transport.request<{ levels: ThinkingLevel[] }>({ type: 'get_available_thinking_levels' })
    return data.levels
  }

  async #refreshMessages(): Promise<void> {
    const refreshGeneration = this.#refreshGeneration
    try {
      const sessionFile = this.#state.session.sessionFile
      const previousTree = this.#sessionTree
      const [sessionTree, forkMessages] = await Promise.all([
        this.#tryRequestSessionTree(),
        this.#transport.request<{ messages: PiForkMessage[] }>({ type: 'get_fork_messages' }),
      ])
      if (sessionTree) this.#sessionTree = sessionTree
      if (sessionFile) {
        const latestPager = new PiSessionHistoryPager(sessionFile, sessionTree?.leafId)
        const page = await latestPager.loadEarlier(SESSION_HISTORY_PAGE_MESSAGES, HISTORY_NAVIGATION_LOAD_OPTIONS)
        const branchChanged = previousTree !== undefined
          && sessionTree !== undefined
          && !sessionTreeLeafDescendsFrom(sessionTree, previousTree.leafId)
        const retainedPager = branchChanged ? undefined : this.#historyPager
        if (this.#disposed || this.#refreshGeneration !== refreshGeneration) return
        if (!retainedPager) this.#historyPager = latestPager
        this.#patch({
          messages: branchChanged ? page.messages : mergeTranscriptTail(this.#state.messages, page.messages),
          messagesHasOlder: retainedPager ? this.#state.messagesHasOlder : page.hasOlder,
          messagesLoadingEarlier: false,
          forkMessages: forkMessagesFrom(forkMessages),
          liveAssistant: undefined,
          liveTools: [],
        })
        return
      }
      const messages = await this.#transport.request<{ messages: PiMessage[] }>({ type: 'get_messages' })
      if (this.#disposed || this.#refreshGeneration !== refreshGeneration) return
      this.#patch({ messages: messages.messages, messagesHasOlder: false, messagesLoadingEarlier: false, forkMessages: forkMessagesFrom(forkMessages), liveAssistant: undefined, liveTools: [] })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'warning', `Could not refresh transcript: ${errorMessage(error)}`))
    }
  }

  async #refreshStats(): Promise<void> {
    try {
      const stats = await this.#transport.request<PiSessionStats>({ type: 'get_session_stats' })
      this.#patch({ stats })
    } catch {
      // Stats are supplementary; transcript operation should continue without them.
    }
  }

  #appendCompactionMessage(result: unknown): void {
    const message = compactionMessageFrom(result)
    if (!message) return
    if (this.#state.messages.some((candidate) => sameCompactionMessage(candidate, message))) return
    this.#patch({ messages: [...this.#state.messages, message] })
  }

  #scheduleRefresh(full: boolean): void {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined
      void (full ? Promise.all([this.#bootstrap(false), this.refreshSessions()]) : Promise.all([this.#refreshMessages(), this.#refreshStats()]))
    }, full ? 80 : 35)
  }

  #newFabricRequestId(prefix: string): string {
    return `${prefix}-${Date.now()}-${++this.#nextFabricRequestId}`
  }

  async #requestFabricPeers(): Promise<FabricPeerCard[]> {
    const requestId = this.#newFabricRequestId('peers')
    return await new Promise<FabricPeerCard[]>((resolvePeers) => {
      let settled = false
      const finish = (peers: FabricPeerCard[]) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.#fabricPeerRequests.delete(requestId)
        resolvePeers(peers)
      }
      const timeout = setTimeout(() => finish([]), 3_000)
      this.#fabricPeerRequests.set(requestId, finish)
      void this.#transport.request({
        type: 'prompt',
        message: encodeFabricBridgeRequest({ action: 'peers', requestId }),
        ...(this.#state.session.isStreaming ? { streamingBehavior: 'steer' as const } : {}),
      }).catch((error) => {
        finish([])
        this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      })
    })
  }

  #handleFabricBridgeEvent(event: FabricBridgeEvent): void {
    if (event.event === 'ready') return
    if (event.event === 'peers') {
      this.#fabricPeerRequests.get(event.requestId)?.(event.peers)
      return
    }
    if (event.event === 'error' && event.activity === 'peers') {
      this.#fabricPeerRequests.get(event.requestId)?.([])
      this.#setState((state) => addNotice(state, 'warning', event.error))
      return
    }
    if (this.#state.queue.dispatchingId !== event.requestId) return
    if (event.event === 'started' || event.event === 'progress') {
      this.#patch({
        queue: {
          ...this.#state.queue,
          blockingActivity: event.activity === 'prewalk' ? 'fabric-prewalk' : 'fabric-await',
          blockingNote: event.note,
        },
      })
      return
    }
    if (event.event === 'settled') {
      this.#patch({
        queue: {
          ...this.#state.queue,
          items: this.#state.queue.items.filter((item) => item.id !== event.requestId),
          dispatchingId: undefined,
          blockingActivity: undefined,
          blockingNote: undefined,
        },
      })
      if (!this.#state.session.isStreaming) this.#drainQueue()
      return
    }
    if (event.event === 'cancelled') {
      this.#patch({
        queue: {
          ...this.#state.queue,
          items: this.#state.queue.items.filter((item) => item.id !== event.requestId),
          paused: this.#state.queue.items.length > 1,
          pauseReason: this.#state.queue.items.length > 1 ? 'manual' : undefined,
          dispatchingId: undefined,
          blockingActivity: undefined,
          blockingNote: undefined,
        },
      })
      return
    }
    if (event.event === 'error') {
      this.#patch({
        queue: {
          ...this.#state.queue,
          paused: true,
          pauseReason: 'error',
          dispatchingId: undefined,
          blockingActivity: undefined,
          blockingNote: undefined,
        },
      })
      this.#setState((state) => addNotice(state, 'error', event.error))
    }
  }

  #handleEvent(event: RpcRecord): void {
    // An optimistically started run (sendPrompt) already owns its generation;
    // only a run beginning outside that window advances it.
    if (event.type === 'agent_start' && !this.#state.session.isStreaming) this.#runGeneration += 1
    const fabricEvent = parseFabricBridgeEvent(event)
    if (fabricEvent) {
      this.#flushStreamDeltas()
      this.#handleFabricBridgeEvent(fabricEvent)
      return
    }
    if (isExtensionUiRequest(event)) {
      this.#flushStreamDeltas()
      this.#dialogs.handleExtensionUi(event, this.#sessionTransitionDepth > 0)
      return
    }
    if (isStreamDeltaEvent(event)) {
      this.#streamDeltas.push(event)
      this.#scheduleStreamDeltaFlush()
      return
    }
    this.#flushStreamDeltas()
    this.#setState((state) => applyRpcEvent(state, event))
    if (event.type === 'compaction_start') this.#compactionHold = true
    if (event.type === 'compaction_end') {
      this.#compactionHold = false
      this.#appendCompactionMessage(event.result)
      if (this.#state.queue.pauseReason === 'error') this.#patch({ queue: { ...this.#state.queue, paused: false, pauseReason: undefined } })
      if (!this.#state.session.isStreaming) this.#drainQueue()
      this.#scheduleRefresh(false)
    }
    if (event.type === 'turn_end' && healthyTurnBoundary(event)) this.#drainSteering()
    if (event.type === 'tool_execution_end') {
      const toolCallId = String(event.toolCallId ?? '')
      this.#dialogs.handleToolExecutionEnd(toolCallId)
      if (this.#pauseAfterTools && !this.#state.liveTools.some((tool) => tool.status !== 'complete')) {
        this.#pauseAfterTools = false
        void this.#transport.request({ type: 'abort' }).catch((error) => this.#setState((state) => addNotice(state, 'error', errorMessage(error))))
      }
    }
    const runOutcome = event.type === 'agent_end' && !event.willRetry ? agentEndOutcome(event) : 'unknown'
    if (runOutcome === 'failed') {
      this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'error' } })
    } else if (runOutcome === 'healthy' && this.#state.queue.pauseReason === 'error') {
      this.#patch({ queue: { ...this.#state.queue, paused: false, pauseReason: undefined } })
    }
    if (event.type === 'message_end' || event.type === 'tool_execution_end') this.#scheduleRefresh(false)
    if (event.type === 'agent_settled') {
      this.#scheduleRefresh(true)
      this.#drainQueue()
    }
  }

  #scheduleReconnect(): void {
    if (this.#disposed) return
    if (this.#reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.#reconnectAttempts = 0
      this.#setState((state) => addNotice(state, 'error', 'Pi keeps disconnecting — automatic reconnection gave up. Press Reconnect to try again.'))
      return
    }
    this.#clearReconnectTimer()
    const attempt = ++this.#reconnectAttempts
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS)
    if (attempt === 1) {
      this.#setState((state) => addNotice(state, 'warning', 'Pi disconnected — reconnecting automatically…'))
    }
    this.#patch({ connectionMessage: `Reconnecting (attempt ${attempt})…` })
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      void this.reconnect().catch(() => undefined)
    }, delay)
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === undefined) return
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
  }

  #handleStatus(status: TransportStatus): void {
    if (status.state === 'starting') this.#patch({ connection: 'connecting', connectionMessage: 'Starting Pi…' })
    if (status.state === 'running') this.#patch({ connectionMessage: `Pi process ${status.pid ?? ''}`.trim() })
    if (status.state === 'stopped' && !this.#connecting) this.#patch({ connection: 'idle', connectionMessage: 'Disconnected' })
    if (status.state === 'exited') {
      this.#started = false
      this.#discardStreamDeltas()
      this.#patch({
        connection: 'error',
        connectionMessage: status.message,
        session: { ...this.#state.session, isStreaming: false },
        activity: 'Disconnected',
      })
      if (!this.#connecting) this.#scheduleReconnect()
    }
  }

  #scheduleStreamDeltaFlush(): void {
    if (this.#streamDeltaTimer) return
    const timer = setTimeout(() => {
      this.#streamDeltaTimer = undefined
      this.#flushStreamDeltas()
    }, this.#streamDeltaFrameMs)
    timer.unref?.()
    this.#streamDeltaTimer = timer
  }

  #flushStreamDeltas(): void {
    if (this.#streamDeltaTimer) {
      clearTimeout(this.#streamDeltaTimer)
      this.#streamDeltaTimer = undefined
    }
    if (this.#streamDeltas.length === 0) return
    const events = this.#streamDeltas.splice(0)
    this.#setState((state) => events.reduce((accumulated, event) => applyRpcEvent(accumulated, event), state))
  }

  #discardStreamDeltas(): void {
    this.#streamDeltas.splice(0)
    if (this.#streamDeltaTimer) {
      clearTimeout(this.#streamDeltaTimer)
      this.#streamDeltaTimer = undefined
    }
  }

  #patch(patch: Partial<WorkbenchState>): void {
    this.#setState((state) => ({ ...state, ...patch }))
  }

  #setState(update: (state: WorkbenchState) => WorkbenchState): void {
    const previous = this.#state
    const next = update(previous)
    if (next === previous) return
    this.#state = next
    if (next.queue !== previous.queue || next.workspacePath !== previous.workspacePath) this.#queueStore?.save(next.workspacePath, next.queue)
    if (next.threadLifecycle !== previous.threadLifecycle) this.#threadMetadataStore?.save(next.threadLifecycle)
    const editorChanged = next.editorText !== previous.editorText || next.editorImages !== previous.editorImages
    const shellChanged = workbenchShellChanged(previous, next)
    if (shellChanged) this.#shellSnapshot = next
    if (editorChanged) this.#editorSnapshot = { editorText: next.editorText, editorImages: next.editorImages }
    for (const listener of this.#listeners) listener()
    if (shellChanged) for (const listener of this.#shellListeners) listener()
    if (editorChanged) for (const listener of this.#editorListeners) listener()
  }
}

function workbenchShellChanged(previous: WorkbenchState, next: WorkbenchState): boolean {
  for (const key of Object.keys(next) as Array<keyof WorkbenchState>) {
    if (key === 'editorText' || key === 'editorImages') continue
    if (previous[key] !== next[key]) return true
  }
  return false
}

function isStreamDeltaEvent(event: RpcRecord): boolean {
  return event.type === 'message_update' || event.type === 'tool_execution_update'
}

function resolveModelReference(models: readonly PiModel[], reference: string): { provider: string; modelId: string } | undefined {
  const separator = reference.indexOf('/')
  if (separator > 0 && separator < reference.length - 1) {
    return { provider: reference.slice(0, separator), modelId: reference.slice(separator + 1) }
  }
  const normalized = reference.toLowerCase()
  const matches = models.filter((model) => model.id.toLowerCase() === normalized || model.name?.toLowerCase() === normalized)
  return matches.length === 1 ? { provider: matches[0]!.provider, modelId: matches[0]!.id } : undefined
}

function parsePathArgument(argument: string): string | undefined {
  if (!argument) return undefined
  const quote = argument[0]
  if (quote === '"' || quote === "'") {
    const closing = argument.indexOf(quote, 1)
    return closing > 0 ? argument.slice(1, closing) : undefined
  }
  return argument.split(/\s+/, 1)[0]
}

function compactCommandText(text: string): string {
  const compacted = text.replace(/\s+/g, ' ').trim()
  return compacted.length > 96 ? `${compacted.slice(0, 93)}…` : compacted
}

function formatSessionNotice(session: PiSessionState, stats: PiSessionStats): string {
  const parts = [
    session.sessionName ? `Name: ${session.sessionName}` : undefined,
    `ID: ${stats.sessionId ?? session.sessionId ?? 'unknown'}`,
    `Messages: ${stats.totalMessages ?? 0}`,
    `Tools: ${stats.toolCalls ?? 0}`,
    typeof stats.cost === 'number' ? `Cost: $${stats.cost.toFixed(3)}` : undefined,
    stats.sessionFile ?? session.sessionFile ?? 'In-memory session',
  ]
  return parts.filter((part): part is string => part !== undefined).join(' · ')
}

function interactiveOnlyCommandMessage(command: ParsedBuiltinSlashCommand['name']): string {
  if (command === 'scoped-models') return "Pi's scoped model editor is not exposed by RPC yet; all available models remain in Heddlework's picker"
  if (command === 'login' || command === 'logout') return `/${command} is interactive-only in Pi; authenticate with Pi in a terminal and reconnect Heddlework`
  if (command === 'trust') return "Pi's /trust flow is interactive-only; save trust in Pi or start Heddlework with an approved Pi configuration"
  if (command === 'import') return "Pi's /import flow is not exposed by RPC yet; use the session sidebar for existing sessions"
  if (command === 'share') return "Pi's /share flow is interactive-only and is not exposed by RPC"
  if (command === 'hotkeys') return "Pi's /hotkeys describes its terminal UI; Heddlework uses native desktop controls"
  if (command === 'changelog') return "Pi's /changelog view is interactive-only and is not exposed by RPC"
  return `/${command} is not available through Pi RPC`
}

function messageEntryId(message: PiMessage): string | undefined {
  return typeof message.workbenchEntryId === 'string' ? message.workbenchEntryId : undefined
}

function compactionMessageFrom(value: unknown): PiMessage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const summary = typeof record.summary === 'string' ? record.summary : undefined
  if (!summary) return undefined
  const tokensBefore = typeof record.tokensBefore === 'number' ? record.tokensBefore : undefined
  return {
    role: 'compaction',
    content: summary,
    display: true,
    ...(tokensBefore === undefined ? {} : { tokensBefore }),
    timestamp: Date.now(),
  }
}

function sameCompactionMessage(candidate: PiMessage, message: PiMessage): boolean {
  return candidate.role === 'compaction'
    && contentText(candidate.content) === contentText(message.content)
    && candidate.tokensBefore === message.tokensBefore
}

function mergeTranscriptTail(current: PiMessage[], latest: PiMessage[]): PiMessage[] {
  if (latest.length === 0) return current
  const latestIds = new Set(latest.flatMap((message) => messageEntryId(message) ? [messageEntryId(message)!] : []))
  const overlap = current.findIndex((message) => latestIds.has(messageEntryId(message) ?? ''))
  const prefix = overlap >= 0 ? current.slice(0, overlap) : current.filter((message) => messageEntryId(message) !== undefined)
  const seen = new Set<string>()
  return [...prefix, ...latest].filter((message) => {
    const id = messageEntryId(message)
    if (!id) return true
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function healthyTurnBoundary(event: RpcRecord): boolean {
  if (event.type !== 'turn_end' || !event.message || typeof event.message !== 'object') return false
  const stopReason = (event.message as { stopReason?: unknown }).stopReason
  return stopReason !== 'error' && stopReason !== 'aborted'
}

function agentEndOutcome(event: RpcRecord): 'healthy' | 'failed' | 'unknown' {
  if (!Array.isArray(event.messages)) return 'unknown'
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index]
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') continue
    const stopReason = (message as { stopReason?: unknown }).stopReason
    return stopReason === 'error' || stopReason === 'aborted' || stopReason === 'length' ? 'failed' : 'healthy'
  }
  return 'unknown'
}

function forkMessagesFrom(value: unknown): PiForkMessage[] {
  if (!value || typeof value !== 'object') return []
  const messages = (value as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  return messages.filter((message): message is PiForkMessage => (
    Boolean(message)
    && typeof message === 'object'
    && typeof (message as { entryId?: unknown }).entryId === 'string'
    && typeof (message as { text?: unknown }).text === 'string'
  ))
}
