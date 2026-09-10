import { hasNativeTrafficLights } from './window-chrome.ts'
import React, { memo, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import { PiSessionHistoryPager } from '../pi/session-history.ts'
import type { PiMessage } from '../pi/types.ts'
import { projectFlowActivity, type FlowActivityEntry } from '../flows/activity.ts'
import { projectFlowFabricGraph, type FabricBranchStatus, type FlowFabricProjection } from '../flows/fabric-projection.ts'
import { projectFlowRuns, terminalFlowTasks, type FlowRunProjection, type FlowTaskProjection, type FlowTaskStatus } from '../flows/projection.ts'
import type { FlowRuntime } from '../flows/runtime.ts'
import { flowProjectName, formatFlowDate, scheduleTimingLabel, type FlowSchedule } from '../flows/types.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { queueSize } from '../workbench/queue.ts'
import type { ThreadPriority, ToolRun, WorkbenchState } from '../workbench/state.ts'
import { buildTimeline } from '../workbench/timeline.ts'
import type { ToolPresenter } from './tool-presenters.ts'
import { Button, NativeVirtualList } from './primitives.tsx'
import { FlowScheduleIntake } from './flow-schedule-intake.tsx'
import { FlowLabelPicker, FlowLabelPills, FlowPriorityPicker } from './flow-metadata.tsx'
import { FlowRail, statusTone, type FlowRailShape } from './flow-rail.tsx'
import { Icon, type IconName } from './icons.tsx'
import { useResponsiveLayout } from './responsive.tsx'
import { colors, nativeTheme } from './theme.ts'
import { LAYOUT_MOTION_TRANSITION, MotionDiv } from './motion.ts'

type FlowTab = 'work' | 'triage' | 'scheduled'
type WorkFilter = 'all' | 'active' | 'scheduled' | 'waiting' | 'done'
type TriageFilter = 'all' | 'unread' | 'failed' | 'succeeded'

interface FlowWorkGroup {
  id: string
  title: string
  detail?: string | undefined
  source: FlowRunProjection['source']
  tasks: Array<{ task: FlowTaskProjection; run: FlowRunProjection }>
  updatedAt: number
}

type WorkRenderRow =
  | { id: string; kind: 'group'; group: FlowWorkGroup }
  | { id: string; kind: 'task'; group: FlowWorkGroup; run: FlowRunProjection; task: FlowTaskProjection; index: number; count: number }
  | { id: 'flows-settled-header'; kind: 'settled-header'; count: number; expanded: boolean }
  | { id: string; kind: 'settled-task'; run: FlowRunProjection; task: FlowTaskProjection; index: number; count: number }
  | { id: 'flows-work-empty'; kind: 'empty' }

type TriageRenderRow = { id: string; task: FlowTaskProjection }
type ScheduleRenderRow = { id: string; schedule: FlowSchedule; index: number; count: number }

const INITIAL_PROJECTED_ROWS = 96
const PROJECTION_CHUNK_ROWS = 96
const PROJECTION_FRAME_MS = 16
const FLOW_CONTENT_MAX_WIDTH = 1_152
const FLOW_ACTIVITY_MESSAGE_LIMIT = 480
const FLOW_ACTIVITY_CACHE_LIMIT = 12
const flowActivityHistory = new Map<string, Promise<PiMessage[]>>()
const EMPTY_FLOW_MESSAGES: PiMessage[] = []
const EMPTY_FLOW_TOOLS: ToolRun[] = []

interface FlowsViewProps {
  state: WorkbenchState
  controller: WorkbenchController
  runtime: FlowRuntime
  presenters: ReadonlyMap<string, ToolPresenter>
  titlebarInset?: number | undefined
  onClose(): void
  onOpenSession(session: PiSessionSummary): void
}

export const FlowsView = memo(function FlowsView({ state, controller, runtime, titlebarInset, onClose, onOpenSession }: FlowsViewProps) {
  const layout = useResponsiveLayout()
  const runtimeState = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
  const projectionNow = useProjectionClock()
  const runs = useProjectedFlowRuns(state, projectionNow)
  const [tab, setTab] = useState<FlowTab>('work')
  const [scheduleCreating, setScheduleCreating] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>()
  const selectedRun = useMemo(() => runs.find((run) => run.tasks.some((task) => task.id === selectedTaskId)), [runs, selectedTaskId])
  const selectedTask = selectedRun?.tasks.find((task) => task.id === selectedTaskId)
  const totals = useMemo(() => flowTotals(runs), [runs])
  const priorityCounts = useMemo(() => flowPriorityCounts(runs), [runs])
  const labelOptions = useMemo(() => [...new Set(Object.values(state.threadLifecycle).flatMap((metadata) => metadata.labels ?? []))].toSorted((left, right) => left.localeCompare(right)), [state.threadLifecycle])
  const switchTab = (next: FlowTab) => {
    setTab(next)
    setSelectedTaskId(undefined)
    setScheduleCreating(false)
  }
  const openQueueComposer = async () => {
    if (!state.session.isStreaming && state.messages.length > 0 && queueSize(state.queue) === 0) await controller.newSession()
    onClose()
  }
  const titleInset = titlebarInset ?? (hasNativeTrafficLights() ? 132 : layout.compact ? 54 : 24)

  return (
    <div testId="flows-view" style={{ width: 0, minWidth: 0, flexGrow: 1, height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: colors.background, overflow: 'hidden' }}>
      <MotionDiv initial={false} animate={{ paddingLeft: titleInset }} transition={LAYOUT_MOTION_TRANSITION} testId="flows-header" style={{ height: 72, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: titleInset, paddingRight: layout.mobile ? 12 : 22, paddingBottom: 8, borderBottomWidth: 1, borderColor: colors.border }}>
        <div testId="flows-title-block" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2, marginTop: 15 }}>
          <text testId="flows-title" style={{ color: colors.text, fontSize: 16, fontWeight: 720 }}>Flows</text>
          <text testId="flows-summary" style={{ color: colors.textFaint, fontSize: 10, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`${totals.active} active · ${totals.waiting} waiting · ${totals.done} complete`}</text>
        </div>
        <div style={{ flexGrow: 1 }} />
        <Button label={layout.mobile ? 'Chat' : 'Back to chat'} tone="quiet" compact icon="x" onClick={onClose} />
      </MotionDiv>
      <div testId="flows-tabs" style={{ height: 42, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'flex-end', gap: 2, paddingLeft: layout.contentGutter, paddingRight: layout.contentGutter, borderBottomWidth: 1, borderColor: colors.border }}>
        <FlowTabButton id="work" active={tab === 'work'} label="Work" count={totals.all} icon="list" onClick={() => switchTab('work')} />
        <FlowTabButton id="triage" active={tab === 'triage'} label="Triage" count={totals.done} icon="wrench" onClick={() => switchTab('triage')} />
        <FlowTabButton id="scheduled" active={tab === 'scheduled'} label="Scheduled" count={runtimeState.schedules.length} icon="clock" onClick={() => switchTab('scheduled')} />
      </div>
      <div style={{ height: 0, flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
        {tab === 'work' && selectedTask && selectedRun ? (
          <TaskPage task={selectedTask} run={selectedRun} controller={controller} priorityCounts={priorityCounts} labelOptions={labelOptions} onBack={() => setSelectedTaskId(undefined)} onOpenSession={onOpenSession} />
        ) : tab === 'work' ? (
          <WorkPage runs={runs} state={state} controller={controller} priorityCounts={priorityCounts} onQueueInChat={() => { void openQueueComposer() }} onOpenTask={(task) => setSelectedTaskId(task.id)} />
        ) : tab === 'triage' ? (
          <TriagePage runs={runs} controller={controller} onOpenTask={(task) => { setSelectedTaskId(task.id); setTab('work') }} />
        ) : (
          <ScheduledPage schedules={runtimeState.schedules} pendingCount={runtimeState.pending.length} state={state} runtime={runtime} creating={scheduleCreating} onCreating={setScheduleCreating} controller={controller} />
        )}
      </div>
    </div>
  )
}, flowsViewPropsEqual)

function WorkPage({ runs, state, controller, priorityCounts, onQueueInChat, onOpenTask }: {
  runs: FlowRunProjection[]
  state: WorkbenchState
  controller: WorkbenchController
  priorityCounts: Readonly<Record<ThreadPriority, number>>
  onQueueInChat(): void
  onOpenTask(task: FlowTaskProjection): void
}) {
  const layout = useResponsiveLayout()
  const [filter, setFilter] = useState<WorkFilter>('all')
  const [query, setQuery] = useState('')
  const [settledExpanded, setSettledExpanded] = useState(false)
  const deferredQuery = useDeferredValue(query)
  const groups = useMemo(() => buildWorkGroups(runs, filter, deferredQuery), [deferredQuery, filter, runs])
  const settled = useMemo(() => runs.flatMap((run) => run.tasks.map((task) => ({ task, run })))
    .filter(({ task, run }) => task.settled && matchesWorkFilter(task, filter) && matchesTaskQuery(task, deferredQuery, run.title))
    .toSorted((left, right) => right.task.updatedAt - left.task.updatedAt || left.task.id.localeCompare(right.task.id)), [deferredQuery, filter, runs])
  const counts = useMemo(() => workFilterCounts(runs), [runs])
  const revealSettled = settledExpanded || deferredQuery.trim().length > 0
  const rows = useMemo<WorkRenderRow[]>(() => {
    const next: WorkRenderRow[] = []
    for (const group of groups) {
      next.push({ id: `group:${group.id}`, kind: 'group', group })
      group.tasks.forEach(({ task, run }, index) => next.push({ id: `task:${task.runId}:${task.id}`, kind: 'task', group, run, task, index, count: group.tasks.length }))
    }
    if (settled.length > 0) {
      next.push({ id: 'flows-settled-header', kind: 'settled-header', count: settled.length, expanded: revealSettled })
      if (revealSettled) settled.forEach(({ task, run }, index) => next.push({ id: `settled:${task.runId}:${task.id}`, kind: 'settled-task', run, task, index, count: settled.length }))
    }
    if (groups.length === 0 && settled.length === 0) next.push({ id: 'flows-work-empty', kind: 'empty' })
    return next
  }, [groups, revealSettled, settled])
  const projectionKey = `${filter}:${deferredQuery.trim().toLowerCase()}:${revealSettled}:${rows.length}:${rows[0]?.id ?? ''}:${rows.at(-1)?.id ?? ''}`
  const { projected, remaining } = useProgressiveRows(rows, projectionKey)
  const alignedContentWidth = FLOW_CONTENT_MAX_WIDTH - 6

  return (
    <div testId="flows-work" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div testId="flows-work-toolbar" style={{ minHeight: layout.mobile ? 104 : 62, flexShrink: 0, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingLeft: layout.contentGutter, paddingRight: layout.contentGutter, paddingTop: 10, paddingBottom: 10 }}>
        <div testId="flows-work-toolbar-content" style={{ width: '100%', maxWidth: alignedContentWidth, minWidth: 0, display: 'flex', flexDirection: layout.mobile ? 'column' : 'row', alignItems: layout.mobile ? 'stretch' : 'center', gap: 8 }}>
          <div testId="flows-search-frame" style={{ height: 32, width: layout.mobile ? '100%' : 250, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 9, paddingRight: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input }}>
            <Icon name="search" size={12} color={colors.textFaint} />
            <input testId="flows-search" value={query} placeholder="Search projected work…" theme={{ caret: colors.text, text: colors.text, textMuted: colors.placeholder, bg: colors.transparent }} style={{ height: 28, minWidth: 0, flexGrow: 1, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 10 }} onChange={(event) => setQuery(String(event.value ?? ''))} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 3, minWidth: 0 }}>
            <FilterButton testId="flow-filter-all" label="All" count={counts.all} active={filter === 'all'} onClick={() => setFilter('all')} />
            <FilterButton label="Active" count={counts.active} active={filter === 'active'} onClick={() => setFilter('active')} />
            {!layout.mobile && <FilterButton label="Scheduled" count={counts.scheduled} active={filter === 'scheduled'} onClick={() => setFilter('scheduled')} />}
            <FilterButton label="Waiting" count={counts.waiting} active={filter === 'waiting'} onClick={() => setFilter('waiting')} />
            <FilterButton label="Done" count={counts.done} active={filter === 'done'} onClick={() => setFilter('done')} />
          </div>
          {!layout.mobile && <div style={{ flexGrow: 1 }} />}
          <Button testId="flows-queue-in-chat" label={layout.mobile ? 'Queue' : 'Queue in chat'} tone="primary" icon="squarePen" compact onClick={onQueueInChat} />
        </div>
      </div>
      <div testId="flows-work-scroll-surface" style={{ height: 0, flexGrow: 1, minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingLeft: layout.contentGutter, paddingRight: layout.contentGutter }}>
        <NativeVirtualList testId="flows-work-list" alignment="top" estimatedItemHeight={42} overdraw={240} style={{ flexGrow: 1, minHeight: 0, width: '100%', maxWidth: alignedContentWidth }}>
          {projected.map((row) => {
            if (row.kind === 'group') return <WorkGroupHeader key={row.id} group={row.group} />
            if (row.kind === 'settled-header') return <SettledWorkHeader key={row.id} count={row.count} expanded={row.expanded} onToggle={() => setSettledExpanded((value) => !value)} />
            if (row.kind === 'empty') return <div key={row.id} style={contentRowStyle(0)}><EmptyState icon="gitBranch" title="No projected work" detail={query.trim() ? 'No Pi session or queued row matches this search.' : 'Queue work in chat or start a Pi session. Work appears here automatically.'} /></div>
            const activeFabric = Boolean(row.task.session && (row.task.session.id === state.session.sessionId || row.task.session.path === state.session.sessionFile))
            return <WorkTaskRow key={row.id} row={row} mobile={layout.mobile} compact={layout.compact} activeFabric={activeFabric} controller={controller} priorityCounts={priorityCounts} onOpenTask={onOpenTask} />
          })}
          {remaining > 0 && <ProjectionContinuation key="flows-work-continuation" remaining={remaining} />}
        </NativeVirtualList>
      </div>
    </div>
  )
}

