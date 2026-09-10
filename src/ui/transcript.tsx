import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { PiImageContent } from '../pi/types.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { buildTimeline, type TimelineItem } from '../workbench/timeline.ts'
import { Icon } from './icons.tsx'
import { colors, nativeTheme, type ResolvedTheme } from './theme.ts'
import { MathMarkdown } from './math-markdown.tsx'
import { openExternal } from './open-external.ts'
import { formatElapsedSeconds } from './duration.ts'
import { copyTextToClipboard, hydrateMessageImages } from './clipboard-media.ts'
import { NativeVirtualList, type NativeScrollEvent, type NativeVisibleRangeEvent } from './primitives.tsx'
import { extensionSurfaceRailReserveHeight, questionnaireWaitingDockReserveHeight } from './composer-surfaces.tsx'
import { queueDockReserveHeight } from './queue-dock.tsx'
import { LAYOUT_MOTION_TRANSITION, MotionDiv, SPRING_SETTLE_MS, TextShimmer, useEaseProgress } from './motion.ts'
import { useResponsiveLayout } from './responsive.tsx'
import type { ToolPresenter } from './tool-presenters.ts'
import { resolveToolPresentation } from './tool-presenters.ts'
import { TranscriptInlineAction } from './transcript-actions.tsx'
import { FabricCollapsedCalls, ToolRow, toolIcon, toolSummary } from './transcript-tools.tsx'

export { fabricSummaryPalette } from './transcript-tools.tsx'
import {
  currentWorkWave,
  emptyWorkTrace,
  groupWorkItems,
  isActiveTraceEntry,
  isCompactionWorkTrace,
  liveWorkTraceId,
  pendingWorkTraceId,
  projectTranscriptRows,
  type DisplayTimelineItem,
  type TraceTimelineItem,
  type TranscriptProjectionRow,
} from './transcript-projection.ts'

const HISTORY_PREFETCH_ROWS = 8
const MAX_HISTORY_NO_PROGRESS_PAGES = 8
const TRACE_INITIAL_PROJECTED_ROWS = 48
const TRACE_PROJECTION_CHUNK_ROWS = 48
const TRACE_PROJECTION_FRAME_MS = 16
const TRANSCRIPT_ESTIMATED_ROW_HEIGHT = 88
const COLLAPSED_TRACE_TOOL_LIMIT = 8
const COLLAPSED_TRACE_ROW_HEIGHT = 22
const RETIRING_ASSISTANT_HEIGHT = 96
type AssistantTimelineItem = Extract<TimelineItem, { kind: 'assistant' }>
function traceMarkdownTheme() {
  return {
    ...nativeTheme,
    text: colors.textMuted,
    textMuted: colors.textMuted,
    metrics: {
      ...nativeTheme.metrics,
      mdTextSize: 12,
      mdLineHeight: 19,
      mdBlockGap: 7,
      mdHeadingSizes: [12, 12, 12, 12],
      mdHeadingLineHeights: [19, 19, 19, 19],
      codeTextSize: 11,
      codeLineHeight: 18,
    },
  }
}

type TranscriptRenderRow = TranscriptProjectionRow
  | { id: 'empty-conversation'; kind: 'empty-conversation' }
  | { id: 'working'; kind: 'working' }
  | { id: 'composer-spacer'; kind: 'composer-spacer' }
  | { id: string; kind: 'retiring-assistant'; item: AssistantTimelineItem }

