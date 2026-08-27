import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, useGpuixRequired, type SelectItemState, type SelectTriggerState } from '@gpuix/react'
import { resolve } from 'node:path'
import { sessionProjectName, type PiSessionSummary } from '../pi/session-catalog.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { contentText, type ThreadLifecycle, type WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { IconButton, NativeVirtualList, type NativeElementHandle, type NativeScrollEvent } from './primitives.tsx'
import { launchWorkspaceWindow, pickWorkspaceDirectory } from './open-external.ts'
import { colors } from './theme.ts'
import { MotionDiv } from './motion.ts'

const SIDEBAR_WIDTH = 256
const SIDEBAR_BORDER_WIDTH = 1
const SESSION_ROW_INSET = 8
export const SESSION_SETTLED_AFTER_MS = 7 * 24 * 60 * 60 * 1_000
const ALL_PROJECTS_SCOPE = '__all-projects__'

export const WorkbenchSidebar = React.memo(function WorkbenchSidebar({
  state,
  controller,
  settingsActive,
  notificationsActive,
  unreadCount,
  onSelectSession,
  onSettings,
  onNotifications,
}: {
  state: WorkbenchState
  controller: WorkbenchController
  settingsActive: boolean
  notificationsActive: boolean
  unreadCount: number
  onSelectSession(): void
  onSettings(): void
  onNotifications(): void
}) {
  const renderer = useGpuixRequired()
  const [search, setSearch] = useState('')
  const [projectScope, setProjectScope] = useState(ALL_PROJECTS_SCOPE)
  const [pickingProject, setPickingProject] = useState(false)
  const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null)
  const [settledExpanded, setSettledExpanded] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const sessionScrollDistance = useRef(0)
  const sessionLastOffset = useRef(0)
  const [sessionFades, setSessionFades] = useState({ top: false, bottom: false })
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
    : settledSessions.filter((session) => session.path === activePath || session.id === state.session.sessionId)
  const sessionContentHeight = activeSessions.length * 78
    + (snoozedSessions.length > 0 ? 28 : 0)
    + snoozedSessions.length * 36
    + (settledSessions.length > 0 ? 39 : 0)
    + renderedSettledSessions.length * 36
    + (visibleSessions.length === 0 && !state.sessionsLoading ? 50 : 0)
  const updateSessionFades = () => {
    const list = sessionListRef.current
    if (!list) return
    const offset = renderer.getScrollOffset?.(list.id)?.[1] ?? 0
    const windowHeight = renderer.getWindowSize?.().height ?? 0
    const fallbackHeight = windowHeight > 184 ? windowHeight - 184 : 616
    // NativeRenderer exposes no getElementBounds (that is an automation-only API);
    // querying it throws a 2s timeout on the production host. Use window-based fallback.
    const viewportHeight = fallbackHeight
    const next = {
      top: offset < -0.5,
      bottom: viewportHeight > 0 && sessionContentHeight + offset > viewportHeight + 0.5,
    }
    setSessionFades((current) => current.top === next.top && current.bottom === next.bottom ? current : next)
  }
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) updateSessionFades() })
    return () => { cancelled = true }
  }, [sessionContentHeight, state.sessionsLoading])
  const connectionColor = state.connection === 'connected'
    ? colors.success
    : state.connection === 'connecting'
      ? colors.warning
      : colors.error

  const renderSession = (session: PiSessionSummary, lifecycle: 'active' | 'snoozed' | 'settled') => {
    const active = session.path === activePath || session.id === state.session.sessionId
    return (
      <SessionRow
        key={session.path}
        session={session}
        projectName={sessionProjectName(session)}
        active={active}
        running={active && state.session.isStreaming}
        disabled={state.connection !== 'connected' || (state.session.isStreaming && !active)}
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
    updateSessionFades()
    if (!state.sessionsHasMore || state.sessionsLoading) return
    sessionScrollDistance.current += downwardDistance
    if (sessionScrollDistance.current < 640) return
    sessionScrollDistance.current = 0
    void controller.loadMoreSessions()
  }

  return (
    <div testId="sidebar" style={{ position: 'relative', width: SIDEBAR_WIDTH, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.sidebar, userSelect: 'none', overflow: 'visible' }}>
      <BrandHeader />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8, paddingTop: 6 }}>
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
              setPickingProject(true)
              void pickWorkspaceDirectory().then((path) => {
                if (path) launchWorkspaceWindow(path)
              }).finally(() => setPickingProject(false))
            }}
          />
        </div>
      </div>

      <div testId="sidebar-session-region" style={{ position: 'relative', flexGrow: 1, minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
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
      <SidebarScrollFade edge="top" visible={sessionFades.top} />
      <SidebarScrollFade edge="bottom" visible={sessionFades.bottom} />
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
  && previous.settingsActive === next.settingsActive
  && previous.notificationsActive === next.notificationsActive
  && previous.unreadCount === next.unreadCount
  && previous.state.sessions === next.state.sessions
  && previous.state.sessionsLoading === next.state.sessionsLoading
  && previous.state.sessionsHasMore === next.state.sessionsHasMore
  && previous.state.session === next.state.session
  && previous.state.connection === next.state.connection
  && previous.state.threadLifecycle === next.state.threadLifecycle
  && previous.state.workspacePath === next.state.workspacePath
  && previous.state.workspaceDiff.branch === next.state.workspaceDiff.branch)

function SidebarScrollFade({ edge, visible }: { edge: 'top' | 'bottom'; visible: boolean }) {
  const bands = edge === 'top'
    ? ['#090A0B', '#090A0BCC', '#090A0B66', '#090A0B20']
    : ['#090A0B20', '#090A0B66', '#090A0BCC', '#090A0B']
  return (
    <MotionDiv testId={`sidebar-scroll-fade-${edge}`} initial={false} animate={{ opacity: visible ? 1 : 0 }} transition={{ duration: 0.18, ease: 'easeOut' }} style={{ position: 'absolute', left: 0, right: 0, ...(edge === 'top' ? { top: 0 } : { bottom: 0 }), height: 24, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
      {bands.map((backgroundColor, index) => <React.Fragment key={index}><div style={{ height: 6, width: '100%', backgroundColor, pointerEvents: 'none' }} /></React.Fragment>)}
    </MotionDiv>
  )
}

function ProjectFilter({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange(value: string): void }) {
  const selected = options.find((option) => option.value === value) ?? options[0]!
  return (
    <Select value={value} onValueChange={onChange} style={{ minWidth: 0, flexGrow: 1 }}>
      <SelectTrigger
        testId="sidebar-project-toggle"
        style={(trigger: SelectTriggerState) => ({ minWidth: 0, width: '100%', height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 8, paddingRight: 14, borderRadius: 8, backgroundColor: trigger.open ? colors.sidebarHover : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } })}
      >
        <Icon name="folder" size={15} color={colors.textFaint} />
        <text testId="sidebar-project-label" style={{ color: colors.textMuted, fontSize: 12, fontWeight: 550, minWidth: 0, flexGrow: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{selected.label}</text>
        <div testId="sidebar-project-chevron" style={{ width: 12, height: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name="chevronDown" size={12} color={colors.textFaint} />
        </div>
      </SelectTrigger>
      <SelectContent testId="sidebar-project-filter" side="bottom" sideOffset={5} align="start" style={{ width: 238, maxHeight: 320, minHeight: 0, padding: 5, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover, overflow: 'scroll' }}>
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
      </SelectContent>
    </Select>
  )
}

export function sessionLifecycleBucket(session: PiSessionSummary, lifecycle: ThreadLifecycle | undefined, now: number): 'active' | 'snoozed' | 'settled' {
  if ((lifecycle?.snoozedUntil ?? 0) > now) return 'snoozed'
  if (lifecycle?.settledAt) return 'settled'
  if ((lifecycle?.unsettledAt ?? 0) > session.modifiedAt) return 'active'
  if (now - session.modifiedAt > SESSION_SETTLED_AFTER_MS) return 'settled'
  return 'active'
}

function BrandHeader() {
  return (
    <div testId="sidebar-brand" style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingLeft: process.platform === 'darwin' ? 90 : 0, backgroundColor: colors.sidebar }}>
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

function SessionRowInset({ height, children }: { height: number; children: React.ReactNode }) {
  const width = SIDEBAR_WIDTH - 2 * SIDEBAR_BORDER_WIDTH
  return <div testId="sidebar-session-inset" style={{ width, height, flexShrink: 0, paddingLeft: SESSION_ROW_INSET, paddingRight: SESSION_ROW_INSET }}>{children}</div>
}

function SessionRow({
  session,
  projectName,
  active,
  running,
  disabled,
  lifecycle,
  snoozedUntil,
  branch,
  snoozeOpen,
  onClick,
  onSettle,
  onWake,
  onSnooze,
  onSchedule,
}: {
  session: PiSessionSummary
  projectName: string
  active: boolean
  running: boolean
  disabled: boolean
  lifecycle: 'active' | 'snoozed' | 'settled'
  snoozedUntil?: number
  branch: string
  snoozeOpen: boolean
  onClick(): void
  onSettle(): void
  onWake(): void
  onSnooze(): void
  onSchedule(until: number): void
}) {
  const [hovered, setHovered] = useState(false)
  const [settleHovered, setSettleHovered] = useState(false)
  if (lifecycle !== 'active') {
    return (
      <SessionRowInset height={36}>
      <div testId={lifecycle === 'settled' ? 'sidebar-settled-row' : 'sidebar-snoozed-row'} style={{ height: 36, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 10, paddingRight: 6, borderRadius: 7, hover: { backgroundColor: colors.sidebarHover } }}>
        <Icon name={lifecycle === 'snoozed' ? 'clock' : 'squarePen'} size={13} color={lifecycle === 'snoozed' ? colors.info : colors.settledIcon} />
        <div tabIndex={disabled ? -1 : 0} style={{ minWidth: 0, flexGrow: 1, cursor: disabled ? 'default' : 'pointer' }} {...(disabled ? {} : { onClick })}>
          <text {...(lifecycle === 'settled' ? { testId: 'sidebar-settled-title' } : {})} style={{ color: lifecycle === 'settled' ? colors.settledText : colors.textFaint, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{session.title}</text>
        </div>
        <text style={{ color: lifecycle === 'settled' ? colors.settledMeta : colors.textFaint, fontSize: 9 }}>{lifecycle === 'snoozed' && snoozedUntil ? new Date(snoozedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : relativeTime(session.modifiedAt)}</text>
        <div testId="sidebar-wake" tabIndex={0} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} onClick={onWake}>
          <Icon name="check" size={12} color={lifecycle === 'settled' ? colors.settledIcon : colors.textFaint} />
        </div>
      </div>
      </SessionRowInset>
    )
  }

  return (
    <SessionRowInset height={78}>
    <div testId={active ? 'sidebar-session-card-active' : 'sidebar-session-card'} style={{ position: 'relative', height: 78, minHeight: 78, maxHeight: 78, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4, padding: 9, borderRadius: 8, backgroundColor: colors.transparent, opacity: disabled ? 0.45 : 1, overflow: 'visible' }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => { setHovered(false); setSettleHovered(false) }}>
      <div testId="sidebar-session-surface" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 8, backgroundColor: active ? colors.sidebarActive : hovered ? colors.sidebarHover : colors.transparent, pointerEvents: 'none' }} />
      <div style={{ width: '100%', minWidth: 0, height: 20, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Icon name="folder" size={13} color={colors.textFaint} />
        <text style={{ color: colors.textMuted, fontSize: 10, fontWeight: 550, minWidth: 0, flexGrow: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{projectName}</text>
        <div style={{ width: 70, height: 20, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
          {hovered || snoozeOpen ? (
            <>
              <div style={{ position: 'relative', display: 'flex', flexDirection: 'row' }}>
                <div testId="sidebar-snooze" tabIndex={0} style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', borderRadius: 5, hover: { backgroundColor: colors.hover } }} onClick={onSnooze}>
                  <Icon name="clock" size={12} color={colors.textFaint} />
                </div>
                {snoozeOpen && <SnoozeMenu onSchedule={onSchedule} onClose={onSnooze} />}
              </div>
              <div testId="sidebar-settle" tabIndex={0} style={{ height: 20, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 3, paddingRight: 0, cursor: 'pointer', backgroundColor: colors.transparent }} onMouseEnter={() => setSettleHovered(true)} onMouseLeave={() => setSettleHovered(false)} onClick={onSettle}>
                <Icon name="check" size={11} color={settleHovered ? colors.text : colors.textFaint} />
                <text testId="sidebar-settle-label" style={{ color: settleHovered ? colors.text : colors.textFaint, fontSize: 9 }}>Settle</text>
              </div>
            </>
          ) : (
            <>
              <text style={{ color: running ? colors.info : colors.textFaint, fontSize: 9 }}>{running ? 'Working' : relativeTime(session.modifiedAt)}</text>
              <text style={{ color: '#E9705A', fontSize: 10, fontWeight: 700 }}>π</text>
            </>
          )}
        </div>
      </div>
      <div testId={active ? 'sidebar-session-active' : 'sidebar-session-row'} tabIndex={disabled ? -1 : 0} style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, cursor: disabled ? 'default' : 'pointer' }} {...(disabled ? {} : { onClick })}>
        <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 12, fontWeight: active ? 600 : 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{session.title}</text>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name="gitBranch" size={11} color={colors.textFaint} />
          <text style={{ color: colors.textFaint, fontSize: 9 }}>{branch}</text>
        </div>
      </div>
    </div>
    </SessionRowInset>
  )
}

function SnoozeMenu({ onSchedule, onClose }: { onSchedule(until: number): void; onClose(): void }) {
  const now = Date.now()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const nextWeek = new Date(now)
  nextWeek.setDate(nextWeek.getDate() + ((8 - nextWeek.getDay()) % 7 || 7))
  nextWeek.setHours(9, 0, 0, 0)
  const options = [
    { label: 'In 1 hour', value: now + 60 * 60 * 1_000 },
    { label: 'In 3 hours', value: now + 3 * 60 * 60 * 1_000 },
    { label: 'Tomorrow', value: tomorrow.getTime() },
    { label: 'Next week', value: nextWeek.getTime() },
  ]
  return (
    <anchored side="bottom" align="end" gap={5} fit="snap" snapMargin={8} deferred priority={8} occlude>
      <div testId="snooze-menu" tabIndex={0} onMouseDownOutside={onClose} style={{ width: 204, display: 'flex', flexDirection: 'column', padding: 5, borderRadius: 9, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover }}>
        {options.map((option, index) => (
          <React.Fragment key={option.label}>
            <div testId={`snooze-option-${index}`} tabIndex={0} style={{ height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={() => onSchedule(option.value)}>
              <text style={{ color: colors.textMuted, fontSize: 11 }}>{option.label}</text>
              <div style={{ flexGrow: 1 }} />
              <text style={{ color: colors.textFaint, fontSize: 9 }}>{new Date(option.value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</text>
            </div>
          </React.Fragment>
        ))}
      </div>
    </anchored>
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

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
