import { pickWorkspaceDirectory } from './open-external.ts'
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useGpuixRequired, useWindowInsets, useWindowSize } from '@gpuix/react'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { FlowRuntime } from '../flows/runtime.ts'
import { ChatHeader } from './chat-header.tsx'
import { Composer } from './composer.tsx'
import { ConversationExtensionOverlay } from './conversation-overlay.tsx'
import { copyTextToClipboard } from './clipboard-media.ts'
import { DraftWorkspaceChooser } from './workspace-chooser.tsx'
import { FlowsView } from './flows-view.tsx'
import { NotificationLedgerView } from './notifications.tsx'
import { SettingsView } from './settings-view.tsx'
import { WorkbenchSidebar } from './sidebar.tsx'
import { SurfacePickerPanel } from './surface-picker.tsx'
import { Transcript } from './transcript.tsx'
import type { WorkbenchUiRegistry } from './extensions.ts'
import type { ToolPresenter } from './tool-presenters.ts'
import { Button } from './primitives.tsx'
import { Icon } from './icons.tsx'
import { colors } from './theme.ts'
import { defaultThemeManager, type ThemeManager } from './theme-manager.ts'
import { LAYOUT_MOTION_TRANSITION, MotionDiv, SPRING_SETTLE_MS } from './motion.ts'
import { ResponsiveLayoutProvider, resolveResponsiveLayout } from './responsive.tsx'
import { TerminalProjectionSuspensionProvider, TerminalServiceProvider } from './terminal-context.tsx'
import { TerminalDock } from './terminal-dock.tsx'
import { TERMINAL_DOCK_DEFAULT_HEIGHT, TERMINAL_DOCK_MIN_HEIGHT } from './terminal-metrics.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import type { BrowserSessionService } from '../browser/service.ts'
import { BrowserServiceProvider } from './browser-context.tsx'
import { BrowserNativeHost } from './browser-host.tsx'

type Surface = 'chat' | 'flows' | 'settings'
type RightPanel = 'notifications' | 'surfaces' | `surface:${string}`

function surfacePanelId(surfaceId: string): `surface:${string}` {
  return `surface:${surfaceId}`
}

function workbenchSurfaceId(panel: RightPanel | undefined): string | undefined {
  return panel?.startsWith('surface:') ? panel.slice('surface:'.length) : undefined
}

