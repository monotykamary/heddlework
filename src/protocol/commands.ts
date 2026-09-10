import type { ComposerImage, ThinkingLevel } from '../pi/types.ts'
import type { AskUserSubmissionAnswer } from '../workbench/ask-user.ts'
import type { WorkbenchController, NavigateTreeOptions } from '../workbench/controller.ts'
import type { QueueLane } from '../workbench/queue.ts'
import type { NoticeKind, ThreadPriority } from '../workbench/state.ts'
import { isTerminalCommand, type TerminalCommand } from './terminal.ts'
import type { TerminalSessionService } from '../terminal/service.ts'

const MAX_TEXT_LENGTH = 1_000_000
const MAX_ID_LENGTH = 512
const MAX_LABELS = 32
const MAX_IMAGE_DATA_LENGTH = 16 * 1024 * 1024
const IMAGE_KEYS = new Set(['id', 'type', 'data', 'mimeType', 'previewPath', 'fileName', 'size'])
const LANES = new Set<QueueLane>(['steer', 'followUp'])
const THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])

export type WorkbenchCommand =
  | TerminalCommand
  | { type: 'submit'; text: string; queue?: boolean }
  | { type: 'queueInput'; text: string; lane?: QueueLane; paused?: boolean }
  | { type: 'updateQueuedInput'; id: string; text: string }
  | { type: 'removeQueuedInput' | 'toggleQueuedInputPause' | 'steerQueuedInput'; id: string }
  | { type: 'moveQueuedInput'; id: string; targetIndex: number }
  | { type: 'moveQueuedInputToLane'; id: string; lane: QueueLane }
  | { type: 'removeQueuedFlow'; runId: string }
  | { type: 'queueFabricPeerGate' | 'cancelBlockingQueueActivity' | 'resumeQueue' | 'drainQueueMessages' | 'pause' | 'abort' | 'newSession' | 'refreshSessions' | 'loadMoreSessions' | 'loadEarlierMessages' | 'cloneSession' | 'exportSession' | 'compact' | 'refreshWorkspaceDiff' | 'clearNotices' }
  | { type: 'switchSession'; path: string }
  | { type: 'openSessionTree'; preserveQueue?: boolean }
  | { type: 'navigateTree'; entryId: string; options?: NavigateTreeOptions }
  | { type: 'forkFrom'; entryId: string; preserveQueue?: boolean }
  | { type: 'setModel'; provider: string; id: string }
  | { type: 'setThinkingLevel'; level: ThinkingLevel }
  | { type: 'completeUiRequest' | 'dismissNotice' | 'removeEditorImage'; id: number | string }
  | { type: 'respondToDialog'; value?: string; confirmed?: boolean; cancelled?: boolean }
  | { type: 'submitAskUserQuestionnaire'; toolCallId: string; answers: AskUserSubmissionAnswer[] }
  | { type: 'cancelAskUserQuestionnaire' | 'setAskUserQuestionnaireCollapsed'; toolCallId: string; collapsed?: boolean }
  | { type: 'settleThread' | 'wakeThread'; path: string }
  | { type: 'snoozeThread'; path: string; snoozedUntil: number }
  | { type: 'setThreadPriority'; path: string; priority: ThreadPriority | undefined }
  | { type: 'setThreadLabels'; path: string; labels: string[] }
  | { type: 'markThreadRead'; path: string; updatedAt: number }
  | { type: 'markThreadsRead'; threads: Array<{ path: string; updatedAt: number }> }
  | { type: 'notify'; kind: NoticeKind; message: string }
  | { type: 'setEditorText'; text: string }
  | { type: 'addEditorImage'; image: ComposerImage }

export type WorkbenchCommandType = WorkbenchCommand['type']