interface TranscriptDisclosureState {
  sessionKey: string
  traces: Set<string>
  entries: Set<string>
  traceLimits: Map<string, number>
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const EMPTY_LIMITS: ReadonlyMap<string, number> = new Map()

export const Transcript = memo(function Transcript({
  state,
  presenters,
  onOpenDiff,
  onRevert,
  onDismissNotice = () => undefined,
  onLoadEarlier,
  appearance,
  interactionDisabled = false,
  suspended = false,
}: {
  state: WorkbenchState
  presenters: ReadonlyMap<string, ToolPresenter>
  onOpenDiff(): void
  onRevert(entryId: string): void
  onDismissNotice?(id: number): void
  onLoadEarlier?(): void | Promise<void>
  appearance?: ResolvedTheme
  interactionDisabled?: boolean
  suspended?: boolean
}) {
  const sessionKey = state.session.sessionFile ?? state.session.sessionId ?? state.workspacePath
  const paging = useRef(false)
  const previewLeases = useRef(new Map<string, number>())
  const previewLeaseSession = useRef(sessionKey)
  const visibleStartIndex = useRef<number | undefined>(undefined)
  const historyDemandDirection = useRef<'older' | 'newer'>('older')
  const pendingHistoryPage = useRef<{ anchorId: string | undefined; continuation: number } | undefined>(undefined)
  if (previewLeaseSession.current !== sessionKey) {
    previewLeaseSession.current = sessionKey
    previewLeases.current = new Map()
  }
  const [disclosures, setDisclosures] = useState<TranscriptDisclosureState>(() => ({ sessionKey, traces: new Set(), entries: new Set(), traceLimits: new Map() }))
  const [retiringAssistants, setRetiringAssistants] = useState<AssistantTimelineItem[]>([])
  const [followTail, setFollowTail] = useState(() => state.session.isStreaming)
  const previousAssistants = useRef<AssistantTimelineItem[]>([])
  const wasStreaming = useRef(state.session.isStreaming)
  const stickyHeaderIds = useRef(new Set<string>())
  const expandedTraceIds = disclosures.sessionKey === sessionKey ? disclosures.traces : EMPTY_IDS
  const expandedEntryIds = disclosures.sessionKey === sessionKey ? disclosures.entries : EMPTY_IDS
  const traceLimits = disclosures.sessionKey === sessionKey ? disclosures.traceLimits : EMPTY_LIMITS

  useEffect(() => {
    if (!state.messagesLoadingEarlier) paging.current = false
  }, [sessionKey, state.messages.length, state.messagesLoadingEarlier])
  useEffect(() => {
    paging.current = false
    pendingHistoryPage.current = undefined
    visibleStartIndex.current = undefined
    historyDemandDirection.current = 'older'
    previousAssistants.current = []
    wasStreaming.current = state.session.isStreaming
    stickyHeaderIds.current = new Set()
    setRetiringAssistants([])
    setFollowTail(state.session.isStreaming)
  }, [sessionKey])

  const hydratedMessages = useMemo(() => hydrateMessageImages(state.messages), [state.messages])
  const items = useMemo(
    () => groupWorkItems(buildTimeline(hydratedMessages, state.liveAssistant, state.liveTools, state.forkMessages, 0, state.notices), state.session.isStreaming),
    [hydratedMessages, state.forkMessages, state.liveAssistant, state.liveTools, state.notices, state.session.isStreaming],
  )
  const traceLengths = useMemo(() => new Map(items.flatMap((item) => item.kind === 'work-trace' ? [[item.id, item.items.length] as const] : [])), [items])
  const projectedRows = useMemo(() => projectTranscriptRows(items, expandedTraceIds, traceLimits), [expandedTraceIds, items, traceLimits])
  const displayedAssistants = useMemo(
    () => items.flatMap((item) => item.kind === 'assistant' ? [item] : []),
    [items],
  )
  useEffect(() => {
    if (suspended) return
    const displayedIds = new Set(displayedAssistants.map((item) => item.id))
    const stillPresent = (item: AssistantTimelineItem) => displayedIds.has(item.id) || displayedAssistants.some((candidate) => candidate.text === item.text)
    const disappeared = previousAssistants.current.filter((item) => !stillPresent(item))
    previousAssistants.current = displayedAssistants
    setRetiringAssistants((current) => {
      const remaining = current.filter((item) => !stillPresent(item))
      if (disappeared.length === 0) return remaining.length === current.length ? current : remaining
      const known = new Set(remaining.map((item) => item.id))
      return [...remaining, ...disappeared.filter((item) => !known.has(item.id))]
    })
  }, [displayedAssistants, suspended])
  useEffect(() => {
    if (state.session.isStreaming && !wasStreaming.current) setFollowTail(true)
    wasStreaming.current = state.session.isStreaming
  }, [state.session.isStreaming])
  const retiringIds = retiringAssistants.map((item) => item.id).join('|')
  useEffect(() => {
    if (!retiringIds) return
    const timer = setTimeout(() => setRetiringAssistants([]), SPRING_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [retiringIds])
  const liveTraceId = useMemo(
    () => liveWorkTraceId(items, state.session.isStreaming) ?? pendingWorkTraceId(items, state.session.isStreaming),
    [items, state.session.isStreaming],
  )
  if (liveTraceId) stickyHeaderIds.current.add(liveTraceId)
  const rows = useMemo<TranscriptRenderRow[]>(() => {
    const visibleRows = projectedRows.filter((row) => {
      if (row.kind !== 'trace-entry' && row.kind !== 'trace-notices' && row.kind !== 'trace-continuation') return true
      return (traceLengths.get(row.traceId) ?? 0) > TRACE_INITIAL_PROJECTED_ROWS
    })
    const next: TranscriptRenderRow[] = visibleRows.length > 0 ? [...visibleRows] : [{ id: 'empty-conversation', kind: 'empty-conversation' }]
    const insertAt = next.findIndex((row) => row.kind === 'working' || row.kind === 'composer-spacer')
    const retiringRows: TranscriptRenderRow[] = retiringAssistants.map((item) => ({ id: `retiring:${item.id}`, kind: 'retiring-assistant', item }))
    if (retiringRows.length > 0) next.splice(insertAt === -1 ? next.length : insertAt, 0, ...retiringRows)
    if (liveTraceId && !next.some((row) => row.id === liveTraceId)) next.push({ id: liveTraceId, kind: 'trace-header', trace: emptyWorkTrace(liveTraceId) })
    else if (state.session.isStreaming && !liveTraceId && !items.some((item) => item.kind === 'assistant' || item.kind === 'work-trace')) next.push({ id: 'working', kind: 'working' })
    next.push({ id: 'composer-spacer', kind: 'composer-spacer' })
    return next
  }, [items, liveTraceId, projectedRows, retiringAssistants, state.session.isStreaming, traceLengths])
  const rowIndexById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows])
  const frozenRows = useRef(rows)
  useEffect(() => {
    if (!suspended) frozenRows.current = rows
  }, [rows, suspended])
  const renderRows = suspended ? frozenRows.current : rows
  // Spread retained-tree growth across frames; native virtualization handles layout and paint per direct row.
  useEffect(() => {
    if (disclosures.sessionKey !== sessionKey) return
    const hasPendingRows = [...disclosures.traces].some((traceId) => (disclosures.traceLimits.get(traceId) ?? 0) < (traceLengths.get(traceId) ?? 0))
    if (!hasPendingRows) return
    const timer = setTimeout(() => {
      setDisclosures((current) => {
        if (current.sessionKey !== sessionKey) return current
        const traceLimits = new Map(current.traceLimits)
        let selected: { id: string; length: number; limit: number } | undefined
        for (const traceId of current.traces) {
          const length = traceLengths.get(traceId) ?? 0
          const limit = traceLimits.get(traceId) ?? Math.min(TRACE_INITIAL_PROJECTED_ROWS, length)
          if (limit >= length || (selected && selected.limit <= limit)) continue
          selected = { id: traceId, length, limit }
        }
        if (!selected) return current
        traceLimits.set(selected.id, Math.min(selected.length, selected.limit + TRACE_PROJECTION_CHUNK_ROWS))
        return { ...current, traceLimits }
      })
    }, TRACE_PROJECTION_FRAME_MS)
    return () => clearTimeout(timer)
  }, [disclosures, sessionKey, traceLengths])
  const loadEarlier = (continuation = 0) => {
    if (historyDemandDirection.current !== 'older' || !onLoadEarlier || !state.messagesHasOlder || state.messagesLoadingEarlier || paging.current) return
    paging.current = true
    pendingHistoryPage.current = { anchorId: rows[0]?.id, continuation }
    try {
      const request = onLoadEarlier()
      if (request) {
        void request.then(() => { paging.current = false }, () => {
          paging.current = false
          pendingHistoryPage.current = undefined
        })
      } else {
        paging.current = false
      }
    } catch {
      paging.current = false
      pendingHistoryPage.current = undefined
    }
  }
  const handleVisibleRange = (event: NativeVisibleRangeEvent) => {
    if (typeof event.startIndex !== 'number') return
    const firstVisible = Math.max(0, Math.floor(event.startIndex))
    visibleStartIndex.current = firstVisible
    if (firstVisible <= HISTORY_PREFETCH_ROWS) loadEarlier()
  }
  // Downward intent owns the viewport and cancels every queued hidden-page continuation.
  const handleHistoryScroll = (event: NativeScrollEvent) => {
    if (typeof event.deltaY !== 'number' || event.deltaY === 0) return
    setFollowTail(false)
    if (event.deltaY < 0) {
      historyDemandDirection.current = 'newer'
      pendingHistoryPage.current = undefined
      return
    }
    historyDemandDirection.current = 'older'
    if ((visibleStartIndex.current ?? HISTORY_PREFETCH_ROWS + 1) <= HISTORY_PREFETCH_ROWS) loadEarlier()
  }

  // A disk page can fold entirely into the collapsed first trace and add no scrollable row.
  useEffect(() => {
    if (state.messagesLoadingEarlier) return
    const pending = pendingHistoryPage.current
    if (!pending) return
    pendingHistoryPage.current = undefined
    const anchorIndex = pending.anchorId ? rowIndexById.get(pending.anchorId) ?? -1 : -1
    if (
      anchorIndex === 0
      && state.messagesHasOlder
      && (visibleStartIndex.current ?? HISTORY_PREFETCH_ROWS + 1) <= HISTORY_PREFETCH_ROWS
      && pending.continuation + 1 < MAX_HISTORY_NO_PROGRESS_PAGES
    ) {
      queueMicrotask(() => loadEarlier(pending.continuation + 1))
    }
  }, [rowIndexById, state.messagesHasOlder, state.messagesLoadingEarlier])

  const toggleTrace = (traceId: string) => {
    setDisclosures((current) => {
      const traces = new Set(current.sessionKey === sessionKey ? current.traces : EMPTY_IDS)
      if (traces.has(traceId)) traces.delete(traceId)
      else traces.add(traceId)
      const traceLimits = new Map(current.sessionKey === sessionKey ? current.traceLimits : EMPTY_LIMITS)
      if (traces.has(traceId)) traceLimits.set(traceId, Math.min(TRACE_INITIAL_PROJECTED_ROWS, traceLengths.get(traceId) || TRACE_INITIAL_PROJECTED_ROWS))
      else traceLimits.delete(traceId)
      return { sessionKey, traces, entries: new Set(current.sessionKey === sessionKey ? current.entries : EMPTY_IDS), traceLimits }
    })
  }
  const toggleEntry = (rowId: string) => {
    setDisclosures((current) => {
      const entries = new Set(current.sessionKey === sessionKey ? current.entries : EMPTY_IDS)
      if (entries.has(rowId)) entries.delete(rowId)
      else entries.add(rowId)
      return { sessionKey, traces: new Set(current.sessionKey === sessionKey ? current.traces : EMPTY_IDS), entries, traceLimits: new Map(current.sessionKey === sessionKey ? current.traceLimits : EMPTY_LIMITS) }
    })
  }

  // Direct keyed children preserve measured prepend anchors; each expanded entry is its own native virtual row.
  return (
    <div testId="transcript-scroll-surface" style={{ position: 'relative', flexGrow: 1, minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column', pointerEvents: interactionDisabled ? 'none' : 'auto' }} onScroll={handleHistoryScroll}>
      <NativeVirtualList
        key={`${sessionKey}:${appearance ?? nativeTheme.appearance}:virtual`}
        testId="transcript-list"
        alignment="bottom"
        followTail={followTail}
        onScroll={handleHistoryScroll}
        onVisibleRange={handleVisibleRange}
        overdraw={240}
        estimatedItemHeight={TRANSCRIPT_ESTIMATED_ROW_HEIGHT}
        style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
      >
        {renderRows.map((row) => (
          <TranscriptRowTransition key={row.id} row={row} live={row.kind === 'trace-header' && row.id === liveTraceId} persist={row.kind === 'trace-header' && stickyHeaderIds.current.has(row.id)}>
          <ProjectedTranscriptRow
            row={row}
            presenters={presenters}
            workspacePath={state.workspacePath}
            historyHasOlder={state.messagesHasOlder}
            activity={state.activity}
            live={row.kind === 'trace-header' && row.id === liveTraceId}
            leasePreviewHeight={(key, natural, hold) => {
              if (!hold) {
                previewLeases.current.delete(key)
                return natural
              }
              const next = Math.max(previewLeases.current.get(key) ?? 0, natural)
              previewLeases.current.set(key, next)
              return next
            }}
            questionnaireCollapsed={state.questionnaireCollapsed !== undefined}
            queue={state.queue}
            statusItems={state.statusItems}
            widgets={state.widgets}
            expandedEntryIds={expandedEntryIds}
            expanded={row.kind === 'trace-header'
              ? expandedTraceIds.has(row.id)
              : row.kind === 'trace-entry' && row.item.kind === 'compaction'
                ? true
                : expandedEntryIds.has(row.id)}
            onToggleTrace={toggleTrace}
            onToggleEntry={toggleEntry}
            onOpenDiff={onOpenDiff}
            onRevert={onRevert}
            onDismissNotice={onDismissNotice}
            onFinishRetire={(id) => setRetiringAssistants((current) => current.filter((item) => item.id !== id))}
          />
          </TranscriptRowTransition>
        ))}
      </NativeVirtualList>
    </div>
  )
}, (previous, next) => previous.appearance === next.appearance
  && previous.interactionDisabled === next.interactionDisabled
  && previous.presenters === next.presenters
  && previous.state.messages === next.state.messages
  && previous.state.messagesHasOlder === next.state.messagesHasOlder
  && previous.state.messagesLoadingEarlier === next.state.messagesLoadingEarlier
  && previous.state.forkMessages === next.state.forkMessages
  && previous.state.liveAssistant === next.state.liveAssistant
  && previous.state.liveTools === next.state.liveTools
  && previous.state.activity === next.state.activity
  && previous.state.workspacePath === next.state.workspacePath
  && previous.state.session.sessionFile === next.state.session.sessionFile
  && previous.state.session.sessionId === next.state.session.sessionId
  && previous.state.session.isStreaming === next.state.session.isStreaming
  && previous.state.notices.length === next.state.notices.length
  && previous.state.questionnaireCollapsed === next.state.questionnaireCollapsed
  && previous.state.queue === next.state.queue
  && previous.state.statusItems === next.state.statusItems
  && previous.state.widgets === next.state.widgets)

function TranscriptRowTransition({ row, live, persist, children }: { row: TranscriptRenderRow; live: boolean; persist: boolean; children: React.ReactNode }) {
  const entered = useRef(false)
  const animated = row.kind === 'working'
    || (row.kind === 'trace-header' && (live || persist))
    || (row.kind === 'timeline-item' && (row.item.kind === 'status' || (row.item.kind === 'assistant' && row.item.streaming)))
  if (!animated) return <>{children}</>
  const initial = entered.current || row.kind === 'trace-header' ? false : { opacity: 0, top: 6 }
  entered.current = true
  return (
    <MotionDiv
      testId="transcript-row-transition"
      initial={initial}
      animate={{ opacity: 1, top: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      style={{ position: 'relative', width: '100%' }}
    >
      {children}
    </MotionDiv>
  )
}

function ProjectedTranscriptRow({
  row,
  presenters,
  workspacePath,
  historyHasOlder,
  activity,
  live,
  leasePreviewHeight,
  questionnaireCollapsed,
  queue,
  statusItems,
  widgets,
  expanded,
  expandedEntryIds,
  onToggleTrace,
  onToggleEntry,
  onOpenDiff,
  onRevert,
  onDismissNotice,
  onFinishRetire,
}: {
  row: TranscriptRenderRow
  presenters: ReadonlyMap<string, ToolPresenter>
  workspacePath: string
  historyHasOlder: boolean
  activity: string
  live: boolean
  leasePreviewHeight(key: string, natural: number, hold: boolean): number
  questionnaireCollapsed: boolean
  queue: WorkbenchState['queue']
  statusItems: WorkbenchState['statusItems']
  widgets: WorkbenchState['widgets']
  expanded: boolean
  expandedEntryIds: ReadonlySet<string>
  onToggleTrace(traceId: string): void
  onToggleEntry(rowId: string): void
  onOpenDiff(): void
  onRevert(entryId: string): void
  onDismissNotice(id: number): void
  onFinishRetire(id: string): void
}) {
  if (row.kind === 'empty-conversation') return <EmptyConversation workspacePath={workspacePath} />
  if (row.kind === 'working') return <WorkingRow activity={activity} />
  if (row.kind === 'composer-spacer') return <ComposerSpacer questionnaireCollapsed={questionnaireCollapsed} queue={queue} statusItems={statusItems} widgets={widgets} />
  if (row.kind === 'retiring-assistant') return <RetiringAssistantRow item={row.item} onRevert={onRevert} onDone={() => onFinishRetire(row.item.id)} />
  if (row.kind === 'timeline-item') return <TimelineItemRow item={row.item} onRevert={onRevert} />
  if (row.kind === 'trace-header') {
    const running = live
    const inline = row.trace.items.length <= TRACE_INITIAL_PROJECTED_ROWS
    return (
      <TranscriptRowShell compact={running} noSelect>
        <ExecutionTraceHeader
          trace={row.trace}
          presenters={presenters}
          expanded={expanded}
          durationKnown={Boolean(row.trace.boundaryId) || !historyHasOlder}
          running={running}
          leasePreviewHeight={leasePreviewHeight}
          onToggle={() => onToggleTrace(row.id)}
          body={inline ? (
            <TraceEntries
              items={row.trace.items}
              traceId={row.id}
              presenters={presenters}
              expandedEntryIds={expandedEntryIds}
              onToggleEntry={onToggleEntry}
              onToggleTrace={onToggleTrace}
              onRevert={onRevert}
              onDismissNotice={onDismissNotice}
            />
          ) : null}
        />
      </TranscriptRowShell>
    )
  }
  if (row.kind === 'trace-notices') {
    return (
      <TranscriptRowShell compact>
        <div testId="execution-timeline" style={{ display: 'flex', flexDirection: 'column', marginLeft: 8, paddingLeft: 18, paddingTop: 5, paddingBottom: 5, borderLeftWidth: 1, borderColor: colors.borderStrong }}>
          <TraceNotificationGroup items={row.notices} onDismiss={onDismissNotice} />
        </div>
      </TranscriptRowShell>
    )
  }
  if (row.kind === 'trace-files') {
    return (
      <TranscriptRowShell compact>
        <div style={{ marginLeft: 26 }}><ChangedFilesCard paths={row.paths} onOpenDiff={onOpenDiff} /></div>
      </TranscriptRowShell>
    )
  }
  if (row.kind === 'trace-continuation') {
    return (
      <TranscriptRowShell compact>
        <div testId="trace-projection-continuation" style={{ minHeight: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, marginLeft: 8, paddingLeft: 18, borderLeftWidth: 1, borderColor: colors.borderStrong }}>
          <Icon name="circle" size={10} color={colors.textFaint} />
          <text style={{ color: colors.textFaint, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`Preparing ${row.remaining} more ${row.remaining === 1 ? 'entry' : 'entries'}…`}</text>
        </div>
      </TranscriptRowShell>
    )
  }
  return (
    <TranscriptRowShell compact>
      <div testId="execution-timeline" style={{ display: 'flex', flexDirection: 'column', marginLeft: 8, paddingLeft: 18, paddingTop: 5, paddingBottom: 5, borderLeftWidth: 1, borderColor: colors.borderStrong }}>
        {row.item.kind === 'thinking'
          ? <TraceReasoning item={row.item} expanded={expanded} onToggle={() => onToggleEntry(row.id)} />
          : row.item.kind === 'context-injection'
            ? <TraceContextInjection item={row.item} expanded={expanded} onToggle={() => onToggleEntry(row.id)} />
            : row.item.kind === 'assistant'
              ? <TraceAssistant item={row.item} expanded={expanded} onToggle={() => onToggleEntry(row.id)} />
              : row.item.kind === 'compaction'
                ? <TraceCompaction item={row.item} expanded={expanded} onToggle={() => onToggleTrace(row.traceId)} />
                : <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><div style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center' }}><text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 650 }}>TOOL CALL</text></div><ToolRow item={row.item} presenters={presenters} expanded={expanded} onToggle={() => onToggleEntry(row.id)} onRevert={onRevert} /></div>}
      </div>
    </TranscriptRowShell>
  )
}

function TraceNotificationGroup({ items, onDismiss }: { items: Array<Extract<TraceTimelineItem, { kind: 'notice' }>>; onDismiss(id: number): void }) {
  return (
    <div testId="trace-notification-group" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {items.map(({ notice }) => (
        <div key={notice.id} testId="trace-notification" style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 650, whiteSpace: 'nowrap' }}>NOTIFICATION</text>
          <text style={{ minWidth: 0, flexGrow: 1, color: colors.textFaint, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{notice.message}</text>
          <Timestamp value={notice.createdAt} />
          <div testId={`dismiss-trace-notification:${notice.id}`} tabIndex={0} style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={() => onDismiss(notice.id)} onKeyDown={(event) => { if (event.key === 'enter') onDismiss(notice.id) }}>
            <Icon name="x" size={10} color={colors.textFaint} />
          </div>
        </div>
      ))}
    </div>
  )
}

function TimelineItemRow({ item, onRevert }: { item: Exclude<DisplayTimelineItem, { kind: 'work-trace' }>; onRevert(entryId: string): void }) {
  return (
    <TranscriptRowShell user={item.kind === 'user'}>
      {item.kind === 'user' && <UserMessage item={item} onRevert={onRevert} />}
      {item.kind === 'assistant' && <AssistantMessage item={item} onRevert={onRevert} />}
      {item.kind === 'status' && <StatusMessage text={item.text} error={item.tone === 'error'} timestamp={item.timestamp} />}
    </TranscriptRowShell>
  )
}

function TranscriptRowShell({ children, user = false, compact = false, noSelect = false }: { children: React.ReactNode; user?: boolean; compact?: boolean; noSelect?: boolean }) {
  const { contentGutter } = useResponsiveLayout()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', width: '100%', paddingTop: user ? 9 : compact ? 0 : 4, paddingBottom: user ? 11 : compact ? 0 : 7, paddingLeft: contentGutter, paddingRight: contentGutter, ...((compact || noSelect) ? { userSelect: 'none' as const } : {}) }}>
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 768, minWidth: 0 }}>{children}</div>
    </div>
  )
}

// Pointer-only visuals stay native: React hover revisions make GPUI remeasure rows beneath a stationary cursor.
function UserMessage({ item, onRevert }: { item: Extract<DisplayTimelineItem, { kind: 'user' }>; onRevert(entryId: string): void }) {
  const { mobile } = useResponsiveLayout()
  return (
    <div testId="user-message" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '100%', gap: 6 }}>
      {item.images.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, maxWidth: mobile ? '92%' : '80%' }}>
          {item.images.map((image, index) => <MessageImage key={`${item.id}-image-${index}`} image={image} />)}
        </div>
      )}
      {item.text && (
        <div style={{ maxWidth: mobile ? '92%' : '80%', paddingTop: 10, paddingBottom: 10, paddingLeft: 13, paddingRight: 13, borderRadius: 16, backgroundColor: colors.message }}>
          <text testId="user-message-text" style={{ color: colors.text, fontSize: 14, lineHeight: 21, whiteSpace: 'normal' }}>{item.text}</text>
        </div>
      )}
      <MessageFooter timestamp={item.timestamp} copyText={item.text} revertEntryId={item.revertEntryId} align="end" onRevert={onRevert} />
    </div>
  )
}

