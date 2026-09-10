import { useDirectoryPicker } from './use-directory-picker.ts'
import { hasNativeTrafficLights } from './window-chrome.ts'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, useGpuixRequired, type SelectItemState, type SelectTriggerState } from '@gpuix/react'
import { resolve } from 'node:path'
import { isCurrentPiSession, sessionProjectName, type PiSessionSummary } from '../pi/session-catalog.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { contentText, type WorkbenchState } from '../workbench/state.ts'
import { DropdownSurface, useDropdownState } from './dropdown.tsx'
import { Icon } from './icons.tsx'
import { IconButton, NativeVirtualList, type NativeElementHandle, type NativeScrollEvent } from './primitives.tsx'
import { pickWorkspaceDirectory } from './open-external.ts'
import { colors } from './theme.ts'
import { SessionRow, sessionLifecycleBucket } from './sidebar-session-row.tsx'

export { SESSION_SETTLED_AFTER_MS, sessionLifecycleBucket } from './sidebar-session-row.tsx'

const SIDEBAR_WIDTH = 256
const ALL_PROJECTS_SCOPE = '__all-projects__'

export const WorkbenchSidebar = React.memo(function WorkbenchSidebar({
  width = SIDEBAR_WIDTH,
  pickDirectory = pickWorkspaceDirectory,
  state,
  controller,
  flowsAvailable = false,
  flowsActive = false,
  settingsActive,
  notificationsActive,
  unreadCount,
  appearance,
  onSelectSession,
  onFlows = () => undefined,
  onSettings,
  onNotifications,
}: {
  pickDirectory?: typeof pickWorkspaceDirectory
  width?: number
  state: WorkbenchState
  controller: WorkbenchController
  flowsAvailable?: boolean
  flowsActive?: boolean
  settingsActive: boolean
  notificationsActive: boolean
  unreadCount: number
  appearance?: 'light' | 'dark'
  onSelectSession(): void
  onFlows?(): void
  onSettings(): void
  onNotifications(): void
}) {
  const renderer = useGpuixRequired()
  const [search, setSearch] = useState('')
  const [projectScope, setProjectScope] = useState(ALL_PROJECTS_SCOPE)
  const { picking: pickingProject, pick } = useDirectoryPicker(pickDirectory, controller)
  const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null)
  const [settledExpanded, setSettledExpanded] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const sessionScrollDistance = useRef(0)
  const sessionLastOffset = useRef(0)
  const sessionListRef = useRef<NativeElementHandle | null>(null)
  const initialSessionScrollApplied = useRef(false)
  const activePath = state.session.sessionFile
  const persistedSessions = useMemo(() => state.sessions.filter((session) => session.messageCount > 0), [state.sessions])
  const activeSummary = useMemo(
    () => persistedSessions.find((session) => session.path === activePath) ?? syntheticActiveSession(state),
    [activePath, persistedSessions, state],
  )
  const normalizedSearch = search.trim().toLowerCase()
  const projectOptions = useMemo(() => {
    const projects = new Map<string, string>()
    for (const session of [activeSummary, ...persistedSessions]) {
      if (!session) continue
      projects.set(resolve(session.cwd), sessionProjectName(session))
    }
    return [
      { value: ALL_PROJECTS_SCOPE, label: 'All projects' },
      ...[...projects].map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label)),
    ]
  }, [activeSummary, persistedSessions])
  useEffect(() => {
    if (!projectOptions.some((option) => option.value === projectScope)) setProjectScope(ALL_PROJECTS_SCOPE)
  }, [projectOptions, projectScope])
  const matchingSessions = useMemo(() => {
    const unique = new Map<string, PiSessionSummary>()
    if (activeSummary) unique.set(activeSummary.path, activeSummary)
    for (const session of persistedSessions) unique.set(session.path, session)
    const sorted = [...unique.values()].sort((left, right) => right.modifiedAt - left.modifiedAt)
    const scoped = projectScope === ALL_PROJECTS_SCOPE
      ? sorted
      : sorted.filter((session) => resolve(session.cwd) === projectScope)
    return normalizedSearch
      ? scoped.filter((session) => `${session.title} ${session.firstMessage} ${sessionProjectName(session)} ${session.cwd}`.toLowerCase().includes(normalizedSearch))
      : scoped
  }, [activeSummary, normalizedSearch, persistedSessions, projectScope])
  const visibleSessions = matchingSessions
  const now = clock
  useEffect(() => {
    if (initialSessionScrollApplied.current || state.sessionsLoading || visibleSessions.length === 0) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled || !sessionListRef.current) return
      renderer.scrollTo?.(sessionListRef.current.id, 0, 0)
      sessionScrollDistance.current = 0
      initialSessionScrollApplied.current = true
    })
    return () => { cancelled = true }
  }, [renderer, state.sessionsLoading, visibleSessions.length])
  useEffect(() => {
    const currentTime = Date.now()
    const nextWake = Object.values(state.threadLifecycle)
      .map((lifecycle) => lifecycle.snoozedUntil)
      .filter((value): value is number => typeof value === 'number' && value > currentTime)
      .sort((left, right) => left - right)[0]
    const nextMinute = currentTime + (60_000 - currentTime % 60_000)
    const refreshAt = Math.min(nextWake ?? Number.POSITIVE_INFINITY, nextMinute)
    const timer = setTimeout(() => setClock(Date.now()), Math.max(25, refreshAt - currentTime + 10))
    return () => clearTimeout(timer)
  }, [now, state.threadLifecycle])
  const activeSessions = visibleSessions.filter((session) => sessionLifecycleBucket(session, state.threadLifecycle[session.path], now) === 'active')
  const snoozedSessions = visibleSessions.filter((session) => sessionLifecycleBucket(session, state.threadLifecycle[session.path], now) === 'snoozed')
  const settledSessions = visibleSessions.filter((session) => sessionLifecycleBucket(session, state.threadLifecycle[session.path], now) === 'settled')
  const renderedSettledSessions = settledExpanded
    ? settledSessions
    : settledSessions.filter((session) => isCurrentPiSession(session, state.session))
  const connectionColor = state.connection === 'connected'
    ? colors.success
    : state.connection === 'connecting'
      ? colors.warning
      : colors.error

  const renderSession = (session: PiSessionSummary, lifecycle: 'active' | 'snoozed' | 'settled') => {
    const active = isCurrentPiSession(session, state.session)
    return (
      <SessionRow
        key={session.path}
        sidebarWidth={width}
        session={session}
        projectName={sessionProjectName(session)}
        active={active}
        running={active && state.session.isStreaming}
        disabled={false}
        lifecycle={lifecycle}
        {...(state.threadLifecycle[session.path]?.snoozedUntil === undefined ? {} : { snoozedUntil: state.threadLifecycle[session.path]!.snoozedUntil })}
        branch={resolve(session.cwd) === resolve(state.workspacePath) ? state.workspaceDiff.branch || 'main' : 'saved session'}
        snoozeOpen={snoozeMenu === session.path}
        onClick={() => { onSelectSession(); void controller.switchSession(session) }}
        onSettle={() => { setSnoozeMenu(null); controller.settleThread(session.path) }}
        onWake={() => controller.wakeThread(session.path)}
        onSnooze={() => setSnoozeMenu((current) => current === session.path ? null : session.path)}
        onSchedule={(until) => { setSnoozeMenu(null); controller.snoozeThread(session.path, until) }}
      />
    )
  }

  const handleSessionScroll = (event: NativeScrollEvent) => {
    const offset = renderer.getScrollOffset?.(event.elementId)?.[1] ?? sessionLastOffset.current
    const downwardDistance = Math.max(0, sessionLastOffset.current - offset)
    sessionLastOffset.current = offset
    if (!state.sessionsHasMore || state.sessionsLoading) return
    sessionScrollDistance.current += downwardDistance
    if (sessionScrollDistance.current < 640) return
    sessionScrollDistance.current = 0
    void controller.loadMoreSessions()
  }

  return (
    <div testId="sidebar" style={{ position: 'relative', width, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.sidebar, userSelect: 'none', overflow: 'visible' }}>
      <BrandHeader />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8, paddingTop: 6 }}>
        {flowsAvailable && (
          <div testId="sidebar-flows" tabIndex={0} style={{ height: 32, alignSelf: 'stretch', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8, borderRadius: 8, backgroundColor: flowsActive ? colors.sidebarActive : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={onFlows}>
            <Icon name="gitBranch" size={15} color={flowsActive ? colors.text : colors.textMuted} />
            <text style={{ color: flowsActive ? colors.text : colors.textMuted, fontSize: 12, fontWeight: flowsActive ? 650 : 550 }}>Flows</text>
          </div>
        )}
        <div style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 6 }}>
          <div style={{ height: 32, minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 8, paddingRight: 7, borderRadius: 8, hover: { backgroundColor: colors.sidebarHover } }}>
            <Icon name="search" size={15} color={colors.textFaint} />
            <input
              testId="sidebar-search"
              value={search}
              placeholder="Search"
              theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }}
              style={{ minWidth: 0, flexGrow: 1, height: 26, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 12 }}
              onChange={(event) => setSearch(String(event.value ?? ''))}
            />
          </div>
          <IconButton testId="sidebar-new-thread" icon="squarePen" label="New thread" disabled={state.session.isStreaming || state.connection !== 'connected'} onClick={() => { onSelectSession(); void controller.newSession() }} />
        </div>

        <div style={{ alignSelf: 'stretch', height: 34, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <ProjectFilter value={projectScope} options={projectOptions} onChange={setProjectScope} />
          <IconButton
            testId="sidebar-new-project"
            icon="folderPlus"
            label={pickingProject ? 'Choosing project…' : 'New project'}
            disabled={pickingProject}
            onClick={() => {
              void pick()
            }}
          />
        </div>
      </div>

      <div testId="sidebar-session-region" style={{ position: 'relative', flexGrow: 1, minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column', opacity: state.sessionsLoading || state.connection === 'connecting' ? 0.55 : 1 }}>
      <NativeVirtualList testId="sidebar-session-list" elementRef={sessionListRef} alignment="top" estimatedItemHeight={78} overdraw={280} onScroll={handleSessionScroll} style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
        {activeSessions.map((session) => renderSession(session, 'active'))}
        {snoozedSessions.length > 0 && <SectionLabel label={`Snoozed (${snoozedSessions.length})`} tone="accent" />}
        {snoozedSessions.map((session) => renderSession(session, 'snoozed'))}
        {settledSessions.length > 0 && (
          <SettledShelfHeader count={settledSessions.length} expanded={settledExpanded} onToggle={() => setSettledExpanded((value) => !value)} />
        )}
        {renderedSettledSessions.map((session) => renderSession(session, 'settled'))}
        {visibleSessions.length === 0 && !state.sessionsLoading && (
          <div style={{ paddingTop: 22, paddingLeft: 78 }}>
            <text style={{ color: colors.textFaint, fontSize: 11 }}>{normalizedSearch ? 'No threads found' : 'No threads in this project'}</text>
          </div>
        )}
      </NativeVirtualList>
      </div>

      <div style={{ height: 46, paddingLeft: 8, paddingRight: 8, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        <IconButton icon="settings" label="Settings" testId="sidebar-settings" active={settingsActive} onClick={onSettings} />
        <div style={{ position: 'relative' }}>
          <IconButton icon="bell" label="Notifications" testId="sidebar-notifications" active={notificationsActive} onClick={onNotifications} />
          {unreadCount > 0 && <div style={{ position: 'absolute', top: 2, right: 1, minWidth: 13, height: 13, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 3, paddingRight: 3, backgroundColor: colors.primary }}><text style={{ color: '#FFFFFF', fontSize: 7, fontWeight: 700 }}>{String(Math.min(99, unreadCount))}</text></div>}
        </div>
        <IconButton icon="refresh" label="Refresh threads" disabled={state.sessionsLoading} onClick={() => void controller.refreshSessions()} />
        <div style={{ flexGrow: 1 }} />
        <div testId="sidebar-connection-status" style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: connectionColor }} />
        </div>
      </div>
    </div>
  )
}, (previous, next) => previous.controller === next.controller
  && previous.pickDirectory === next.pickDirectory
  && previous.width === next.width
  && previous.flowsAvailable === next.flowsAvailable
  && previous.flowsActive === next.flowsActive
  && previous.settingsActive === next.settingsActive
  && previous.notificationsActive === next.notificationsActive
  && previous.unreadCount === next.unreadCount
  && previous.appearance === next.appearance
  && previous.state.sessions === next.state.sessions
  && previous.state.sessionsLoading === next.state.sessionsLoading
  && previous.state.sessionsHasMore === next.state.sessionsHasMore
  && previous.state.session === next.state.session
  && previous.state.connection === next.state.connection
  && previous.state.threadLifecycle === next.state.threadLifecycle
  && previous.state.workspacePath === next.state.workspacePath
  && previous.state.workspaceDiff.branch === next.state.workspaceDiff.branch)

function ProjectFilter({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange(value: string): void }) {
  const dropdown = useDropdownState()
  const selected = options.find((option) => option.value === value) ?? options[0]!
  return (
    <Select value={value} open={dropdown.mounted} onOpenChange={dropdown.setOpen} onValueChange={onChange} style={{ minWidth: 0, flexGrow: 1 }}>
      <SelectTrigger
        testId="sidebar-project-toggle"
        style={(_trigger: SelectTriggerState) => ({ minWidth: 0, width: '100%', height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 8, paddingRight: 14, borderRadius: 8, backgroundColor: dropdown.open ? colors.sidebarHover : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } })}
      >
        <Icon name="folder" size={15} color={colors.textFaint} />
        <text testId="sidebar-project-label" style={{ color: colors.textMuted, fontSize: 12, fontWeight: 550, minWidth: 0, flexGrow: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{selected.label}</text>
        <div testId="sidebar-project-chevron" style={{ width: 12, height: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name="chevronDown" size={12} color={colors.textFaint} />
        </div>
      </SelectTrigger>
      <SelectContent testId="sidebar-project-filter" side="bottom" sideOffset={5} align="start" style={{ width: 238, minHeight: 0, padding: 0, borderWidth: 0, borderRadius: 0, backgroundColor: colors.sidebar, overflow: 'visible', pointerEvents: dropdown.open ? 'auto' : 'none' }}>
        <DropdownSurface testId="sidebar-project-menu" open={dropdown.open} style={{ width: '100%', height: Math.min(320, Math.max(44, options.length * 34 + 10)), minHeight: 0, padding: 5, overflow: 'hidden' }}>
          <NativeVirtualList testId="sidebar-project-list" alignment="top" estimatedItemHeight={34} overdraw={102} style={{ width: '100%', flexGrow: 1, minHeight: 0 }}>
          {options.map((option, index) => (
            <SelectItem
              key={option.value}
              testId={`sidebar-project-option-${index}`}
              value={option.value}
              textValue={option.label}
              style={(item: SelectItemState) => ({ height: 34, width: '100%', minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8, borderRadius: 7, backgroundColor: item.highlighted || item.selected ? colors.hover : colors.popover, cursor: 'pointer' })}
            >
              {(item: SelectItemState) => (
                <>
                  <Icon name="folder" size={14} color={item.selected ? colors.text : colors.textFaint} />
                  <text style={{ minWidth: 0, flexGrow: 1, color: item.selected ? colors.text : colors.textMuted, fontSize: 12, fontWeight: item.selected ? 650 : 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{option.label}</text>
                  {item.selected && <Icon name="check" size={12} color={colors.textMuted} />}
                </>
              )}
            </SelectItem>
          ))}
          </NativeVirtualList>
        </DropdownSurface>
      </SelectContent>
    </Select>
  )
}

function BrandHeader() {
  return (
    <div testId="sidebar-brand" style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingLeft: hasNativeTrafficLights() ? 90 : 0, backgroundColor: colors.sidebar }}>
      <text style={{ color: colors.textMuted, fontSize: 12, fontWeight: 650 }}>Heddlework</text>
    </div>
  )
}

function SectionLabel({ label, tone = 'normal' }: { label: string; tone?: 'normal' | 'accent' }) {
  return (
    <div style={{ height: 28, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 11, paddingRight: 8 }}>
      <text style={{ color: tone === 'accent' ? colors.info : colors.textFaint, fontSize: 10 }}>{label}</text>
      <div style={{ height: 1, flexGrow: 1, backgroundColor: tone === 'accent' ? '#153A5A' : colors.border }} />
      <Icon name="chevronDown" size={10} color={tone === 'accent' ? colors.info : colors.textFaint} />
    </div>
  )
}

function SettledShelfHeader({ count, expanded, onToggle }: { count: number; expanded: boolean; onToggle(): void }) {
  return (
    <div testId="sidebar-settled-toggle" tabIndex={0} style={{ height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 7, paddingLeft: 11, paddingRight: 9, cursor: 'pointer' }} onClick={onToggle}>
      <text style={{ color: colors.settledText, fontSize: 10, fontWeight: 550, pointerEvents: 'none' }}>{expanded ? 'Settled' : `Settled (${count})`}</text>
      <div style={{ height: 1, flexGrow: 1, backgroundColor: colors.settledDivider, pointerEvents: 'none' }} />
      <div style={{ width: 10, height: 10, pointerEvents: 'none' }}><Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={10} color={colors.settledText} /></div>
    </div>
  )
}

function SidebarTextAction({ label, onClick }: { label: string; onClick(): void }) {
  return <div tabIndex={0} style={{ height: 28, display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={onClick}><text style={{ color: colors.textMuted, fontSize: 10, fontWeight: 550 }}>{label}</text></div>
}

function syntheticActiveSession(state: WorkbenchState): PiSessionSummary | null {
  if (state.messages.length === 0) return null
  const firstUser = state.messages.find((message) => message.role === 'user')
  const firstMessage = firstUser ? contentText(firstUser.content).trim() : ''
  return {
    id: state.session.sessionId ?? 'current',
    path: state.session.sessionFile ?? `current:${state.session.sessionId ?? 'new'}`,
    cwd: state.workspacePath,
    title: state.session.sessionName ?? compactTitle(firstMessage || 'New thread'),
    ...(state.session.sessionName ? { name: state.session.sessionName } : {}),
    firstMessage: firstMessage || '(no messages)',
    messageCount: state.messages.length,
    createdAt: Date.now(),
    modifiedAt: state.messages.at(-1)?.timestamp ?? Date.now(),
  }
}

function compactTitle(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}…` : value
}