export const WORKBENCH_COMMAND_TYPES = [
  'submit', 'queueInput', 'updateQueuedInput', 'removeQueuedInput', 'moveQueuedInput', 'moveQueuedInputToLane',
  'toggleQueuedInputPause', 'steerQueuedInput', 'removeQueuedFlow', 'queueFabricPeerGate', 'cancelBlockingQueueActivity',
  'resumeQueue', 'drainQueueMessages', 'pause', 'abort', 'newSession', 'switchSession', 'refreshSessions',
  'loadMoreSessions', 'loadEarlierMessages', 'openSessionTree', 'navigateTree', 'cloneSession', 'forkFrom', 'exportSession',
  'setModel', 'setThinkingLevel', 'compact', 'completeUiRequest', 'respondToDialog', 'submitAskUserQuestionnaire',
  'cancelAskUserQuestionnaire', 'setAskUserQuestionnaireCollapsed', 'settleThread', 'snoozeThread', 'wakeThread',
  'setThreadPriority', 'setThreadLabels', 'markThreadRead', 'markThreadsRead', 'refreshWorkspaceDiff', 'notify',
  'dismissNotice', 'clearNotices', 'setEditorText', 'addEditorImage', 'removeEditorImage',
  'openTerminal', 'writeTerminal', 'resizeTerminal', 'closeTerminal',
] as const satisfies readonly WorkbenchCommandType[]

export function isWorkbenchCommand(value: unknown): value is WorkbenchCommand {
  if (!record(value) || !WORKBENCH_COMMAND_TYPES.includes(value.type as WorkbenchCommandType)) return false
  const text = (key: string, max = MAX_TEXT_LENGTH) => string(value[key], max)
  const id = (key: string) => string(value[key], MAX_ID_LENGTH)
  const path = () => id('path')
  const type = value.type as WorkbenchCommandType
  if ((['openTerminal', 'writeTerminal', 'resizeTerminal', 'closeTerminal'] as string[]).includes(type)) return isTerminalCommand(value)
  switch (type) {
    case 'submit': return text('text') && optionalBoolean(value.queue)
    case 'queueInput': return text('text') && (value.lane === undefined || LANES.has(value.lane as QueueLane)) && optionalBoolean(value.paused)
    case 'updateQueuedInput': return id('id') && text('text')
    case 'removeQueuedInput': case 'toggleQueuedInputPause': case 'steerQueuedInput': return id('id')
    case 'moveQueuedInput': return id('id') && integer(value.targetIndex, 0, 100_000)
    case 'moveQueuedInputToLane': return id('id') && LANES.has(value.lane as QueueLane)
    case 'removeQueuedFlow': return id('runId')
    case 'switchSession': case 'settleThread': case 'wakeThread': return path()
    case 'openSessionTree': return optionalBoolean(value.preserveQueue)
    case 'navigateTree': return id('entryId') && validNavigateOptions(value.options)
    case 'forkFrom': return id('entryId') && optionalBoolean(value.preserveQueue)
    case 'setModel': return id('provider') && id('id')
    case 'setThinkingLevel': return THINKING_LEVELS.has(value.level as ThinkingLevel)
    case 'completeUiRequest': case 'dismissNotice': return integer(value.id, 0, Number.MAX_SAFE_INTEGER)
    case 'removeEditorImage': return id('id')
    case 'respondToDialog': return (value.value === undefined || text('value')) && optionalBoolean(value.confirmed) && optionalBoolean(value.cancelled)
    case 'submitAskUserQuestionnaire': return id('toolCallId') && Array.isArray(value.answers) && value.answers.length <= 100 && value.answers.every(validAnswer)
    case 'cancelAskUserQuestionnaire': return id('toolCallId')
    case 'setAskUserQuestionnaireCollapsed': return id('toolCallId') && typeof value.collapsed === 'boolean'
    case 'snoozeThread': return path() && integer(value.snoozedUntil, 0, 8_640_000_000_000_000)
    case 'setThreadPriority': return path() && (value.priority === undefined || integer(value.priority, 0, 4))
    case 'setThreadLabels': return path() && Array.isArray(value.labels) && value.labels.length <= MAX_LABELS && value.labels.every((label) => string(label, 80))
    case 'markThreadRead': return path() && integer(value.updatedAt, 0, 8_640_000_000_000_000)
    case 'markThreadsRead': return Array.isArray(value.threads) && value.threads.length <= 500 && value.threads.every((thread) => record(thread) && string(thread.path, MAX_ID_LENGTH) && integer(thread.updatedAt, 0, 8_640_000_000_000_000))
    case 'notify': return (value.kind === 'info' || value.kind === 'warning' || value.kind === 'error') && text('message', 8_192)
    case 'setEditorText': return text('text')
    case 'addEditorImage': return validImage(value.image)
    default: return noPayload(value)
  }
}