function AssistantMessage({ item, onRevert }: { item: Extract<DisplayTimelineItem, { kind: 'assistant' }>; onRevert(entryId: string): void }) {
  return (
    <div testId="assistant-message" style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, gap: 5, paddingLeft: 4, paddingRight: 4 }}>
      <MathMarkdown
        testId="assistant-message-markdown"
        source={item.text || '…'}
        theme={nativeTheme}
        style={{ width: '100%', minWidth: 0 }}
        onLinkClick={(event) => openExternal(String(event.value ?? ''))}
      />
      {!item.streaming && <MessageFooter timestamp={item.timestamp} copyText={item.text} revertEntryId={item.revertEntryId} align="start" onRevert={onRevert} />}
    </div>
  )
}

const TRACE_CHEVRON_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'

function TraceChevron({ expanded, size = 12 }: { expanded: boolean; size?: number }) {
  return React.createElement('svg', {
    source: TRACE_CHEVRON_SOURCE,
    rotation: expanded ? 90 : 0,
    style: { width: size, height: size, flexShrink: 0, color: colors.textFaint, pointerEvents: 'none' },
  } as never)
}

function ExecutionTraceHeader({
  trace,
  presenters,
  expanded,
  durationKnown,
  running,
  leasePreviewHeight,
  onToggle,
  body,
}: {
  trace: Extract<DisplayTimelineItem, { kind: 'work-trace' }>
  presenters: ReadonlyMap<string, ToolPresenter>
  expanded: boolean
  durationKnown: boolean
  running: boolean
  leasePreviewHeight(key: string, natural: number, hold: boolean): number
  onToggle(): void
  body?: React.ReactNode
}) {
  const compaction = compactionTraceLabel(trace)
  const duration = durationKnown ? traceDuration(trace.items) : undefined
  const wave = currentWorkWave(trace.items)
  const collapsedTools = running && !expanded ? wave.tools.slice(-COLLAPSED_TRACE_TOOL_LIMIT) : []
  const preview = wave.preview && wave.preview.kind !== 'tool' ? wave.preview : undefined
  const naturalHeight = !expanded && running ? Math.max(COLLAPSED_TRACE_ROW_HEIGHT, collapsedPreviewHeight(collapsedTools, preview, presenters)) : 0
  const leasedHeight = leasePreviewHeight(trace.boundaryId ?? trace.items[0]?.id ?? trace.id, naturalHeight, running)
  const extraHeight = Math.max(0, leasedHeight - naturalHeight)
  const height = leasedHeight
  return (
    <div testId="execution-trace" style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', gap: 2, paddingLeft: 4, paddingRight: 2, userSelect: 'none' }}>
      <div
        testId="tool-row"
        tabIndex={0}
        style={{ position: 'relative', height: 24, minHeight: 24, overflow: 'hidden', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none', backgroundColor: colors.background }}
        onKeyDown={(event) => { if (event.key === 'enter') onToggle() }}
      >
        {running
          ? <TextShimmer testId="execution-trace-label" text="Working" fontSize={13} baseColor={colors.textMuted} highlightColor={colors.text} />
          : <text testId="execution-trace-label" style={{ color: colors.textMuted, fontSize: 13, userSelect: 'none', pointerEvents: 'none' }}>{compaction ?? (duration ? `Worked for ${duration}` : 'Worked')}</text>}
        <TraceChevron expanded={expanded} />
      </div>
      {!expanded && (
        <WorkPreviewTransition height={height}>
          {running && preview && <TracePreview item={preview} />}
          {running && collapsedTools.length > 0 ? <CollapsedTraceTools items={collapsedTools} presenters={presenters} hidden={Math.max(0, wave.tools.length - collapsedTools.length)} /> : null}
          {running && extraHeight > 0 && <div testId="transcript-lease" style={{ width: '100%', height: extraHeight }} />}
        </WorkPreviewTransition>
      )}
      {body && (
        <TraceExpandBody open={expanded} extent={estimateTraceBodyHeight(trace.items, presenters)}>
          {body}
        </TraceExpandBody>
      )}
      <div testId="execution-trace-hit" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 24, cursor: 'pointer', backgroundColor: '#00000001' }} onClick={onToggle} />
    </div>
  )
}