export function WorkbenchApp({
  controller,
  presenters,
  ui,
  flows,
  terminals,
  browsers,
  themeManager = defaultThemeManager,
  pickDirectory = pickWorkspaceDirectory,
  onQuit,
}: {
  controller: WorkbenchController
  presenters: ReadonlyMap<string, ToolPresenter>
  ui: WorkbenchUiRegistry
  flows?: FlowRuntime | undefined
  terminals?: TerminalSessionService
  browsers?: BrowserSessionService
  themeManager?: ThemeManager
  pickDirectory?: typeof pickWorkspaceDirectory
  onQuit?(): void
}) {
  const state = useSyncExternalStore(controller.subscribeShell, controller.getShellSnapshot)
  const theme = useSyncExternalStore(themeManager.subscribe, themeManager.getSnapshot)
  const uiSnapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot)
  const renderer = useGpuixRequired()
  const windowSize = useWindowSize({ intervalMs: 50 })
  const windowInsets = useWindowInsets({ intervalMs: 50 })
  const safeWidth = Math.max(1, windowSize.width - windowInsets.effective.left - windowInsets.effective.right)
  const layout = resolveResponsiveLayout(safeWidth)
  const [surface, setSurface] = useState<Surface>('chat')
  const [composerPickerOpen, setComposerPickerOpen] = useState(false)
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(!layout.navigationOverlay)
  const [leftSidebarMounted, setLeftSidebarMounted] = useState(!layout.navigationOverlay)
  const previousNavigationOverlay = useRef(layout.navigationOverlay)
  const [bottomTerminalOpen, setBottomTerminalOpen] = useState(false)
  const [bottomTerminalMounted, setBottomTerminalMounted] = useState(false)
  const [bottomTerminalHeight, setBottomTerminalHeight] = useState(TERMINAL_DOCK_DEFAULT_HEIGHT)
  const [bottomTerminalFullscreen, setBottomTerminalFullscreen] = useState(false)
  const [bottomResizeDrag, setBottomResizeDrag] = useState<{ startY: number; startHeight: number } | undefined>()
  const [rightPanel, setRightPanel] = useState<RightPanel | undefined>()
  const [displayedRightPanel, setDisplayedRightPanel] = useState<RightPanel | undefined>()
  const [panelFullscreen, setPanelFullscreen] = useState(false)
  const [panelFullscreenRendered, setPanelFullscreenRendered] = useState(false)
  const forcedPanelFullscreen = layout.panelOverlay && Boolean(rightPanel)
  const diffOpen = rightPanel === surfacePanelId('diff')
  const notificationsOpen = rightPanel === 'notifications'
  const [lastSeenNoticeId, setLastSeenNoticeId] = useState(0)
  const latestNoticeId = state.notices.at(-1)?.id ?? 0
  const unreadCount = state.notices.filter((notice) => notice.id > lastSeenNoticeId).length
  const draft = state.messages.length === 0 && !state.liveAssistant && !state.session.isStreaming
  const setLeftSidebarVisibility = useCallback((open: boolean) => {
    if (!open) setLeftSidebarMounted(true)
    setLeftSidebarOpen(open)
  }, [])
  const closeFlows = useCallback(() => setSurface('chat'), [])
  const openFlowSession = useCallback(() => {
    setSurface('chat')
    setRightPanel(undefined)
    setPanelFullscreen(false)
    if (layout.navigationOverlay) setLeftSidebarVisibility(false)
  }, [layout.navigationOverlay, setLeftSidebarVisibility])

  useEffect(() => {
    renderer.setWindowTitle?.(state.windowTitle)
  }, [renderer, state.windowTitle])

  useEffect(() => {
    if (previousNavigationOverlay.current === layout.navigationOverlay) return
    previousNavigationOverlay.current = layout.navigationOverlay
    setLeftSidebarOpen(!layout.navigationOverlay)
    setLeftSidebarMounted(!layout.navigationOverlay)
  }, [layout.navigationOverlay])

  useEffect(() => {
    if (leftSidebarOpen) return
    const timer = setTimeout(() => setLeftSidebarMounted(false), SPRING_SETTLE_MS + 32)
    return () => clearTimeout(timer)
  }, [leftSidebarOpen])

  useEffect(() => {
    if (bottomTerminalOpen) return
    const timer = setTimeout(() => setBottomTerminalMounted(false), SPRING_SETTLE_MS + 32)
    return () => clearTimeout(timer)
  }, [bottomTerminalOpen])

  useEffect(() => {
    if (notificationsOpen) setLastSeenNoticeId(latestNoticeId)
  }, [latestNoticeId, notificationsOpen])

  useEffect(() => {
    if (rightPanel) {
      setDisplayedRightPanel(rightPanel)
      return
    }
    setPanelFullscreen(false)
    const timer = setTimeout(() => setDisplayedRightPanel(undefined), SPRING_SETTLE_MS + 32)
    return () => clearTimeout(timer)
  }, [rightPanel])

  useEffect(() => {
    if (forcedPanelFullscreen) {
      setPanelFullscreenRendered(true)
      return
    }
    if (panelFullscreen) return
    const timer = setTimeout(() => setPanelFullscreenRendered(false), SPRING_SETTLE_MS + 32)
    return () => clearTimeout(timer)
  }, [forcedPanelFullscreen, panelFullscreen])

  const closeOverlayNavigation = () => {
    if (layout.navigationOverlay) setLeftSidebarVisibility(false)
  }

  const closeRightPanel = () => {
    setRightPanel(undefined)
    setPanelFullscreen(false)
  }

  const closeBottomTerminal = () => {
    setBottomTerminalMounted(true)
    setBottomTerminalOpen(false)
    setBottomTerminalFullscreen(false)
  }

  const toggleBottomTerminal = () => {
    if (bottomTerminalOpen) {
      closeBottomTerminal()
      return
    }
    setBottomTerminalOpen(true)
  }

  useEffect(() => {
    const request = state.uiRequest
    if (!request || request.kind === 'model' || request.kind === 'thinking') return
    controller.completeUiRequest(request.id)
    if (request.kind === 'settings') {
      closeRightPanel()
      if (layout.navigationOverlay) setLeftSidebarVisibility(false)
      setSurface('settings')
      return
    }
    if (request.kind === 'sessions') {
      closeRightPanel()
      setSurface('chat')
      setLeftSidebarVisibility(true)
      return
    }
    if (request.kind === 'copy') {
      void copyTextToClipboard(request.text).then((copied) => {
        controller.notify(copied ? 'info' : 'warning', copied ? 'Copied last assistant message to clipboard' : 'No system clipboard command is available')
      })
      return
    }
    if (onQuit) onQuit()
    else controller.notify('warning', 'Close the window to quit Heddlework')
  }, [controller, layout.navigationOverlay, onQuit, state.uiRequest])

  useEffect(() => {
    const surfaceId = workbenchSurfaceId(rightPanel)
    if (surfaceId && !uiSnapshot.surfaces.some((candidate) => candidate.id === surfaceId)) closeRightPanel()
  }, [rightPanel, uiSnapshot.surfaces])

  const returnToConversation = () => {
    setSurface('chat')
    closeRightPanel()
    closeOverlayNavigation()
  }

  const toggleNotifications = () => {
    setSurface('chat')
    setPanelFullscreen(false)
    closeOverlayNavigation()
    if (notificationsOpen) {
      setRightPanel(undefined)
      return
    }
    setLastSeenNoticeId(latestNoticeId)
    setDisplayedRightPanel('notifications')
    setRightPanel('notifications')
  }

  const openWorkbenchSurface = (surfaceId: string, preserveFullscreen = false) => {
    const contribution = uiSnapshot.surfaces.find((candidate) => candidate.id === surfaceId)
    if (!contribution) return
    contribution.onOpen?.()
    setSurface('chat')
    closeOverlayNavigation()
    if (!preserveFullscreen) setPanelFullscreen(false)
    const panelId = surfacePanelId(surfaceId)
    setDisplayedRightPanel(panelId)
    setRightPanel(panelId)
  }

  const openDiff = (preserveFullscreen = false) => openWorkbenchSurface('diff', preserveFullscreen)

  const toggleDiff = () => {
    if (diffOpen) closeRightPanel()
    else openDiff()
  }

  const openSurfacePicker = () => {
    setSurface('chat')
    closeOverlayNavigation()
    setDisplayedRightPanel('surfaces')
    setRightPanel('surfaces')
  }

  const selectSurface = (surfaceId: string) => openWorkbenchSurface(surfaceId, true)
  const togglePanelFullscreen = () => {
    if (layout.panelOverlay) return
    if (!panelFullscreen) setPanelFullscreenRendered(true)
    setPanelFullscreen(!panelFullscreen)
  }

  const chatHidden = surface !== 'chat'
  const rightPanelOpen = Boolean(rightPanel)
  const bottomFullscreenVisible = bottomTerminalFullscreen && bottomTerminalOpen && !chatHidden
  const panelFullscreenTarget = forcedPanelFullscreen || panelFullscreen
  const panelFullscreenVisible = panelFullscreenTarget || panelFullscreenRendered
  const fullscreenVisible = panelFullscreenVisible || bottomFullscreenVisible
  const animatedSidebarProgress = leftSidebarOpen && !panelFullscreenTarget && !bottomFullscreenVisible ? 1 : 0
  const mainWidth = safeWidth - (layout.navigationOverlay ? 0 : layout.sidebarWidth * animatedSidebarProgress)
  const standardPanelWidth = Math.min(mainWidth, Math.max(420, Math.floor(mainWidth * 0.44)))
  const panelWidth = layout.panelOverlay ? safeWidth : displayedRightPanel === 'notifications' ? Math.min(422, mainWidth) : standardPanelWidth
  const safeHeight = Math.max(1, windowSize.height - windowInsets.effective.top - windowInsets.effective.bottom)
  const restDockHeight = Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.min(Math.floor(safeHeight * 0.7), bottomTerminalHeight))
  const dockHeight = !bottomTerminalOpen || panelFullscreenTarget ? 0 : bottomFullscreenVisible ? safeHeight : restDockHeight
  const showBottomDock = Boolean(terminals) && (bottomTerminalOpen || bottomTerminalMounted)
  const panelFullscreenProgress = panelFullscreenTarget ? 1 : 0
  const sidebarToggleLeft = process.platform === 'darwin' ? 90 : layout.navigationOverlay ? 10 : 10 + 54 * animatedSidebarProgress
  const collapsedChromeInset = process.platform === 'darwin' ? 132 : 54
  const contentSidebarProgress = layout.navigationOverlay ? 0 : animatedSidebarProgress
  const flowsTitlebarInset = 24 + (collapsedChromeInset - 24) * (1 - contentSidebarProgress)
  const settingsTitlebarInset = 18 + (collapsedChromeInset - 18) * (1 - contentSidebarProgress)
  const conversationFlexGrow = panelFullscreenTarget ? 0 : 1
  const conversationBodyFlexGrow = bottomFullscreenVisible ? 0.001 : 1
  const chatHeaderHeight = bottomFullscreenVisible ? 0 : 52
  const rightPanelHostWidth = rightPanelOpen && !panelFullscreenTarget && !bottomFullscreenVisible ? panelWidth : 0
  const rightPanelHostFlexGrow = rightPanelOpen && panelFullscreenTarget && !bottomFullscreenVisible ? 1 : 0
  const bottomFullscreenProgress = bottomFullscreenVisible ? 1 : 0
  const dockWidth = Math.max(1, safeWidth
    - (layout.navigationOverlay ? 0 : layout.sidebarWidth * animatedSidebarProgress)
    - (rightPanelOpen && !layout.panelOverlay && !panelFullscreenTarget && !bottomFullscreenVisible ? panelWidth : 0))
  const displayedSurfaceId = workbenchSurfaceId(displayedRightPanel)
  const rightTerminalSuspended = bottomTerminalFullscreen && displayedSurfaceId === 'terminal'
  const displayedSurface = uiSnapshot.surfaces.find((candidate) => candidate.id === displayedSurfaceId)
  const SurfaceComponent = displayedSurface?.component
  const panel = displayedRightPanel === 'notifications'
    ? <NotificationLedgerView state={state} fullscreen={panelFullscreenVisible} fullscreenProgress={panelFullscreenProgress} panelWidth={panelWidth} onClear={() => controller.clearNotices()} onClose={closeRightPanel} />
    : displayedRightPanel === 'surfaces'
      ? <SurfacePickerPanel surfaces={uiSnapshot.surfaces} fullscreen={panelFullscreenVisible} fullscreenProgress={panelFullscreenProgress} fullscreenLocked={layout.panelOverlay} panelWidth={panelWidth} onToggleFullscreen={togglePanelFullscreen} onSelect={selectSurface} onClose={closeRightPanel} />
      : SurfaceComponent
        ? <SurfaceComponent fullscreen={panelFullscreenVisible} fullscreenProgress={panelFullscreenProgress} fullscreenLocked={layout.panelOverlay} panelWidth={panelWidth} appearance={theme.resolved} onToggleFullscreen={togglePanelFullscreen} onNewSurface={openSurfacePicker} onClose={closeRightPanel} />
        : null

  const sidebarHost = (
    <MotionDiv
      initial={layout.navigationOverlay ? { width: 0 } : false}
      animate={{ width: layout.sidebarWidth * animatedSidebarProgress }}
      transition={LAYOUT_MOTION_TRANSITION}
      testId="left-sidebar-host"
      style={layout.navigationOverlay
        ? { position: 'absolute', top: 0, bottom: 0, left: 0, width: layout.sidebarWidth * animatedSidebarProgress, height: '100%', flexShrink: 0, overflow: 'hidden' }
        : { position: 'relative', width: layout.sidebarWidth * animatedSidebarProgress, height: '100%', flexShrink: 0, overflow: 'hidden' }}
    >
      <div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: layout.sidebarWidth }}>
        <WorkbenchSidebar
          pickDirectory={pickDirectory}
          width={layout.sidebarWidth}
          state={state}
          controller={controller}
          flowsAvailable={Boolean(flows)}
          flowsActive={surface === 'flows'}
          settingsActive={surface === 'settings'}
          notificationsActive={notificationsOpen}
          unreadCount={unreadCount}
          appearance={theme.resolved}
          onSelectSession={returnToConversation}
          onFlows={() => {
            if (!flows) return
            closeRightPanel()
            closeOverlayNavigation()
            setSurface((current) => current === 'flows' ? 'chat' : 'flows')
          }}
          onSettings={() => {
            closeRightPanel()
            closeOverlayNavigation()
            setSurface((current) => current === 'settings' ? 'chat' : 'settings')
          }}
          onNotifications={toggleNotifications}
        />
      </div>
    </MotionDiv>
  )

  return (
    <TerminalServiceProvider service={terminals}>
    <BrowserServiceProvider service={browsers}>
    <ResponsiveLayoutProvider layout={layout}>
      <div testId="workbench-root" style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: colors.background, color: colors.text, overflow: 'hidden' }}>
        <div
          testId="workbench-safe-area"
          style={{ position: 'absolute', top: windowInsets.effective.top, right: windowInsets.effective.right, bottom: windowInsets.effective.bottom, left: windowInsets.effective.left, display: 'flex', flexDirection: 'row', backgroundColor: colors.background, overflow: 'hidden' }}
        >
          {!layout.navigationOverlay && sidebarHost}
          <div testId="workbench-content-host" style={{ position: 'relative', display: 'flex', flexDirection: 'row', flexGrow: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
          <div testId="workbench-main" style={chatHidden
            ? { position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none', opacity: 0 }
            : { position: 'relative', display: 'flex', flexDirection: 'row', flexGrow: 1, minWidth: 0, height: '100%', backgroundColor: colors.background, overflow: 'hidden' }}>
              <MotionDiv initial={false} animate={{ flexGrow: conversationFlexGrow }} transition={LAYOUT_MOTION_TRANSITION} style={{ display: 'flex', flexDirection: 'column', width: 0, flexGrow: conversationFlexGrow, minWidth: 0, height: '100%', overflow: 'hidden' }}>
                <MotionDiv initial={false} animate={{ height: chatHeaderHeight }} transition={LAYOUT_MOTION_TRANSITION} style={{ height: chatHeaderHeight, flexShrink: 0, overflow: 'hidden' }}>
                  <ChatHeader state={state} controller={controller} diffOpen={diffOpen} terminalOpen={bottomTerminalOpen} leftSidebarProgress={layout.navigationOverlay ? 0 : animatedSidebarProgress} onToggleDiff={toggleDiff} {...(terminals ? { onToggleTerminal: toggleBottomTerminal } : {})} />
                </MotionDiv>
                <MotionDiv initial={false} animate={{ flexGrow: conversationBodyFlexGrow }} transition={LAYOUT_MOTION_TRANSITION} testId="conversation-body" style={{ position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: conversationBodyFlexGrow, minHeight: 0, overflow: 'hidden' }}>
                  {draft ? (
                    <DraftWorkspaceChooser pickDirectory={pickDirectory} state={state} controller={controller} />
                  ) : (
                    <>
                      <Transcript state={state} presenters={presenters} appearance={theme.resolved} interactionDisabled={composerPickerOpen || chatHidden} suspended={chatHidden} onOpenDiff={() => openDiff()} onRevert={(entryId) => void controller.navigateTree(entryId)} onDismissNotice={(id) => controller.dismissNotice(id)} onLoadEarlier={controller.loadEarlierMessages} />
                      <TranscriptFade />
                      <Composer state={state} controller={controller} onPickerOpenChange={setComposerPickerOpen} />
                    </>
                  )}
                  <ConversationExtensionOverlay state={state} controller={controller} />
                </MotionDiv>
                {showBottomDock && terminals && (
                  <TerminalProjectionSuspensionProvider suspended={chatHidden}>
                  <TerminalDock
                    service={terminals}
                    open={bottomTerminalOpen}
                    fullscreen={bottomTerminalFullscreen}
                    fullscreenProgress={bottomFullscreenProgress}
                    height={dockHeight}
                    width={dockWidth}
                    appearance={theme.resolved}
                    onResizeStart={(y) => setBottomResizeDrag({ startY: y, startHeight: restDockHeight })}
                    onToggleFullscreen={() => setBottomTerminalFullscreen((value) => !value)}
                    onClose={closeBottomTerminal}
                  />
                  </TerminalProjectionSuspensionProvider>
                )}
              </MotionDiv>
              {panel && (
                <MotionDiv
                  initial={{ width: 0, flexGrow: 0 }}
                  animate={{
                    width: layout.panelOverlay ? (rightPanelOpen ? safeWidth : 0) : rightPanelHostWidth,
                    flexGrow: layout.panelOverlay ? 0 : rightPanelHostFlexGrow,
                  }}
                  transition={LAYOUT_MOTION_TRANSITION}
                  testId="right-panel-host"
                  style={layout.panelOverlay
                    ? { position: 'absolute', top: 0, right: 0, bottom: 0, width: rightPanelOpen ? safeWidth : 0, minWidth: 0, height: '100%', flexShrink: 0, overflow: 'hidden' }
                    : { position: 'relative', width: rightPanelHostWidth, flexGrow: rightPanelHostFlexGrow, minWidth: 0, height: '100%', flexShrink: 0, overflow: 'hidden' }}
                >
                  <div style={layout.panelOverlay
                    ? { position: 'absolute', top: 0, right: 0, bottom: 0, width: safeWidth }
                    : { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
                  >
                    <TerminalProjectionSuspensionProvider suspended={rightTerminalSuspended || chatHidden}>
                      {panel}
                    </TerminalProjectionSuspensionProvider>
                  </div>
                </MotionDiv>
              )}
            </div>
          {surface === 'flows' && flows ? (
            <FlowsView state={state} controller={controller} runtime={flows} presenters={presenters} titlebarInset={flowsTitlebarInset} onClose={closeFlows} onOpenSession={openFlowSession} />
          ) : surface === 'settings' ? (
            <SettingsView state={state} controller={controller} theme={theme} titlebarInset={settingsTitlebarInset} onThemeModeChange={(mode) => themeManager.setMode(mode)} terminals={terminals} browsers={browsers} onClose={() => setSurface('chat')} />
          ) : null}
          </div>
          {layout.navigationOverlay && !panel && (leftSidebarOpen || leftSidebarMounted) && (
            <>
              <MotionDiv
                testId="navigation-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: Math.min(0.72, animatedSidebarProgress * 0.72) }}
                transition={{ duration: 0.14, ease: 'easeOut' }}
                style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#00000099', pointerEvents: leftSidebarOpen ? 'auto' : 'none' }}
                onClick={() => setLeftSidebarVisibility(false)}
              />
              {sidebarHost}
            </>
          )}
          {bottomResizeDrag && (
            <div
              testId="terminal-dock-drag-overlay"
              style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, cursor: 'ns-resize' }}
              onMouseMove={(event) => {
                const delta = bottomResizeDrag.startY - (event.y ?? 0)
                setBottomTerminalHeight(Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.min(Math.floor(safeHeight * 0.75), bottomResizeDrag.startHeight + delta)))
              }}
              onMouseUp={() => setBottomResizeDrag(undefined)}
            />
          )}
          {browsers && <BrowserNativeHost service={browsers} suspended={Boolean(bottomResizeDrag)} />}
          {state.pendingNavigation && (
            <div testId="session-switch-confirm" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#00000088', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto' }}>
              <div style={{ width: 420, maxWidth: '92%', padding: 18, borderRadius: 12, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <text style={{ color: colors.text, fontSize: 15, fontWeight: 600 }}>Stop the current run and open this thread?</text>
                <text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18 }}>This window currently runs one Pi session at a time. Switching interrupts the current run.</text>
                <div style={{ display: 'flex', flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                  <Button label="Stay here" tone="quiet" onClick={() => controller.cancelPendingNavigation()} />
                  <Button label="Stop and switch" tone="primary" onClick={() => void controller.confirmPendingNavigation()} />
                </div>
              </div>
            </div>
          )}
          {!fullscreenVisible && (
            <MotionDiv
              initial={false}
              animate={{ left: sidebarToggleLeft }}
              transition={LAYOUT_MOTION_TRANSITION}
              testId="toggle-left-sidebar"
              tabIndex={0}
              style={{ position: 'absolute', top: 12, left: sidebarToggleLeft, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.hover } }}
              onClick={() => setLeftSidebarVisibility(!leftSidebarOpen)}
            >
              <div style={{ width: 15, height: 15, pointerEvents: 'none' }}><Icon name={leftSidebarOpen ? 'panelLeftClose' : 'panelLeft'} size={15} color={colors.textMuted} /></div>
            </MotionDiv>
          )}
        </div>
      </div>
    </ResponsiveLayoutProvider>
    </BrowserServiceProvider>
    </TerminalServiceProvider>
  )
}

function TranscriptFade() {
  const layers = ['08', '18', '2C', '45', '65', '88', 'AC', 'CE', 'E8', 'F8']
  return (
    <div testId="transcript-bottom-fade" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 240, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
      {layers.map((alpha) => (
        <React.Fragment key={alpha}>
          <div style={{ height: 24, flexShrink: 0, backgroundColor: `${colors.background}${alpha}`, pointerEvents: 'none' }} />
        </React.Fragment>
      ))}
    </div>
  )
}