export async function applyWorkbenchCommand(controller: WorkbenchController, command: WorkbenchCommand, services: { terminals?: TerminalSessionService } = {}): Promise<unknown> {
  const knownPath = (path: string): boolean => {
    const state = controller.getSnapshot()
    return state.session.sessionFile === path || state.sessions.some((entry) => entry.path === path) || Object.hasOwn(state.threadLifecycle, path)
  }
  const requireKnownPath = (path: string): void => { if (!knownPath(path)) throw new Error('Session path is not authorized') }
  if (isTerminalCommand(command)) { if (!services.terminals) throw new Error('Remote terminal access is unavailable'); const { applyTerminalCommand } = await import('./terminal.ts'); return applyTerminalCommand(services.terminals, command) }
  switch (command.type) {
    case 'submit': return controller.submit(command.text, command.queue ? { queue: true } : {})
    case 'queueInput': controller.queueInput(command.text, [], { ...(command.lane ? { lane: command.lane } : {}), ...(command.paused === undefined ? {} : { paused: command.paused }) }); return
    case 'updateQueuedInput': controller.updateQueuedInput(command.id, command.text); return
    case 'removeQueuedInput': controller.removeQueuedInput(command.id); return
    case 'moveQueuedInput': controller.moveQueuedInput(command.id, command.targetIndex); return
    case 'moveQueuedInputToLane': controller.moveQueuedInputToLane(command.id, command.lane); return
    case 'toggleQueuedInputPause': controller.toggleQueuedInputPause(command.id); return
    case 'steerQueuedInput': return controller.steerQueuedInput(command.id)
    case 'removeQueuedFlow': controller.removeQueuedFlow(command.runId); return
    case 'queueFabricPeerGate': return controller.queueFabricPeerGate()
    case 'cancelBlockingQueueActivity': controller.cancelBlockingQueueActivity(); return
    case 'resumeQueue': controller.resumeQueue(); return
    case 'drainQueueMessages': return controller.drainQueueMessages()
    case 'pause': return controller.pause()
    case 'abort': return controller.abort()
    case 'newSession': return controller.newSession()
    case 'switchSession': { requireKnownPath(command.path); const session = controller.getSnapshot().sessions.find((entry) => entry.path === command.path); if (!session) throw new Error('Session is not available'); return controller.switchSession(session) }
    case 'refreshSessions': return controller.refreshSessions()
    case 'loadMoreSessions': return controller.loadMoreSessions()
    case 'loadEarlierMessages': return controller.loadEarlierMessages()
    case 'openSessionTree': return controller.openSessionTree(command.preserveQueue === undefined ? {} : { preserveQueue: command.preserveQueue })
    case 'navigateTree': return controller.navigateTree(command.entryId, command.options ?? {})
    case 'cloneSession': return controller.cloneSession()
    case 'forkFrom': return controller.forkFrom(command.entryId, command.preserveQueue === undefined ? {} : { preserveQueue: command.preserveQueue })
    case 'exportSession': return controller.exportSession()
    case 'setModel': { const model = controller.getSnapshot().models.find((entry) => entry.provider === command.provider && entry.id === command.id); if (!model) throw new Error('Model is not available'); return controller.setModel(model) }
    case 'setThinkingLevel': return controller.setThinkingLevel(command.level)
    case 'compact': return controller.compact()
    case 'completeUiRequest': controller.completeUiRequest(command.id as number); return
    case 'respondToDialog': controller.respondToDialog({ ...(command.value === undefined ? {} : { value: command.value }), ...(command.confirmed === undefined ? {} : { confirmed: command.confirmed }), ...(command.cancelled === undefined ? {} : { cancelled: command.cancelled }) }); return
    case 'submitAskUserQuestionnaire': controller.submitAskUserQuestionnaire(command.toolCallId, command.answers); return
    case 'cancelAskUserQuestionnaire': controller.cancelAskUserQuestionnaire(command.toolCallId); return
    case 'setAskUserQuestionnaireCollapsed': controller.setAskUserQuestionnaireCollapsed(command.toolCallId, command.collapsed ?? false); return
    case 'settleThread': requireKnownPath(command.path); controller.settleThread(command.path); return
    case 'snoozeThread': requireKnownPath(command.path); controller.snoozeThread(command.path, command.snoozedUntil); return
    case 'wakeThread': requireKnownPath(command.path); controller.wakeThread(command.path); return
    case 'setThreadPriority': requireKnownPath(command.path); controller.setThreadPriority(command.path, command.priority); return
    case 'setThreadLabels': requireKnownPath(command.path); controller.setThreadLabels(command.path, command.labels); return
    case 'markThreadRead': requireKnownPath(command.path); controller.markThreadRead(command.path, command.updatedAt); return
    case 'markThreadsRead': for (const thread of command.threads) requireKnownPath(thread.path); controller.markThreadsRead(command.threads); return
    case 'refreshWorkspaceDiff': return controller.refreshWorkspaceDiff()
    case 'notify': controller.notify(command.kind, command.message); return
    case 'dismissNotice': controller.dismissNotice(command.id as number); return
    case 'clearNotices': controller.clearNotices(); return
    case 'setEditorText': controller.setEditorText(command.text); return
    case 'addEditorImage': controller.addEditorImage(command.image); return
    case 'removeEditorImage': controller.removeEditorImage(command.id as string); return
  }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function string(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max }
function integer(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max }
function optionalBoolean(value: unknown): boolean { return value === undefined || typeof value === 'boolean' }
function noPayload(value: Record<string, unknown>): boolean { return Object.keys(value).every((key) => key === 'type') }
function validNavigateOptions(value: unknown): boolean {
  if (value === undefined) return true
  if (!record(value)) return false
  const keys = new Set(['summarize', 'customInstructions', 'replaceInstructions', 'label', 'preserveQueue'])
  return Object.keys(value).every((key) => keys.has(key)) && optionalBoolean(value.summarize) && optionalBoolean(value.replaceInstructions) && optionalBoolean(value.preserveQueue) && (value.customInstructions === undefined || string(value.customInstructions, 64_000)) && (value.label === undefined || string(value.label, 256))
}
function validAnswer(value: unknown): value is AskUserSubmissionAnswer { return record(value) && string(value.questionId, MAX_ID_LENGTH) && string(value.value, 64_000) }
function validImage(value: unknown): value is ComposerImage {
  if (!record(value) || !Object.keys(value).every((key) => IMAGE_KEYS.has(key)) || !string(value.data, MAX_IMAGE_DATA_LENGTH) || !string(value.mimeType, 100) || !string(value.previewPath, MAX_TEXT_LENGTH)) return false
  const dataBytes = base64ByteLength(value.data)
  if (dataBytes === undefined || !integer(value.size, 0, 20 * 1024 * 1024) || value.size !== dataBytes) return false
  if (!/^image\/[a-z0-9.+-]+$/i.test(value.mimeType)) return false
  if (value.previewPath.toLowerCase().startsWith('data:') && value.previewPath !== `data:${value.mimeType};base64,${value.data}`) return false
  return string(value.id, MAX_ID_LENGTH) && value.type === 'image' && string(value.fileName, 1_024)
}
function base64ByteLength(value: string): number | undefined {
  if (value.length % 4 !== 0) return undefined
  let padding = 0
  if (value.endsWith('==')) padding = 2
  else if (value.endsWith('=')) padding = 1
  const contentLength = value.length - padding
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index)
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) return undefined
  }
  for (let index = contentLength; index < value.length; index += 1) if (value.charCodeAt(index) !== 61) return undefined
  return (value.length / 4) * 3 - padding
}