function estimateTraceBodyHeight(items: readonly TraceTimelineItem[], presenters: ReadonlyMap<string, ToolPresenter>): number {
  let height = 5
  for (const item of items) {
    height += 10
    if (item.kind === 'tool') {
      height += 57
      const fabric = resolveToolPresentation(item.tool, presenters).fabric
      if (!fabric || fabric.audits.length === 0) continue
      const visible = Math.min(fabric.audits.length, COLLAPSED_TRACE_TOOL_LIMIT)
      height += 7 + 19 * visible + 3 * Math.max(0, visible - 1)
      if (fabric.audits.length > visible) height += 14
      continue
    }
    if (item.kind === 'compaction') {
      height += 24 + Math.min(480, item.text.split('\n').length * 19)
      continue
    }
    height += 24
  }
  return Math.max(36, height)
}

function TraceExpandBody({ open, extent, children }: { open: boolean; extent: number; children: React.ReactNode }) {
  const progress = useEaseProgress(open, 0.22)
  if (!open && progress <= 0) return null
  const clip = !open || progress < 1
  return (
    <div
      testId="execution-trace-body"
      style={{
        overflow: 'hidden',
        flexShrink: 0,
        opacity: progress,
        ...(clip ? { height: Math.max(0, progress * extent) } : {}),
      }}
    >
      {children}
    </div>
  )
}

