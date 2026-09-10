import type { WorkbenchController, NavigateTreeOptions } from '../workbench/controller.ts'
import type { WorkbenchState, NoticeKind, ThreadPriority } from '../workbench/state.ts'
import type { WorkbenchCommand } from '../protocol/index.ts'
import type { ComposerImage, PiModel, ThinkingLevel } from '../pi/types.ts'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { AskUserSubmissionAnswer } from '../workbench/ask-user.ts'
import type { QueueInputDraft, QueueLane } from '../workbench/queue.ts'
import type { WorkspaceClient } from '../web/client.ts'

export class RemoteWorkbenchController {
  readonly #client: WorkspaceClient
  readonly #listeners = new Set<() => void>()
  #snapshot: WorkbenchState | undefined
  #localEditorText: string | undefined
  #editorTimer: ReturnType<typeof setTimeout> | undefined
  #unsubscribe: () => void
  constructor(client: WorkspaceClient) { this.#client = client; this.#snapshot = materialize(client.getSnapshot().state); this.#unsubscribe = client.subscribe(() => this.#pull()) }
  readonly subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  readonly getSnapshot = (): WorkbenchState => { if (!this.#snapshot) throw new Error('Remote workbench is not ready'); return this.#snapshot }
  readonly loadEarlierMessages = async (): Promise<void> => { await this.#send({ type: 'loadEarlierMessages' }) }
  #pull(): void { const next = materialize(this.#client.getSnapshot().state); if (!next) return; if (this.#snapshot && next.editorText !== this.#snapshot.editorText && next.editorText !== this.#localEditorText) this.#localEditorText = undefined; this.#snapshot = this.#localEditorText === undefined ? next : { ...next, editorText: this.#localEditorText }; for (const listener of this.#listeners) listener() }
  #send(command: WorkbenchCommand): Promise<unknown> { return this.#client.send(command).catch((error) => { this.#client.reportError(error); throw error }) }
  notify(kind: NoticeKind, message: string): void { void this.#send({ type: 'notify', kind, message }) }
  async start(): Promise<void> {}
  async reconnect(): Promise<void> { this.#client.reconnect() }
  async submit(text: string, options: { queue?: boolean } = {}): Promise<void> { this.#localEditorText = undefined; await this.#send({ type: 'submit', text, ...(options.queue ? { queue: true } : {}) }) }
  queueInput(text: string, _images: readonly ComposerImage[] = [], options: { paused?: boolean; lane?: QueueLane } = {}): undefined { void this.#send({ type: 'queueInput', text, ...(options.lane ? { lane: options.lane } : {}), ...(options.paused === undefined ? {} : { paused: options.paused }) }); return undefined }
  enqueueQueueInputs(inputs: readonly QueueInputDraft[], options: { start?: boolean; paused?: boolean } = {}): never[] { for (const input of inputs) this.queueInput(input.text, input.images, { ...(input.lane ? { lane: input.lane } : {}), ...(options.paused === undefined ? {} : { paused: options.paused }) }); return [] }
  hasQueuedFlow(runId: string): boolean { return this.getSnapshot().queue.items.some((item) => item.flow?.runId === runId) }
  removeQueuedFlow(runId: string): void { void this.#send({ type: 'removeQueuedFlow', runId }) }
  updateQueuedInput(id: string, text: string): void { void this.#send({ type: 'updateQueuedInput', id, text }) }
  removeQueuedInput(id: string): void { void this.#send({ type: 'removeQueuedInput', id }) }
  moveQueuedInput(id: string, targetIndex: number): void { void this.#send({ type: 'moveQueuedInput', id, targetIndex }) }
  moveQueuedInputToLane(id: string, lane: QueueLane): void { void this.#send({ type: 'moveQueuedInputToLane', id, lane }) }
  toggleQueuedInputPause(id: string): void { void this.#send({ type: 'toggleQueuedInputPause', id }) }
  async queueFabricPeerGate(): Promise<void> { await this.#send({ type: 'queueFabricPeerGate' }) }
  cancelBlockingQueueActivity(): void { void this.#send({ type: 'cancelBlockingQueueActivity' }) }
  async steerQueuedInput(id: string): Promise<void> { await this.#send({ type: 'steerQueuedInput', id }) }
  resumeQueue(): void { void this.#send({ type: 'resumeQueue' }) }
  async drainQueueMessages(): Promise<void> { await this.#send({ type: 'drainQueueMessages' }) }
  async pause(): Promise<void> { await this.#send({ type: 'pause' }) }
  async abort(): Promise<void> { await this.#send({ type: 'abort' }) }
  async newSession(): Promise<void> { await this.#send({ type: 'newSession' }) }
  async switchWorkspace(): Promise<void> { this.notify('warning', 'Switch workspaces from the host desktop') }
  async switchSession(session: PiSessionSummary): Promise<void> { await this.#send({ type: 'switchSession', path: session.path }) }
  async refreshSessions(): Promise<void> { await this.#send({ type: 'refreshSessions' }) }
  async loadMoreSessions(): Promise<void> { await this.#send({ type: 'loadMoreSessions' }) }
  async openSessionTree(options: { preserveQueue?: boolean } = {}): Promise<void> { await this.#send({ type: 'openSessionTree', ...options }) }
  async navigateTree(entryId: string, options: NavigateTreeOptions = {}): Promise<void> { await this.#send({ type: 'navigateTree', entryId, options }) }
  async cloneSession(): Promise<void> { await this.#send({ type: 'cloneSession' }) }
  async forkFrom(entryId: string, options: { preserveQueue?: boolean } = {}): Promise<void> { await this.#send({ type: 'forkFrom', entryId, ...options }) }
  async exportSession(): Promise<string | undefined> { const value = await this.#send({ type: 'exportSession' }); return typeof value === 'string' ? value : undefined }
  async setModel(model: PiModel): Promise<void> { await this.#send({ type: 'setModel', provider: model.provider, id: model.id }) }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> { await this.#send({ type: 'setThinkingLevel', level }) }
  async compact(): Promise<void> { await this.#send({ type: 'compact' }) }
  completeUiRequest(id: number): void { void this.#send({ type: 'completeUiRequest', id }) }
  setEditorText(text: string): void { this.#localEditorText = text; this.#snapshot = { ...this.getSnapshot(), editorText: text }; for (const listener of this.#listeners) listener(); if (this.#editorTimer) clearTimeout(this.#editorTimer); this.#editorTimer = setTimeout(() => { void this.#send({ type: 'setEditorText', text }) }, 200) }
  addEditorImage(image: ComposerImage): void { void this.#send({ type: 'addEditorImage', image }) }
  removeEditorImage(id: string): void { void this.#send({ type: 'removeEditorImage', id }) }
  dismissNotice(id: number): void { void this.#send({ type: 'dismissNotice', id }) }
  clearNotices(): void { void this.#send({ type: 'clearNotices' }) }
  settleThread(path: string): void { void this.#send({ type: 'settleThread', path }) }
  snoozeThread(path: string, snoozedUntil: number): void { void this.#send({ type: 'snoozeThread', path, snoozedUntil }) }
  wakeThread(path: string): void { void this.#send({ type: 'wakeThread', path }) }
  setThreadPriority(path: string, priority: ThreadPriority | undefined): void { void this.#send({ type: 'setThreadPriority', path, priority }) }
  setThreadLabels(path: string, labels: readonly string[]): void { void this.#send({ type: 'setThreadLabels', path, labels: [...labels] }) }
  markThreadRead(path: string, updatedAt: number): void { void this.#send({ type: 'markThreadRead', path, updatedAt }) }
  markThreadsRead(threads: readonly { path: string; updatedAt: number }[]): void { void this.#send({ type: 'markThreadsRead', threads: [...threads] }) }
  async refreshWorkspaceDiff(): Promise<void> { await this.#send({ type: 'refreshWorkspaceDiff' }) }
  respondToDialog(response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void { void this.#send({ type: 'respondToDialog', ...response }) }
  submitAskUserQuestionnaire(toolCallId: string, answers: readonly AskUserSubmissionAnswer[]): void { void this.#send({ type: 'submitAskUserQuestionnaire', toolCallId, answers: [...answers] }) }
  cancelAskUserQuestionnaire(toolCallId: string): void { void this.#send({ type: 'cancelAskUserQuestionnaire', toolCallId }) }
  setAskUserQuestionnaireCollapsed(toolCallId: string, collapsed: boolean): void { void this.#send({ type: 'setAskUserQuestionnaireCollapsed', toolCallId, collapsed }) }
  async dispose(): Promise<void> { this.#unsubscribe(); if (this.#editorTimer) clearTimeout(this.#editorTimer); this.#listeners.clear() }
}
export function asWorkbenchController(remote: RemoteWorkbenchController): WorkbenchController { return remote as unknown as WorkbenchController }
function materialize(snapshot: import('../protocol/index.ts').WorkbenchSnapshot | undefined): WorkbenchState | undefined { if (!snapshot) return undefined; return { ...snapshot, editorImages: snapshot.editorImages.map((image) => ({ ...image, data: typeof image.data === 'string' ? image.data : '' })) } as WorkbenchState }