const WorkTaskRow = memo(function WorkTaskRow({ row, mobile, compact, activeFabric, controller, priorityCounts, onOpenTask }: {
  row: Extract<WorkRenderRow, { kind: 'task' | 'settled-task' }>
  mobile: boolean
  compact: boolean
  activeFabric: boolean
  controller: WorkbenchController
  priorityCounts: Readonly<Record<ThreadPriority, number>>
  onOpenTask(task: FlowTaskProjection): void
}) {
  const { task } = row
  const dependency = taskDependency(task, row.run)
  return (
    <div style={{ ...contentRowStyle(0), minHeight: 42 }}>
      <div testId={`flow-task-${task.id}`} style={{ width: '100%', height: 42, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', backgroundColor: colors.transparent, opacity: task.settled ? 0.78 : 1, hover: { backgroundColor: colors.hover } }}>
        <div testId={`flow-priority-slot-${task.id}`} style={{ flexShrink: 0, marginLeft: 10, marginRight: 8 }}><FlowPriorityPicker priority={task.priority} overridden={task.priorityOverridden} counts={priorityCounts} monochrome testId={`flow-priority-${task.id}`} onChange={(priority) => controller.setThreadPriority(task.metadataKey, priority)} /></div>
        <div testId={`flow-task-open-${task.id}`} tabIndex={0} style={{ width: 0, minWidth: 0, height: '100%', flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', backgroundColor: colors.transparent, cursor: 'pointer' }} onClick={() => onOpenTask(task)}>
          <text style={{ width: mobile ? 72 : 98, flexShrink: 0, color: task.settled ? colors.settledText : colors.textMuted, fontSize: 9, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{task.id}</text>
          <div style={{ width: 25, flexShrink: 0, display: 'flex', alignItems: 'center', pointerEvents: 'none' }}><StatusGlyph status={task.status} /></div>
          <text style={{ width: 0, minWidth: 0, flexGrow: 1, color: task.settled ? colors.settledText : colors.text, fontSize: 11, fontWeight: 520, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{task.title}</text>
          {!compact && task.labels.length > 0 && <div style={{ width: 154, minWidth: 0, flexShrink: 0, marginLeft: 14, marginRight: 10, pointerEvents: 'none' }}><FlowLabelPills labels={task.labels} /></div>}
        </div>
        {!compact && task.settled && <Button testId={`unsettle-${task.id}`} label="Unsettle" tone="quiet" icon="undo" compact onClick={() => controller.wakeThread(task.metadataKey)} />}
        {activeFabric
          ? <ActiveFabricRail task={task} dependency={dependency} controller={controller} mobile={mobile} onOpenTask={onOpenTask} />
          : <WorkTaskRail task={task} dependency={dependency} mobile={mobile} onOpenTask={onOpenTask} />}
      </div>
      {activeFabric && <ActiveFabricWorkGraph task={task} controller={controller} compact={compact} />}
    </div>
  )
})

function WorkTaskRail({ task, dependency, mobile, onOpenTask, fabricAfter = false }: {
  task: FlowTaskProjection
  dependency: ReturnType<typeof taskDependency>
  mobile: boolean
  onOpenTask(task: FlowTaskProjection): void
  fabricAfter?: boolean
}) {
  return <div tabIndex={0} style={{ flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', marginLeft: 10, backgroundColor: colors.transparent, cursor: 'pointer' }} onClick={() => onOpenTask(task)}><FlowRail status={task.status} before={dependency.before} after={dependency.after || fabricAfter} lane={dependency.lane} branchFrom={dependency.branchFrom} label={dependency.label} detail={dependency.detail} shape={dependency.shape} compact={mobile} /><div style={{ width: 11, height: 11, pointerEvents: 'none' }}><Icon name="chevronRight" size={11} color={colors.textFaint} /></div></div>
}

function ActiveFabricRail({ task, dependency, controller, mobile, onOpenTask }: {
  task: FlowTaskProjection
  dependency: ReturnType<typeof taskDependency>
  controller: WorkbenchController
  mobile: boolean
  onOpenTask(task: FlowTaskProjection): void
}) {
  const graph = useActiveFabricGraph(task, controller)
  return <WorkTaskRail task={task} dependency={dependency} mobile={mobile} onOpenTask={onOpenTask} fabricAfter={graph.branches.length > 0} />
}

function ActiveFabricWorkGraph({ task, controller, compact }: { task: FlowTaskProjection; controller: WorkbenchController; compact: boolean }) {
  const graph = useActiveFabricGraph(task, controller)
  if (graph.branches.length === 0) return null
  return <FabricBranchRows graph={graph} compact={compact} embedded />
}

function useActiveFabricGraph(task: FlowTaskProjection, controller: WorkbenchController): FlowFabricProjection {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return useMemo(() => projectFlowFabricGraph(task, state.messages, state.liveTools), [state.liveTools, state.messages, task])
}

function SettledWorkHeader({ count, expanded, onToggle }: { count: number; expanded: boolean; onToggle(): void }) {
  return (
    <div testId="flows-settled-toggle" tabIndex={0} style={{ ...contentRowStyle(0), height: 52, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingLeft: 10, paddingRight: 9, borderTopWidth: 1, borderColor: colors.settledDivider, cursor: 'pointer' }} onClick={onToggle}>
      <div style={{ width: 13, height: 13, pointerEvents: 'none' }}><Icon name="list" size={13} color={colors.settledIcon} /></div>
      <text style={{ color: colors.settledText, fontSize: 10, fontWeight: 650, pointerEvents: 'none' }}>Settled</text>
      <text style={{ color: colors.settledMeta, fontSize: 9, pointerEvents: 'none' }}>{`Sessions · ${count}`}</text>
      <div style={{ height: 1, flexGrow: 1, backgroundColor: colors.settledDivider, pointerEvents: 'none' }} />
      <div style={{ width: 11, height: 11, pointerEvents: 'none' }}><Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={11} color={colors.settledText} /></div>
    </div>
  )
}

function WorkGroupHeader({ group }: { group: FlowWorkGroup }) {
  return (
    <div testId={`flow-run-${group.id}`} style={{ ...contentRowStyle(0), height: 56, display: 'flex', flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingLeft: 7, paddingRight: 7, paddingBottom: 9 }}>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: group.detail ? 2 : 0 }}>
        <div testId="flow-group-title-row" style={{ minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <div testId="flow-group-icon" style={{ width: 12, height: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={group.source === 'observed' ? 'folder' : group.source === 'scheduled' ? 'clock' : group.source === 'queue' ? 'list' : 'gitBranch'} size={12} color={colors.textFaint} /></div>
          <text testId="flow-group-title" style={{ minWidth: 0, color: colors.textMuted, fontSize: 11, fontWeight: 650, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{group.title}</text>
        </div>
        {group.detail && <text style={{ paddingLeft: 19, color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{group.detail}</text>}
      </div>
      <div style={{ flexGrow: 1 }} />
      <text style={{ color: colors.textFaint, fontSize: 9 }}>{formatFlowDate(group.updatedAt)}</text>
    </div>
  )
}

function TaskPage({ task, run, controller, priorityCounts, labelOptions, onBack, onOpenSession }: {
  task: FlowTaskProjection
  run: FlowRunProjection
  controller: WorkbenchController
  priorityCounts: Readonly<Record<ThreadPriority, number>>
  labelOptions: readonly string[]
  onBack(): void
  onOpenSession(session: PiSessionSummary): void
}) {
  const layout = useResponsiveLayout()
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const transcript = useTaskTranscript(task, state)
  const fabric = useMemo(() => projectFlowFabricGraph(task, transcript.messages, transcript.liveTools), [task, transcript.liveTools, transcript.messages])
  const phases = state.queue.items.filter((item) => item.flow?.taskId === task.id).map((item) => item.flow?.phase).filter((phase): phase is NonNullable<typeof phase> => Boolean(phase))
  const previous = run.tasks.find((candidate) => candidate.taskIndex === task.taskIndex - 1)
  const next = run.tasks.find((candidate) => candidate.taskIndex === task.taskIndex + 1)
  const asideWidth = layout.compact ? '100%' : 286

  return (
    <div testId="flow-task-page" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ minHeight: 50, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7, paddingLeft: layout.contentGutter, paddingRight: layout.contentGutter, borderBottomWidth: 1, borderColor: colors.border }}>
        <Button testId="flow-task-back" label={layout.mobile ? 'Work' : 'Back to work'} tone="quiet" icon="chevronLeft" compact onClick={onBack} />
        <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontMono }}>{task.id}</text>
        <div style={{ flexGrow: 1 }} />
        {task.settled && <Button testId="flow-task-unsettle" label="Unsettle" tone="quiet" icon="undo" compact onClick={() => controller.wakeThread(task.metadataKey)} />}
        {task.queueItemIds.length > 0 && <Button testId="flow-cancel-queue" label={task.mode === 'queue' ? 'Remove queued row' : 'Cancel queue'} tone="danger" compact onClick={() => {
          if (task.mode === 'queue') task.queueItemIds.forEach((id) => controller.removeQueuedInput(id))
          else controller.removeQueuedFlow(task.runId)
        }} />}
        {task.session && <Button testId="flow-open-thread" label="Open thread" icon="squarePen" compact onClick={() => { void controller.switchSession(task.session!).then(() => onOpenSession(task.session!)) }} />}
      </div>
      <div testId="flow-task-scroll" style={{ height: 0, flexGrow: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowX: 'hidden', overflowY: 'scroll', paddingLeft: layout.contentGutter, paddingRight: layout.contentGutter }}>
        <div style={{ width: '100%', maxWidth: 1120, minWidth: 0, flexShrink: 0, alignSelf: 'center', display: 'flex', flexDirection: layout.compact ? 'column' : 'row', alignItems: 'flex-start', gap: layout.compact ? 24 : 44, paddingTop: layout.mobile ? 18 : 28, paddingBottom: 40 }}>
          <div style={{ width: layout.compact ? '100%' : 0, maxWidth: '100%', minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 22 }}>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}><StatusGlyph status={task.status} /><text style={{ color: statusTone(task.status), fontSize: 10, fontWeight: 650 }}>{statusLabel(task.status)}</text></div>
              <text style={{ color: colors.text, fontSize: layout.mobile ? 20 : 24, lineHeight: layout.mobile ? 27 : 32, fontWeight: 720 }}>{task.title}</text>
              <text style={{ color: colors.textFaint, fontSize: 10 }}>{`Updated ${formatFlowDate(task.updatedAt)}`}</text>
            </div>
            <DisclosureTaskSection key={`prompt:${task.id}`} title="Prompt" testId="flow-task-prompt" collapsedHeight={95}><text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 19, whiteSpace: 'normal' }}>{task.prompt || 'The prompt has not reached its queue step yet.'}</text></DisclosureTaskSection>
            {phases.length > 0 && <TaskSection title="Queue primitives"><div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{phases.map((phase, index) => <MetaPill key={`${phase}-${index}`} label={phaseLabel(phase)} />)}</div></TaskSection>}
            {fabric.branches.length > 0 && <FabricBranches graph={fabric} compact={layout.mobile} />}
            <DisclosureTaskSection key={`output:${task.id}`} title={task.status === 'failed' ? 'Failure' : 'Output'} testId="flow-task-output" collapsedHeight={160}>
              {task.result ? <div testId="flow-task-result-card" style={{ width: '100%', maxWidth: '100%', minWidth: 0, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.code, overflow: 'hidden' }}><text testId="flow-task-result-text" style={{ width: '100%', minWidth: 0, color: task.status === 'failed' ? colors.error : colors.textMuted, fontSize: 10, lineHeight: 17, whiteSpace: 'normal' }}>{task.result}</text></div> : <text style={{ color: colors.textFaint, fontSize: 11, lineHeight: 17 }}>{task.status === 'running' ? 'Pi is still working. Output will settle from the session transcript.' : 'No assistant output has been projected yet.'}</text>}
            </DisclosureTaskSection>
            <ActivityLog entries={transcript.activity} />
          </div>
          <div style={{ width: asideWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, overflow: 'hidden' }}>
              <TaskProperty label="Status"><div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}><FlowRail status={task.status} before={false} after={false} compact /><StatusText status={task.status} /></div></TaskProperty>
              <TaskProperty label="Priority"><FlowPriorityPicker priority={task.priority} overridden={task.priorityOverridden} counts={priorityCounts} showLabel monochrome testId="flow-priority-detail" onChange={(priority) => controller.setThreadPriority(task.metadataKey, priority)} /></TaskProperty>
              <TaskProperty label="Labels"><FlowLabelPicker selected={task.labels} options={labelOptions} onChange={(labels) => controller.setThreadLabels(task.metadataKey, labels)} /></TaskProperty>
              <TaskProperty label="Model" value={task.model ?? 'Session default'} />
              {task.scheduleId && <TaskProperty label="Schedule" value={task.scheduleId} />}
              <TaskProperty label="Created" value={formatFlowDate(task.createdAt)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 700 }}>DEPENDENCIES</text>
              {previous ? <DependencyRow relation="Blocked by" task={previous} onOpen={onBack} /> : <DependencyEmpty label="No prerequisite" />}
              {next ? <DependencyRow relation="Blocks" task={next} onOpen={onBack} /> : <DependencyEmpty label="No downstream step" />}
            </div>
            <text style={{ color: colors.textFaint, fontSize: 9, lineHeight: 14 }}>Status and output remain projected from Pi queue, session, and Fabric activity. Only presentation preferences are stored.</text>
          </div>
        </div>
      </div>
    </div>
  )
}

function ActivityLog({ entries }: { entries: readonly FlowActivityEntry[] }) {
  return (
    <TaskSection title="Activity">
      <div testId="flow-activity" style={{ width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {entries.map((entry, index) => (
          <div key={entry.id} testId="flow-activity-entry" style={{ minHeight: 40, width: '100%', minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9 }}>
            <div style={{ position: 'relative', width: 20, minHeight: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {index > 0 && <div style={{ position: 'absolute', left: 9, top: 0, width: 1, height: 12, backgroundColor: colors.borderStrong }} />}
              {index < entries.length - 1 && <div style={{ position: 'absolute', left: 9, top: 28, bottom: 0, width: 1, backgroundColor: colors.borderStrong }} />}
              <ActivityGlyph entry={entry} />
            </div>
            <div style={{ width: 0, minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
              <text testId="flow-activity-title" style={{ flexShrink: 0, color: colors.text, fontSize: 10, fontWeight: 620, whiteSpace: 'nowrap' }}>{entry.title}</text>
              {entry.detail && <text testId="flow-activity-detail" style={{ minWidth: 0, color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{entry.detail}</text>}
            </div>
            <text style={{ flexShrink: 0, color: colors.textFaint, fontSize: 8, whiteSpace: 'nowrap' }}>{formatFlowDate(entry.timestamp)}</text>
          </div>
        ))}
      </div>
    </TaskSection>
  )
}

function ActivityGlyph({ entry }: { entry: FlowActivityEntry }) {
  const tone = entry.tone === 'error' ? colors.error : entry.tone === 'success' ? colors.success : colors.textFaint
  const icon: IconName = entry.kind === 'prompt' ? 'arrowUp' : entry.kind === 'context' ? 'files' : entry.kind === 'tools' ? 'wrench' : entry.kind === 'response' ? 'check' : entry.kind === 'status' && entry.tone === 'error' ? 'x' : entry.kind === 'status' ? 'check' : 'circle'
  return <div testId="flow-activity-icon" style={{ position: 'relative', width: 18, height: 18, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: colors.background }}><Icon name={icon} size={11} color={tone} /></div>
}

interface TaskTranscriptProjection {
  messages: PiMessage[]
  liveTools: ToolRun[]
  activity: FlowActivityEntry[]
}

function useTaskTranscript(task: FlowTaskProjection, state: WorkbenchState): TaskTranscriptProjection {
  const active = Boolean(task.session && (task.session.id === state.session.sessionId || task.session.path === state.session.sessionFile))
  const sessionPath = task.session?.path
  const historyKey = task.session ? `${task.session.path}:${task.session.modifiedAt}` : ''
  const [history, setHistory] = useState<{ key: string; messages: PiMessage[] } | undefined>()
  useEffect(() => {
    if (!sessionPath || active) return
    let cancelled = false
    void loadFlowActivityHistory(historyKey, sessionPath).then((messages) => {
      if (!cancelled) setHistory({ key: historyKey, messages })
    })
    return () => { cancelled = true }
  }, [active, historyKey, sessionPath])
  const messages = active ? state.messages : history?.key === historyKey ? history.messages : EMPTY_FLOW_MESSAGES
  const liveTools = active ? state.liveTools : EMPTY_FLOW_TOOLS
  const timeline = useMemo(() => buildTimeline(messages, active ? state.liveAssistant : undefined, liveTools, active ? state.forkMessages : [], 0, active ? state.notices : []), [active, liveTools, messages, state.forkMessages, state.liveAssistant, state.notices])
  const activity = useMemo(() => projectFlowActivity(task, timeline), [task, timeline])
  return useMemo(() => ({ messages, liveTools, activity }), [activity, liveTools, messages])
}

function loadFlowActivityHistory(key: string, path: string): Promise<PiMessage[]> {
  const cached = flowActivityHistory.get(key)
  if (cached) return cached
  const pending = new PiSessionHistoryPager(path).loadEarlier(FLOW_ACTIVITY_MESSAGE_LIMIT).then((page) => page.messages).catch(() => [])
  flowActivityHistory.set(key, pending)
  while (flowActivityHistory.size > FLOW_ACTIVITY_CACHE_LIMIT) flowActivityHistory.delete(flowActivityHistory.keys().next().value!)
  return pending
}

function FabricBranches({ graph, compact }: { graph: FlowFabricProjection; compact: boolean }) {
  return <TaskSection title="Fabric branches"><FabricBranchRows graph={graph} compact={compact} /></TaskSection>
}

function FabricBranchRows({ graph, compact, embedded = false }: { graph: FlowFabricProjection; compact: boolean; embedded?: boolean }) {
  return (
    <div testId="flow-fabric-graph" style={{ width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', borderRadius: embedded ? 0 : 9, borderWidth: embedded ? 0 : 1, borderColor: colors.border, backgroundColor: embedded ? colors.background : colors.card, overflow: 'hidden' }}>
      {graph.branches.map((branch, index) => {
        const status = fabricFlowStatus(branch.status)
        const lane = Math.min(3, branch.depth + 1)
        return (
          <div key={branch.id} testId={`flow-fabric-branch-${branch.id}`} style={{ minHeight: embedded ? 36 : 44, width: '100%', minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: embedded ? 48 + branch.depth * 10 : branch.depth * 10, paddingRight: embedded ? 11 : 8, borderTopWidth: index > 0 ? 1 : 0, borderColor: colors.border }}>
            <div style={{ width: 14, height: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 7 }}><Icon name="gitBranch" size={11} color={statusTone(status)} /></div>
            <div style={{ width: 0, minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <text style={{ color: colors.text, fontSize: embedded ? 10 : 11, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{branch.name}</text>
              <text style={{ color: colors.textFaint, fontSize: 8, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{branch.detail ?? branch.runner ?? branch.id}</text>
            </div>
            {!compact && <FabricStatusText status={branch.status} />}
            <FlowRail status={status} before={index > 0} after={index < graph.branches.length - 1 || Boolean(graph.join)} lane={lane} branchFrom={Math.max(0, lane - 1)} shape="circle" compact />
          </div>
        )
      })}
      {graph.join && (
        <div testId="flow-fabric-join" style={{ minHeight: embedded ? 38 : 44, width: '100%', minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: embedded ? 48 : 0, paddingRight: embedded ? 11 : 8, borderTopWidth: 1, borderColor: colors.border }}>
          <div style={{ width: 14, height: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 7 }}><Icon name="check" size={11} color={statusTone(fabricFlowStatus(graph.join.status))} /></div>
          <div style={{ width: 0, minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}><text style={{ color: colors.text, fontSize: embedded ? 10 : 11, fontWeight: 650 }}>Join</text><text style={{ color: colors.textFaint, fontSize: 8 }}>{graph.join.detail}</text></div>
          {!compact && <FabricStatusText status={graph.join.status} />}
          <FlowRail status={fabricFlowStatus(graph.join.status)} before after={false} lane={0} shape="square" compact />
        </div>
      )}
      {graph.truncated && <text testId="flow-fabric-truncated" style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6, color: colors.textFaint, fontSize: 8 }}>Additional nested branches are outside the Fabric preview budget.</text>}
    </div>
  )
}

function FabricStatusText({ status }: { status: FabricBranchStatus }) {
  return <text style={{ marginRight: 5, color: statusTone(fabricFlowStatus(status)), fontSize: 8, fontWeight: 600 }}>{status === 'stopped' ? 'Stopped' : statusLabel(status)}</text>
}

function fabricFlowStatus(status: FabricBranchStatus): FlowTaskStatus {
  return status === 'stopped' ? 'failed' : status
}

function TriagePage({ runs, controller, onOpenTask }: { runs: FlowRunProjection[]; controller: WorkbenchController; onOpenTask(task: FlowTaskProjection): void }) {
  const layout = useResponsiveLayout()
  const [filter, setFilter] = useState<TriageFilter>('all')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const terminal = useMemo(() => terminalFlowTasks(runs), [runs])
  const unreadCount = terminal.filter((task) => task.unread).length
  const failedCount = terminal.filter((task) => task.status === 'failed').length
  const succeededCount = terminal.filter((task) => task.status === 'succeeded').length
  const visible = useMemo(() => terminal.filter((task) => matchesTriageFilter(task, filter) && matchesTaskQuery(task, deferredQuery)), [deferredQuery, filter, terminal])
  const selected = (selectedId ? terminal.find((task) => task.id === selectedId) : undefined) ?? (!layout.compact ? visible[0] : undefined)
  const rows = useMemo<TriageRenderRow[]>(() => visible.map((task) => ({ id: `triage:${task.runId}:${task.id}`, task })), [visible])
  const projectionKey = `${filter}:${deferredQuery}:${rows.length}:${rows[0]?.id ?? ''}:${rows.at(-1)?.id ?? ''}`
  const { projected, remaining } = useProgressiveRows(rows, projectionKey)
  useEffect(() => {
    if (selected?.unread) controller.markThreadRead(selected.metadataKey, selected.updatedAt)
  }, [controller, selected?.metadataKey, selected?.unread, selected?.updatedAt])

  if (layout.compact && selected) return <TriageDetail task={selected} onBack={() => setSelectedId(undefined)} onOpenTask={onOpenTask} />
  return (
    <div testId="flows-triage" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ minHeight: layout.mobile ? 100 : 62, flexShrink: 0, display: 'flex', flexDirection: layout.mobile ? 'column' : 'row', alignItems: layout.mobile ? 'stretch' : 'center', gap: layout.mobile ? 7 : 7, paddingLeft: layout.contentGutter, paddingRight: layout.contentGutter, paddingTop: layout.mobile ? 10 : 0, paddingBottom: layout.mobile ? 8 : 0 }}>
        <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><text style={{ color: colors.text, fontSize: 13, fontWeight: 680 }}>Triage</text><text style={{ color: colors.textFaint, fontSize: 9 }}>{`${unreadCount} unread result${unreadCount === 1 ? '' : 's'}`}</text></div>
          <div style={{ flexGrow: 1 }} />
          <Button testId="triage-mark-all-read" label="Mark all as read" tone="quiet" icon="check" compact disabled={unreadCount === 0} onClick={() => controller.markThreadsRead(terminal.filter((task) => task.unread).map((task) => ({ path: task.metadataKey, updatedAt: task.updatedAt })))} />
        </div>
        <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <FilterButton label="All" count={terminal.length} active={filter === 'all'} onClick={() => setFilter('all')} />
          <FilterButton testId="triage-filter-unread" label="Unread" count={unreadCount} active={filter === 'unread'} onClick={() => setFilter('unread')} />
          <FilterButton testId="triage-filter-failed" label="Failed" count={failedCount} active={filter === 'failed'} onClick={() => setFilter('failed')} />
          <FilterButton testId="triage-filter-succeeded" label="Succeeded" count={succeededCount} active={filter === 'succeeded'} onClick={() => setFilter('succeeded')} />
        </div>
      </div>
      <div style={{ height: 0, flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'row', borderTopWidth: 1, borderColor: colors.border, overflow: 'hidden' }}>
        <div testId="triage-list-pane" style={{ width: layout.compact ? '100%' : selected ? '46%' : '100%', minWidth: layout.compact ? 0 : 320, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div testId="triage-search-row" style={{ height: 46, flexShrink: 0, display: 'flex', flexDirection: 'row', paddingLeft: 12, paddingRight: 12, paddingTop: 7, paddingBottom: 7, borderBottomWidth: 1, borderColor: colors.border }}>
            <div testId="triage-search-frame" style={{ width: 0, minWidth: 0, flexGrow: 1, height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 9, paddingRight: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input }}><Icon name="search" size={12} color={colors.textFaint} /><input testId="triage-search" value={query} placeholder="Search results…" theme={{ caret: colors.text, text: colors.text, textMuted: colors.placeholder, bg: colors.transparent }} style={{ minWidth: 0, flexGrow: 1, height: 28, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 10 }} onChange={(event) => setQuery(String(event.value ?? ''))} /></div>
          </div>
          <NativeVirtualList testId="flows-triage-list" alignment="top" estimatedItemHeight={64} overdraw={240} style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
            {projected.map(({ id, task }) => <TriageRow key={id} task={task} selected={selected?.id === task.id} onClick={() => setSelectedId(task.id)} />)}
            {remaining > 0 && <ProjectionContinuation key="flows-triage-continuation" remaining={remaining} />}
            {visible.length === 0 && <div key="triage-empty"><EmptyState icon="list" title="Nothing to triage" detail="Completed and failed session results will appear here." /></div>}
          </NativeVirtualList>
        </div>
        {selected && !layout.compact && <TriageDetail task={selected} onOpenTask={onOpenTask} />}
      </div>
    </div>
  )
}

const TriageRow = memo(function TriageRow({ task, selected, onClick }: { task: FlowTaskProjection; selected: boolean; onClick(): void }) {
  return (
    <div testId={`triage-task-${task.id}`} tabIndex={0} style={{ height: 64, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 10, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: selected ? colors.sidebarActive : colors.transparent, overflow: 'hidden', cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClick}>
      <FlowRail status={task.status} before={false} after={false} compact />
      <div style={{ width: 0, minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
        <text style={{ height: 15, minWidth: 0, color: colors.text, fontSize: 11, lineHeight: 15, fontWeight: task.unread ? 700 : 560, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{singleLinePreview(task.title)}</text>
        <text style={{ height: 13, minWidth: 0, color: colors.textFaint, fontSize: 9, lineHeight: 13, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`${task.id} · ${formatFlowDate(task.updatedAt)}`}</text>
        <text testId="triage-preview" style={{ height: 14, minWidth: 0, color: colors.textMuted, fontSize: 9, lineHeight: 14, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{singleLinePreview(task.result ?? task.stopReason ?? task.status)}</text>
      </div>
      {task.unread && <div testId="triage-unread-dot" style={{ width: 7, height: 7, flexShrink: 0, borderRadius: 4, backgroundColor: colors.primary }} />}
      <StatusText status={task.status} />
    </div>
  )
})

function TriageDetail({ task, onBack, onOpenTask }: { task: FlowTaskProjection; onBack?(): void; onOpenTask(task: FlowTaskProjection): void }) {
  const compact = Boolean(onBack)
  return (
    <div testId="triage-detail" style={{ width: compact ? '100%' : '54%', minWidth: 0, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', borderLeftWidth: compact ? 0 : 1, borderColor: colors.border, overflow: 'hidden' }}>
      <NativeVirtualList testId="triage-detail-list" alignment="top" estimatedItemHeight={96} overdraw={180} style={{ width: '100%', flexGrow: 1, minHeight: 0, overflowX: 'hidden' }}>
        <div key="triage-actions" style={{ alignSelf: 'stretch', minWidth: 0, height: 52, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 20, paddingRight: 20, paddingTop: 10 }}>
          {onBack && <Button testId="triage-back" label="Back" tone="quiet" icon="chevronLeft" compact onClick={onBack} />}
          <StatusGlyph status={task.status} />
          <StatusText status={task.status} />
          <div style={{ flexGrow: 1 }} />
          <Button testId="triage-open-task" label="Open task" compact onClick={() => onOpenTask(task)} />
        </div>
        <div key="triage-heading" style={{ alignSelf: 'stretch', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7, paddingLeft: 20, paddingRight: 20, paddingTop: 8, paddingBottom: 16 }}>
          <text testId="triage-detail-title" style={{ width: '100%', minWidth: 0, color: colors.text, fontSize: 18, lineHeight: 25, fontWeight: 700, whiteSpace: 'normal' }}>{task.title}</text>
          <text style={{ width: '100%', minWidth: 0, color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`${task.id} · ${formatFlowDate(task.updatedAt)}`}</text>
        </div>
        <div key="triage-prompt" style={{ alignSelf: 'stretch', minWidth: 0, paddingLeft: 20, paddingRight: 20 }}>
          <DisclosureTaskSection key={`triage-prompt:${task.id}`} title="Prompt" testId="triage-prompt" collapsedHeight={90}><text style={{ width: '100%', minWidth: 0, color: colors.textMuted, fontSize: 11, lineHeight: 18, whiteSpace: 'normal' }}>{task.prompt}</text></DisclosureTaskSection>
        </div>
        <div key="triage-output" style={{ alignSelf: 'stretch', minWidth: 0, paddingLeft: 20, paddingRight: 20, paddingBottom: 24 }}>
          <DisclosureTaskSection key={`triage-output:${task.id}`} title={task.status === 'failed' ? 'Failure' : 'Output'} testId="triage-output" collapsedHeight={160}>
            <div testId="triage-result-card" style={{ width: '100%', minWidth: 0, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.code, overflow: 'hidden' }}>
              <text testId="triage-result-text" style={{ width: '100%', minWidth: 0, color: task.status === 'failed' ? colors.error : colors.textMuted, fontSize: 10, lineHeight: 17, whiteSpace: 'normal' }}>{task.result ?? task.stopReason ?? 'No output projected.'}</text>
            </div>
          </DisclosureTaskSection>
        </div>
      </NativeVirtualList>
    </div>
  )
}

function ScheduledPage({ schedules, pendingCount, state, runtime, creating, onCreating, controller }: {
  schedules: readonly FlowSchedule[]
  pendingCount: number
  state: WorkbenchState
  runtime: FlowRuntime
  creating: boolean
  onCreating(value: boolean): void
  controller: WorkbenchController
}) {
  const layout = useResponsiveLayout()
  const rows = useMemo<ScheduleRenderRow[]>(() => schedules.map((schedule, index) => ({ id: `schedule:${schedule.id}`, schedule, index, count: schedules.length })), [schedules])
  const projectionKey = `${creating}:${rows.length}:${rows[0]?.id ?? ''}:${rows.at(-1)?.id ?? ''}`
  const { projected, remaining } = useProgressiveRows(rows, projectionKey)
  return (
    <div testId="flows-scheduled" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ minHeight: 62, flexShrink: 0, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div testId="flows-scheduled-header-content" style={{ width: '100%', maxWidth: FLOW_CONTENT_MAX_WIDTH, minWidth: 0, minHeight: 62, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: layout.contentGutter, paddingRight: layout.contentGutter }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}><text style={{ color: colors.text, fontSize: 13, fontWeight: 680 }}>Scheduled jobs</text><text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{pendingCount > 0 ? `${pendingCount} due occurrence${pendingCount === 1 ? '' : 's'} waiting for its workspace` : 'Each occurrence starts a fresh Flow session'}</text></div>
          <div style={{ flexGrow: 1 }} />
          <Button testId="new-schedule" label={creating ? 'Close intake' : 'New schedule'} tone={creating ? 'default' : 'primary'} icon={creating ? 'x' : 'plus'} compact onClick={() => onCreating(!creating)} />
        </div>
      </div>
      <div testId="flows-scheduled-scroll-surface" style={{ flexGrow: 1, minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <NativeVirtualList testId="flows-scheduled-list" alignment="top" estimatedItemHeight={64} overdraw={240} style={{ flexGrow: 1, minHeight: 0, width: '100%', maxWidth: FLOW_CONTENT_MAX_WIDTH, paddingLeft: layout.contentGutter, paddingRight: layout.contentGutter, paddingBottom: 28 }}>
          {creating && <div key="schedule-intake-row" style={contentRowStyle(18)}><FlowScheduleIntake state={state} runtime={runtime} onCreated={() => onCreating(false)} onCancel={() => onCreating(false)} /></div>}
          {projected.map(({ id, schedule }) => <ScheduleRow key={id} schedule={schedule} mobile={layout.mobile} runtime={runtime} controller={controller} />)}
          {remaining > 0 && <ProjectionContinuation key="flows-schedule-continuation" remaining={remaining} />}
          {schedules.length === 0 && !creating && <div key="schedules-empty" style={contentRowStyle(0)}><EmptyState icon="clock" title="No scheduled jobs" detail="Create a one-time, interval, or daily Flow. Pi sessions remain the run history." /></div>}
        </NativeVirtualList>
      </div>
    </div>
  )
}

const ScheduleRow = memo(function ScheduleRow({ schedule, mobile, runtime, controller }: { schedule: FlowSchedule; mobile: boolean; runtime: FlowRuntime; controller: WorkbenchController }) {
  return (
    <div style={{ ...contentRowStyle(0), minHeight: mobile ? 98 : 64, paddingBottom: 7 }}>
      <div testId={`schedule-${schedule.id}`} style={{ minHeight: mobile ? 91 : 57, width: '100%', minWidth: 0, display: 'flex', flexDirection: mobile ? 'column' : 'row', alignItems: mobile ? 'stretch' : 'center', gap: mobile ? 8 : 10, padding: 10, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', minWidth: 0, flexGrow: 1, gap: 8 }}>
          <FlowRail status={schedule.enabled ? 'queued' : 'paused'} before={false} after={false} shape="diamond" compact />
          <div style={{ width: 0, minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}><text style={{ color: colors.text, fontSize: 11, fontWeight: 650, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{schedule.title}</text><MetaPill label={schedule.mode} /></div>
            <text style={{ color: colors.textMuted, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{schedule.prompts[0]}</text>
            <text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`${scheduleTimingLabel(schedule.timing)} · ${schedule.nextRunAt ? `Next ${formatFlowDate(schedule.nextRunAt)}` : 'Disabled'} · ${flowProjectName(schedule.workspacePath)}`}</text>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', justifyContent: mobile ? 'flex-end' : 'flex-start', gap: 4 }}>
          <Button label="Run" tone="quiet" compact onClick={() => runtime.runScheduleNow(schedule.id)} />
          <Button label={schedule.enabled ? 'Pause' : 'Enable'} tone="quiet" compact onClick={() => { try { runtime.setScheduleEnabled(schedule.id, !schedule.enabled) } catch (error) { controller.notify('error', error instanceof Error ? error.message : String(error)) } }} />
          <Button label="Delete" tone="danger" compact onClick={() => runtime.removeSchedule(schedule.id)} />
        </div>
      </div>
    </div>
  )
})

function FlowTabButton({ id, active, label, count, icon, onClick }: { id: FlowTab; active: boolean; label: string; count: number; icon: IconName; onClick(): void }) {
  return <div testId={`flows-tab-${id}`} tabIndex={0} style={{ position: 'relative', height: 36, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 10, paddingRight: 10, cursor: 'pointer', userSelect: 'none' }} onClick={onClick}><Icon name={icon} size={11} color={active ? colors.textMuted : colors.textFaint} /><text style={{ color: active ? colors.text : colors.textMuted, fontSize: 10, fontWeight: active ? 650 : 500 }}>{label}</text><text style={{ color: colors.textFaint, fontSize: 9 }}>{count}</text>{active && <div style={{ position: 'absolute', left: 7, right: 7, bottom: 0, height: 2, borderRadius: 1, backgroundColor: colors.primary }} />}</div>
}

function FilterButton({ testId, label, count, active, onClick }: { testId?: string; label: string; count?: number; active: boolean; onClick(): void }) {
  return <div {...(testId ? { testId } : {})} tabIndex={0} style={{ height: 27, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 8, borderRadius: 6, backgroundColor: active ? colors.sidebarActive : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClick}><text style={{ color: active ? colors.text : colors.textMuted, fontSize: 9, fontWeight: active ? 650 : 500 }}>{label}</text>{count !== undefined && <text {...(testId ? { testId: `${testId}-count-${count}` } : {})} style={{ color: colors.textFaint, fontSize: 8 }}>{count}</text>}</div>
}

function StatusGlyph({ status }: { status: FlowTaskStatus }) {
  const tone = statusTone(status)
  if (status === 'running' || status === 'starting') return <div testId="flow-status-glyph" style={{ width: 16, height: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="clock" size={16} color={tone} /></div>
  if (status === 'queued') return <div testId="flow-status-glyph" style={{ width: 16, height: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="circle" size={16} color={tone} /></div>
  return (
    <div testId="flow-status-glyph" style={{ width: 16, height: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: tone }}>
      {status === 'paused' ? <div style={{ display: 'flex', flexDirection: 'row', gap: 2 }}><div style={{ width: 2, height: 7, borderRadius: 1, backgroundColor: tone }} /><div style={{ width: 2, height: 7, borderRadius: 1, backgroundColor: tone }} /></div> : <Icon name={status === 'succeeded' ? 'check' : 'x'} size={10} color={tone} />}
    </div>
  )
}

function StatusText({ status }: { status: FlowTaskStatus }) {
  return <text style={{ color: statusTone(status), fontSize: 9, fontWeight: 600 }}>{statusLabel(status)}</text>
}

function MetaPill({ label }: { label: string }) {
  return <div style={{ height: 20, display: 'flex', alignItems: 'center', paddingLeft: 7, paddingRight: 7, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised }}><text style={{ color: colors.textFaint, fontSize: 8 }}>{label}</text></div>
}

function TaskSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 11, paddingTop: 18, paddingBottom: 20, borderTopWidth: 1, borderColor: colors.border, overflow: 'hidden' }}><text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 700 }}>{title.toUpperCase()}</text>{children}</div>
}

function DisclosureTaskSection({ title, testId, collapsedHeight, children }: { title: string; testId: string; collapsedHeight: number; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  return (
    <div testId={testId} style={{ width: '100%', minWidth: 0, flexShrink: 0, display: 'flex', flexDirection: 'column', paddingTop: 14, paddingBottom: 20, borderTopWidth: 1, borderColor: colors.border }}>
      <div style={{ height: 22, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
        <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 700 }}>{title.toUpperCase()}</text>
        <div style={{ flexGrow: 1 }} />
        <div testId={`${testId}-toggle`} tabIndex={0} style={{ height: 22, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: colors.transparent, cursor: 'pointer', userSelect: 'none' }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onClick={() => setExpanded((value) => !value)}>
          <text testId={`${testId}-toggle-label`} style={{ color: hovered ? colors.text : colors.textFaint, fontSize: 9, pointerEvents: 'none' }}>{expanded ? 'Collapse' : 'Show all'}</text>
          <div style={{ width: 11, height: 11, display: 'flex', pointerEvents: 'none' }}><Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={11} color={colors.textFaint} /></div>
        </div>
      </div>
      <div testId={`${testId}-content`} style={{ width: '100%', minWidth: 0, marginTop: 7, overflow: 'hidden', ...(expanded ? {} : { maxHeight: collapsedHeight }) }}>{children}</div>
    </div>
  )
}

function TaskProperty({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return <div style={{ minHeight: 43, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 11, paddingRight: 11, borderBottomWidth: 1, borderColor: colors.border }}><text style={{ width: 72, flexShrink: 0, color: colors.textFaint, fontSize: 9 }}>{label}</text>{children ?? <text style={{ minWidth: 0, color: colors.textMuted, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{value ?? '—'}</text>}</div>
}

function DependencyRow({ relation, task, onOpen }: { relation: string; task: FlowTaskProjection; onOpen(): void }) {
  return <div tabIndex={0} style={{ minHeight: 43, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 9, paddingRight: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onOpen}><FlowRail status={task.status} before={false} after={false} compact /><div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}><text style={{ color: colors.textFaint, fontSize: 8 }}>{relation}</text><text style={{ color: colors.textMuted, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`${task.id} · ${task.title}`}</text></div></div>
}

function DependencyEmpty({ label }: { label: string }) {
  return <div style={{ height: 34, display: 'flex', alignItems: 'center', paddingLeft: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.border }}><text style={{ color: colors.textFaint, fontSize: 9 }}>{label}</text></div>
}

function EmptyState({ icon, title, detail }: { icon: 'gitBranch' | 'list' | 'clock'; title: string; detail: string }) {
  return <div style={{ minHeight: 230, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 9 }}><Icon name={icon} size={24} color={colors.textFaint} /><text style={{ color: colors.textMuted, fontSize: 12, fontWeight: 600 }}>{title}</text><text style={{ maxWidth: 420, color: colors.textFaint, fontSize: 10, textAlign: 'center' }}>{detail}</text></div>
}

function ProjectionContinuation({ remaining }: { remaining: number }) {
  return <div testId="flow-projection-continuation" style={{ ...contentRowStyle(0), height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><text style={{ color: colors.textFaint, fontSize: 9 }}>{`Projecting ${remaining} more row${remaining === 1 ? '' : 's'}…`}</text></div>
}

function useProjectedFlowRuns(state: WorkbenchState, now: number): FlowRunProjection[] {
  const sessionKey = state.session.sessionFile ?? state.session.sessionId ?? state.workspacePath
  const retainedMessages = useRef({ sessionKey, messages: state.messages, hasUser: state.messages.some((message) => message.role === 'user') })
  if (retainedMessages.current.sessionKey !== sessionKey || !state.session.isStreaming || (!retainedMessages.current.hasUser && state.messages.length > retainedMessages.current.messages.length)) {
    retainedMessages.current = { sessionKey, messages: state.messages, hasUser: state.messages.some((message) => message.role === 'user') }
  }
  const projectionMessages = retainedMessages.current.messages
  return useMemo(() => projectFlowRuns({ ...state, messages: projectionMessages }, now), [now, projectionMessages, state.models, state.queue, state.session.isStreaming, state.session.model?.id, state.session.model?.provider, state.session.sessionFile, state.session.sessionId, state.session.sessionName, state.sessions, state.threadLifecycle, state.workspacePath])
}

function useProjectionClock(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const delay = 60_000 - Date.now() % 60_000 + 10
    const timer = setTimeout(() => setNow(Date.now()), delay)
    return () => clearTimeout(timer)
  }, [now])
  return now
}

function useProgressiveRows<T>(rows: readonly T[], key: string): { projected: readonly T[]; remaining: number } {
  const [projection, setProjection] = useState(() => ({ key, limit: Math.min(INITIAL_PROJECTED_ROWS, rows.length) }))
  const limit = projection.key === key ? Math.min(projection.limit, rows.length) : Math.min(INITIAL_PROJECTED_ROWS, rows.length)
  useEffect(() => {
    if (projection.key !== key) {
      setProjection({ key, limit: Math.min(INITIAL_PROJECTED_ROWS, rows.length) })
      return
    }
    if (projection.limit >= rows.length) return
    const timer = setTimeout(() => setProjection((current) => current.key === key ? { key, limit: Math.min(rows.length, current.limit + PROJECTION_CHUNK_ROWS) } : current), PROJECTION_FRAME_MS)
    return () => clearTimeout(timer)
  }, [key, projection, rows.length])
  return { projected: rows.slice(0, limit), remaining: Math.max(0, rows.length - limit) }
}

function buildWorkGroups(runs: readonly FlowRunProjection[], filter: WorkFilter, query: string): FlowWorkGroup[] {
  const groups: FlowWorkGroup[] = []
  const observed = new Map<string, FlowWorkGroup>()
  for (const run of runs) {
    const tasks = run.tasks.filter((task) => !task.settled && matchesWorkFilter(task, filter) && matchesTaskQuery(task, query, run.title))
    if (tasks.length === 0) continue
    if (run.source !== 'observed') {
      groups.push({ id: run.id, title: run.title, detail: `${run.source === 'queue' ? 'Live queue projection' : run.source === 'scheduled' ? 'Scheduled flow' : run.tasks[0]?.mode === 'parallel' ? 'Fabric flow' : 'Sequential flow'} · ${tasks.length} task${tasks.length === 1 ? '' : 's'}`, source: run.source, tasks: tasks.map((task) => ({ task, run })), updatedAt: run.updatedAt })
      continue
    }
    const workspacePath = tasks[0]?.workspacePath ?? ''
    const id = `workspace:${workspacePath}`
    const current = observed.get(id)
    if (current) {
      current.tasks.push(...tasks.map((task) => ({ task, run })))
      current.updatedAt = Math.max(current.updatedAt, run.updatedAt)
    } else {
      const group: FlowWorkGroup = { id, title: flowProjectName(workspacePath), source: 'observed', tasks: tasks.map((task) => ({ task, run })), updatedAt: run.updatedAt }
      observed.set(id, group)
      groups.push(group)
    }
  }
  for (const group of groups) {
    group.tasks.sort(group.source === 'observed'
      ? (left, right) => left.run.id === right.run.id
        ? left.task.taskIndex - right.task.taskIndex || left.task.createdAt - right.task.createdAt
        : right.run.updatedAt - left.run.updatedAt || left.run.id.localeCompare(right.run.id)
      : (left, right) => left.task.taskIndex - right.task.taskIndex || left.task.createdAt - right.task.createdAt)
  }
  return groups.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

function matchesWorkFilter(task: FlowTaskProjection, filter: WorkFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return task.status === 'starting' || task.status === 'running'
  if (filter === 'scheduled') return task.source === 'scheduled'
  if (filter === 'waiting') return task.status === 'queued' || task.status === 'paused'
  return task.status === 'succeeded' || task.status === 'failed'
}

function matchesTaskQuery(task: FlowTaskProjection, query: string, runTitle = ''): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [task.id, task.title, task.prompt, task.result, task.workspacePath, flowProjectName(task.workspacePath), runTitle, ...task.labels].some((value) => value?.toLowerCase().includes(normalized))
}

function matchesTriageFilter(task: FlowTaskProjection, filter: TriageFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'unread') return task.unread
  return task.status === filter
}

function workFilterCounts(runs: readonly FlowRunProjection[]): Record<WorkFilter, number> {
  const tasks = runs.flatMap((run) => run.tasks)
  return {
    all: tasks.length,
    active: tasks.filter((task) => matchesWorkFilter(task, 'active')).length,
    scheduled: tasks.filter((task) => matchesWorkFilter(task, 'scheduled')).length,
    waiting: tasks.filter((task) => matchesWorkFilter(task, 'waiting')).length,
    done: tasks.filter((task) => matchesWorkFilter(task, 'done')).length,
  }
}

function flowPriorityCounts(runs: readonly FlowRunProjection[]): Record<ThreadPriority, number> {
  const counts: Record<ThreadPriority, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 }
  for (const task of runs.flatMap((run) => run.tasks)) counts[task.priority] += 1
  return counts
}

function flowTotals(runs: readonly FlowRunProjection[]) {
  const counts = workFilterCounts(runs)
  return { ...counts, active: counts.active, waiting: counts.waiting, done: counts.done }
}

interface FlowTaskDependency {
  before: boolean
  after: boolean
  label: string
  detail: string
  shape: FlowRailShape
  lane?: number | undefined
  branchFrom?: number | undefined
}

function taskDependency(task: FlowTaskProjection, run?: FlowRunProjection): FlowTaskDependency {
  if (task.mode === 'queue') {
    const before = task.taskIndex > 0
    const after = task.taskIndex < task.taskCount - 1
    const text = task.prompt.trim()
    const previous = run?.tasks.find((candidate) => candidate.taskIndex === task.taskIndex - 1)
    const joinsFabricGate = previous ? /^\/fabric\s+await(?:\s+\S+)?$/.test(previous.prompt.trim()) : false
    const join = joinsFabricGate ? { branchFrom: 1 } : {}
    if (text === '/new') return { before, after, label: 'New session', detail: 'After parent settles', shape: 'diamond', ...join }
    const awaitPeer = /^\/fabric\s+await(?:\s+(\S+))?$/.exec(text)
    if (awaitPeer) return { before, after, label: 'Fabric gate', detail: awaitPeer[1] ? `Waiting for ${awaitPeer[1]}` : 'Waiting for active peers', shape: 'triangle', lane: 1, branchFrom: 0 }
    if (text === '/fabric prewalk') return { before, after, label: 'Fabric prewalk', detail: 'Before next dispatch', shape: 'triangle', ...join }
    if (text.startsWith('/model')) return { before, after, label: 'Model change', detail: text.slice('/model'.length).trim(), shape: 'diamond', ...join }
    if (text.startsWith('/')) return { before, after, label: 'Queue control', detail: text.split(/\s+/, 1)[0] ?? text, shape: 'diamond', ...join }
    return { before, after, label: task.taskIndex === 0 ? 'Queue root' : 'Sequential', detail: task.taskIndex === 0 ? task.queueLane === 'steer' ? 'Next turn boundary' : 'After current run' : 'After previous row', shape: after ? 'circle' : 'square', ...join }
  }
  if (task.mode === 'observed') {
    if (task.taskCount === 1) return { before: false, after: false, label: 'Independent', detail: '', shape: 'circle' }
    const first = task.taskIndex === 0
    const last = task.taskIndex === task.taskCount - 1
    return { before: !first, after: !last, label: first ? 'Parent session' : 'Child session', detail: first ? 'Pi causal root' : 'Created after parent settled', shape: last ? 'square' : first ? 'circle' : 'diamond' }
  }
  if (task.mode === 'parallel') return { before: false, after: false, label: 'Fabric fan-out', detail: 'Parallel agent branches', shape: 'triangle' }
  if (task.source === 'scheduled') return { before: task.taskIndex > 0, after: task.taskIndex < task.taskCount - 1, label: task.taskIndex === 0 ? 'Scheduled root' : 'Sequential', detail: task.taskIndex === 0 ? 'Fresh occurrence' : `After step ${task.taskIndex}`, shape: task.taskIndex === task.taskCount - 1 ? 'square' : 'diamond' }
  return { before: task.taskIndex > 0, after: task.taskIndex < task.taskCount - 1, label: task.taskIndex === 0 ? 'Flow root' : 'Sequential', detail: task.taskIndex === 0 ? 'No prerequisites' : `After step ${task.taskIndex}`, shape: task.taskIndex === task.taskCount - 1 ? 'square' : 'circle' }
}

function singleLinePreview(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function statusLabel(status: FlowTaskStatus): string {
  if (status === 'starting') return 'Starting'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function contentRowStyle(paddingBottom: number): Record<string, unknown> {
  return { width: '100%', minWidth: 0, flexShrink: 0, ...(paddingBottom ? { paddingBottom } : {}) }
}

function phaseLabel(phase: 'new-session' | 'set-model' | 'set-name' | 'prompt'): string {
  if (phase === 'new-session') return '/new'
  if (phase === 'set-model') return '/model'
  if (phase === 'set-name') return 'session identity'
  return 'prompt'
}

function flowsViewPropsEqual(previous: FlowsViewProps, next: FlowsViewProps): boolean {
  const previousState = previous.state
  const nextState = next.state
  const sameStreamingSession = previousState.session.isStreaming && nextState.session.isStreaming && previousState.session.sessionId === nextState.session.sessionId && previousState.session.sessionFile === nextState.session.sessionFile
  return previous.controller === next.controller
    && previous.runtime === next.runtime
    && previous.presenters === next.presenters
    && previous.titlebarInset === next.titlebarInset
    && previous.onClose === next.onClose
    && previous.onOpenSession === next.onOpenSession
    && previousState.workspacePath === nextState.workspacePath
    && previousState.queue === nextState.queue
    && previousState.sessions === nextState.sessions
    && previousState.threadLifecycle === nextState.threadLifecycle
    && previousState.models === nextState.models
    && previousState.session.sessionId === nextState.session.sessionId
    && previousState.session.sessionFile === nextState.session.sessionFile
    && previousState.session.sessionName === nextState.session.sessionName
    && previousState.session.isStreaming === nextState.session.isStreaming
    && previousState.session.model?.id === nextState.session.model?.id
    && previousState.session.model?.provider === nextState.session.model?.provider
    && (sameStreamingSession || previousState.messages === nextState.messages)
}