function TraceEntries({
  items,
  traceId,
  presenters,
  expandedEntryIds,
  onToggleEntry,
  onToggleTrace,
  onRevert,
  onDismissNotice,
}: {
  items: readonly TraceTimelineItem[]
  traceId: string
  presenters: ReadonlyMap<string, ToolPresenter>
  expandedEntryIds: ReadonlySet<string>
  onToggleEntry(rowId: string): void
  onToggleTrace(traceId: string): void
  onRevert(entryId: string): void
  onDismissNotice(id: number): void
}) {
  return (
    <div testId="execution-timeline" style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, marginLeft: 8, paddingLeft: 18, paddingTop: 5, paddingBottom: 5, borderLeftWidth: 1, borderColor: colors.borderStrong }}>
      {items.map((item) => {
        const rowId = `${traceId}:entry:${item.id}`
        const expanded = item.kind === 'compaction' ? true : expandedEntryIds.has(rowId)
        return (
          <div key={item.id} style={{ paddingTop: 5, paddingBottom: 5 }}>
            {item.kind === 'thinking'
              ? <TraceReasoning item={item} expanded={expanded} onToggle={() => onToggleEntry(rowId)} />
              : item.kind === 'context-injection'
                ? <TraceContextInjection item={item} expanded={expanded} onToggle={() => onToggleEntry(rowId)} />
                : item.kind === 'assistant'
                  ? <TraceAssistant item={item} expanded={expanded} onToggle={() => onToggleEntry(rowId)} />
                  : item.kind === 'compaction'
                    ? <TraceCompaction item={item} expanded={expanded} onToggle={() => onToggleTrace(traceId)} />
                    : item.kind === 'notice'
                      ? <TraceNotificationGroup items={[item]} onDismiss={onDismissNotice} />
                      : <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><div style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center' }}><text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 650 }}>TOOL CALL</text></div><ToolRow item={item} presenters={presenters} expanded={expanded} onToggle={() => onToggleEntry(rowId)} onRevert={onRevert} /></div>}
          </div>
        )
      })}
    </div>
  )
}

function WorkPreviewTransition({ height, children }: { height: number; children: React.ReactNode }) {
  const entered = useRef(false)
  const initial = entered.current ? false : { opacity: 0, top: 4 }
  entered.current = true
  return (
    <MotionDiv testId="execution-preview-transition" initial={initial} animate={{ opacity: 1, top: 0, height }} transition={LAYOUT_MOTION_TRANSITION} style={{ position: 'relative', overflow: 'hidden', height, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', gap: 2 }}>
      {children}
    </MotionDiv>
  )
}

function TraceReasoning({ item, expanded, onToggle }: { item: Extract<TimelineItem, { kind: 'thinking' }>; expanded: boolean; onToggle(): void }) {
  return <TraceDisclosure label="REASONING" text={item.text} testId="trace-reasoning" streaming={Boolean(item.streaming)} expanded={expanded} onToggle={onToggle} />
}

function TraceCompaction({ item, expanded, onToggle }: { item: Extract<TimelineItem, { kind: 'compaction' }>; expanded: boolean; onToggle(): void }) {
  return <TraceDisclosure label="COMPACTION" text={item.text} testId="trace-compaction" expanded={expanded} onToggle={onToggle} />
}

function TraceAssistant({ item, expanded, onToggle }: { item: AssistantTimelineItem; expanded: boolean; onToggle(): void }) {
  return <TraceDisclosure label="RESPONSE" text={item.text} testId="trace-assistant" streaming={Boolean(item.streaming)} expanded={expanded} onToggle={onToggle} />
}

function TraceContextInjection({ item, expanded, onToggle }: { item: Extract<TimelineItem, { kind: 'context-injection' }>; expanded: boolean; onToggle(): void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <TraceDisclosure label={contextInjectionLabel(item)} text={item.text || `${item.images.length} image${item.images.length === 1 ? '' : 's'}`} testId="trace-context-injection" expanded={expanded} onToggle={onToggle} />
      {expanded && item.images.length > 0 && (
        <div testId="context-injection-images" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {item.images.map((image, index) => React.createElement('img', {
            key: `${item.id}-image-${index}`,
            src: image.previewPath ?? `data:${image.mimeType};base64,${image.data}`,
            alt: `${item.source ?? 'Extension'} image ${index + 1}`,
            objectFit: 'contain',
            style: { maxWidth: '100%', maxHeight: 220, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background },
          } as never))}
        </div>
      )}
    </div>
  )
}

function TraceDisclosure({ label, text, testId, expanded, onToggle }: { label: string; text: string; testId: string; streaming?: boolean; expanded: boolean; onToggle(): void }) {
  return (
    <div testId={testId} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div testId={`${testId}-toggle`} tabIndex={0} style={{ position: 'relative', minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none', backgroundColor: colors.background }} onKeyDown={(event) => { if (event.key === 'enter') onToggle() }}>
        <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 650, whiteSpace: 'nowrap', pointerEvents: 'none', hover: { color: colors.textMuted } }}>{label}</text>
        {!expanded && <text testId={`${testId}-preview`} style={{ minWidth: 0, flexGrow: 1, color: colors.textFaint, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{markdownPreview(text)}</text>}
        <TraceChevron expanded={expanded} size={10} />
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, cursor: 'pointer', backgroundColor: '#00000001' }} onClick={onToggle} />
      </div>
      {expanded && (
        <MathMarkdown
          testId={`${testId}-markdown`}
          source={text}
          theme={traceMarkdownTheme()}
          style={{ width: '100%', minWidth: 0, overflow: 'visible', userSelect: 'none', pointerEvents: 'none' }}
          onLinkClick={(event) => openExternal(String(event.value ?? ''))}
        />
      )}
    </div>
  )
}

function TracePreview({ item }: { item: TraceTimelineItem }) {
  if (item.kind === 'thinking' || item.kind === 'assistant') {
    return <div testId="execution-preview" style={{ minWidth: 0, overflow: 'hidden', paddingLeft: 1 }}><text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 19, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{markdownPreview(item.text)}</text></div>
  }
  if (item.kind === 'context-injection') {
    const prefix = item.source ? `${contextInjectionLabel(item)} ` : ''
    return <div testId="execution-preview" style={{ minWidth: 0, overflow: 'hidden', paddingLeft: 1 }}><text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 19, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{markdownPreview(`${prefix}${item.text}`)}</text></div>
  }
  if (item.kind === 'notice') {
    return <div testId="execution-preview" style={{ minWidth: 0, overflow: 'hidden', paddingLeft: 1 }}><text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 19, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.notice.message}</text></div>
  }
  if (item.kind === 'compaction') {
    return <div testId="execution-preview" style={{ minWidth: 0, overflow: 'hidden', paddingLeft: 1 }}><text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 19, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{markdownPreview(item.text)}</text></div>
  }
  const content = item.tool.output?.trim().split('\n').at(-1)
  return (
    <div testId="execution-preview" style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingLeft: 1 }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}><Icon name={toolIcon(item.tool.name)} size={13} color={colors.info} /><text style={{ color: colors.textMuted, fontSize: 12, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{toolSummary(item.tool)}</text></div>
      {content && <text style={{ color: colors.textFaint, fontSize: 10, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{content}</text>}
    </div>
  )
}

function contextInjectionLabel(item: Extract<TimelineItem, { kind: 'context-injection' }>): string {
  return item.source ? item.source.replace(/\[|\]/g, '').toUpperCase() : 'CONTEXT INJECTION'
}

function compactionTraceLabel(trace: Extract<DisplayTimelineItem, { kind: 'work-trace' }>): string | undefined {
  if (!isCompactionWorkTrace(trace)) return undefined
  const compaction = trace.items.find((item): item is Extract<TraceTimelineItem, { kind: 'compaction' }> => item.kind === 'compaction')
  if (!compaction) return undefined
  return typeof compaction.tokensBefore === 'number' ? `Compacted from ${compaction.tokensBefore.toLocaleString()} tokens` : 'Compacted'
}

function CollapsedTraceTools({ items, hidden, presenters }: { items: Array<Extract<TraceTimelineItem, { kind: 'tool' }>>; hidden: number; presenters: ReadonlyMap<string, ToolPresenter> }) {
  return (
    <div testId="collapsed-trace-tools" style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingLeft: 1 }}>
      {items.map((item) => {
        const presentation = resolveToolPresentation(item.tool, presenters)
        const label = presentation.fabric?.name || presentation.title || toolSummary(item.tool)
        return (
          <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div testId="collapsed-trace-tool" style={{ minHeight: 19, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <text style={{ width: 10, color: item.tool.isError ? colors.error : item.tool.status === 'complete' ? colors.textFaint : colors.warning, fontSize: 11 }}>{item.tool.isError ? '×' : item.tool.status === 'complete' ? '›' : '•'}</text>
              <text style={{ width: 0, minWidth: 0, flexGrow: 1, overflow: 'hidden', color: colors.textFaint, fontSize: 10, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{label}</text>
            </div>
            {presentation.fabric && presentation.fabric.audits.length > 0 && <FabricCollapsedCalls audits={presentation.fabric.audits} compact />}
          </div>
        )
      })}
      {hidden > 0 && <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontMono }}>{`… ${hidden} tool ${hidden === 1 ? 'call' : 'calls'} hidden`}</text>}
    </div>
  )
}

function RetiringAssistantRow({ item, onRevert, onDone }: { item: AssistantTimelineItem; onRevert(entryId: string): void; onDone(): void }) {
  const [open, setOpen] = useState(true)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  useEffect(() => {
    const timer = setTimeout(() => setOpen(false), 16)
    return () => clearTimeout(timer)
  }, [])
  const height = open ? RETIRING_ASSISTANT_HEIGHT : 0
  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => onDoneRef.current(), SPRING_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [open])
  return (
    <TranscriptRowShell>
      <MotionDiv
        testId="retiring-assistant"
        initial={{ opacity: 1, top: 0 }}
        animate={{ opacity: open ? 1 : 0, top: open ? 0 : -8, height }}
        transition={LAYOUT_MOTION_TRANSITION}
        style={{ position: 'relative', overflow: 'hidden', height: Math.max(0, height), width: '100%' }}
      >
        <AssistantMessage item={{ ...item, streaming: false }} onRevert={onRevert} />
      </MotionDiv>
    </TranscriptRowShell>
  )
}

function collapsedPreviewHeight(
  tools: Array<Extract<TraceTimelineItem, { kind: 'tool' }>>,
  preview: TraceTimelineItem | undefined,
  presenters: ReadonlyMap<string, ToolPresenter>,
): number {
  let rows = preview && preview.kind !== 'tool' ? 1 : 0
  for (const item of tools) {
    rows += 1
    const fabric = resolveToolPresentation(item.tool, presenters).fabric
    if (!fabric || fabric.audits.length === 0) continue
    const visible = Math.min(fabric.audits.length, COLLAPSED_TRACE_TOOL_LIMIT)
    rows += visible + (fabric.audits.length > visible ? 1 : 0)
  }
  return rows * COLLAPSED_TRACE_ROW_HEIGHT
}

function markdownPreview(value: string): string {
  return compactOneLine(value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]/g, ''))
}

function compactOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function formatFabricValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.slice(0, 18_000)
  try {
    return JSON.stringify(value, null, 2).slice(0, 18_000)
  } catch {
    return String(value).slice(0, 18_000)
  }
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1_000).toFixed(1)}s`
}

function MessageImage({ image }: { image: PiImageContent }) {
  return (
    <div style={{ width: 156, height: 104, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card, overflow: 'hidden' }}>
      {image.previewPath
        ? React.createElement('img', { src: image.previewPath, alt: 'Attached image', objectFit: 'cover', style: { width: 156, height: 104 } } as never)
        : <text style={{ color: colors.textFaint, fontSize: 11 }}>Attached image</text>}
    </div>
  )
}

function MessageFooter({
  timestamp,
  copyText,
  revertEntryId,
  align,
  onRevert,
}: {
  timestamp?: number | undefined
  copyText: string
  revertEntryId?: string | undefined
  align: 'start' | 'end'
  onRevert(entryId: string): void
}) {
  const [copied, setCopied] = useState(false)
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
  }, [])
  const copy = async () => {
    if (!await copyTextToClipboard(copyText)) return
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    setCopied(true)
    copyResetTimer.current = setTimeout(() => {
      copyResetTimer.current = undefined
      setCopied(false)
    }, 900)
  }
  const actions = (
    <>
      {revertEntryId && <TranscriptInlineAction icon="gitBranch" testId="tree-message" onClick={() => onRevert(revertEntryId)} />}
      {copyText && <TranscriptInlineAction icon={copied ? 'check' : 'copy'} testId="copy-message" onClick={() => void copy()} />}
    </>
  )
  return (
    <div testId="message-footer" style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: align === 'end' ? 'flex-end' : 'flex-start', gap: 5 }}>
      {align === 'start' && actions}
      {timestamp && <Timestamp value={timestamp} />}
      {align === 'end' && actions}
    </div>
  )
}

function WorkingRow({ activity: _activity }: { activity: string }) {
  const { contentGutter } = useResponsiveLayout()
  return (
    <div testId="working-row" style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', width: '100%', paddingLeft: contentGutter, paddingRight: contentGutter, paddingTop: 2, paddingBottom: 8 }}>
      <div style={{ width: '100%', maxWidth: 768, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 5 }}>
        <TextShimmer text="Working" fontSize={13} baseColor={colors.textMuted} highlightColor={colors.text} />
      </div>
    </div>
  )
}

function StatusMessage({ text, error, timestamp }: { text: string; error: boolean; timestamp?: number | undefined }) {
  return (
    <div style={{ padding: 8, borderRadius: 7, backgroundColor: error ? colors.diffDel : colors.card }}>
      <text style={{ color: error ? colors.error : colors.textMuted, fontSize: 12, lineHeight: 18 }}>{text}</text>
      {timestamp && <Timestamp value={timestamp} />}
    </div>
  )
}

function EmptyConversation({ workspacePath }: { workspacePath: string }) {
  const { contentGutter } = useResponsiveLayout()
  const project = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? workspacePath
  return (
    <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', width: '100%', paddingLeft: contentGutter, paddingRight: contentGutter, paddingBottom: 190 }}>
      <div style={{ width: '100%', maxWidth: 768, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
        <text style={{ color: colors.text, fontSize: 26, fontWeight: 500 }}>{`What should we build in ${project}?`}</text>
      </div>
    </div>
  )
}

function ComposerSpacer({ questionnaireCollapsed, queue, statusItems, widgets }: { questionnaireCollapsed: boolean; queue: WorkbenchState['queue']; statusItems: WorkbenchState['statusItems']; widgets: WorkbenchState['widgets'] }) {
  const targetHeight = 194 + questionnaireWaitingDockReserveHeight(questionnaireCollapsed) + queueDockReserveHeight(queue) + extensionSurfaceRailReserveHeight(widgets, statusItems)
  return <MotionDiv initial={false} animate={{ height: targetHeight }} transition={LAYOUT_MOTION_TRANSITION} testId="composer-spacer" style={{ width: '100%', height: targetHeight }} />
}

function Timestamp({ value }: { value: number }) {
  return <text style={{ color: colors.textFaint, fontSize: 9 }}>{formatTimestamp(value)}</text>
}

export function ChangedFilesCard({ paths, onOpenDiff }: { paths: string[]; onOpenDiff(): void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 5, padding: 10, borderRadius: 10, backgroundColor: colors.card, fontFamily: nativeTheme.fontMono }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="chevronDown" size={10} color={colors.textFaint} />
        <text style={{ color: colors.text, fontSize: 10, fontWeight: 600, fontFamily: nativeTheme.fontMono }}>{`${paths.length} changed ${paths.length === 1 ? 'file' : 'files'}`}</text>
        <div style={{ flexGrow: 1 }} />
        <div testId="changed-files-open-diff" tabIndex={0} style={{ height: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 7, paddingRight: 7, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onOpenDiff} onKeyDown={(event) => { if (event.key === 'enter') onOpenDiff() }}>
          <Icon name="fileDiff" size={11} color={colors.textFaint} />
          <text style={{ color: colors.textMuted, fontSize: 9, fontFamily: nativeTheme.fontMono }}>Open diff</text>
        </div>
      </div>
      {paths.map((path) => (
        <React.Fragment key={path}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 13 }}>
            <Icon name="fileDiff" size={11} color={colors.textFaint} />
            <text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontFamily: nativeTheme.fontMono }}>{path}</text>
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

function traceDuration(items: Array<Pick<TimelineItem, 'timestamp'>>): string | undefined {
  let earliest = Number.POSITIVE_INFINITY
  let latest = Number.NEGATIVE_INFINITY
  let timestampCount = 0
  for (const item of items) {
    if (typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp)) continue
    earliest = Math.min(earliest, item.timestamp)
    latest = Math.max(latest, item.timestamp)
    timestampCount += 1
  }
  return timestampCount > 1 ? formatElapsedSeconds((latest - earliest) / 1_000) : undefined
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
