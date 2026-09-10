import { hasNativeTrafficLights } from './window-chrome.ts'
import React, { useCallback, useEffect, useState } from 'react'
import type { TerminalSessionService } from '../terminal/service.ts'
import { IconButton } from './primitives.tsx'
import { colors } from './theme.ts'
import { TERMINAL_DOCK_HEADER, TERMINAL_DOCK_RESIZE } from './terminal-metrics.ts'
import { TerminalToolbar } from './terminal-chrome.tsx'
import { TerminalView } from './terminal-view.tsx'
import type { ResolvedTheme } from './theme.ts'
import { useTerminalServiceSnapshot } from './terminal-context.tsx'
import { LAYOUT_MOTION_TRANSITION, MotionDiv } from './motion.ts'

export function TerminalDock({
  service,
  open,
  fullscreen,
  fullscreenProgress,
  height,
  width,
  appearance,
  onResizeStart,
  onToggleFullscreen,
  onClose,
}: {
  service: TerminalSessionService
  open: boolean
  fullscreen: boolean
  fullscreenProgress: number
  height: number
  width: number
  appearance: ResolvedTheme
  onResizeStart(y: number): void
  onToggleFullscreen(): void
  onClose(): void
}) {
  const snapshot = useTerminalServiceSnapshot(service)
  const activeId = snapshot.activeBottomId ?? snapshot.sessions[0]?.id
  const [focusSerial, setFocusSerial] = useState(1)
  const requestFocus = useCallback((id = activeId) => {
    if (id) service.claimSize(id, 'bottom')
    setFocusSerial((value) => value + 1)
  }, [activeId, service])

  useEffect(() => {
    if (!open) return
    void service.ensureSession('bottom')
  }, [open, service])

  const onNew = useCallback(() => {
    void service.spawn().then((id) => {
      service.select('bottom', id)
      requestFocus(id)
    })
  }, [requestFocus, service])

  const viewHeight = Math.max(1, height - TERMINAL_DOCK_HEADER)
  const trafficLightInset = hasNativeTrafficLights() ? 96 * fullscreenProgress : 0

  return (
    <MotionDiv initial={{ height: 0 }} animate={{ height }} transition={LAYOUT_MOTION_TRANSITION} testId="terminal-dock" style={{ height, flexShrink: 0, display: 'flex', flexDirection: 'column', borderTopWidth: fullscreenProgress > 0.5 ? 0 : 1, borderColor: colors.border, backgroundColor: colors.panel, overflow: 'hidden' }}>
      <div
        testId="terminal-dock-resize"
        style={{ height: TERMINAL_DOCK_RESIZE, flexShrink: 0, marginTop: -4, cursor: fullscreen ? 'default' : 'ns-resize', backgroundColor: colors.transparent }}
        onMouseDown={(event) => {
          if (fullscreen) return
          onResizeStart(event.y ?? 0)
        }}
      />
      <MotionDiv initial={false} animate={{ paddingLeft: 8 + trafficLightInset }} transition={LAYOUT_MOTION_TRANSITION} testId="terminal-dock-header" style={{ height: TERMINAL_DOCK_HEADER, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 8 + trafficLightInset, paddingRight: 8, gap: 4 }}>
        <TerminalToolbar
          service={service}
          sessions={snapshot.sessions}
          activeId={activeId}
          onSelect={(id) => {
            service.select('bottom', id)
            requestFocus(id)
          }}
          onNew={onNew}
        />
        <IconButton icon={fullscreen ? 'minimize' : 'maximize'} label={fullscreen ? 'Restore terminal panel' : 'Fullscreen terminal panel'} testId={fullscreen ? 'terminal-dock-restore' : 'terminal-dock-fullscreen'} tabIndex={-1} onClick={() => { requestFocus(); onToggleFullscreen() }} />
        <IconButton icon="x" label="Close terminal panel" testId="close-terminal-dock" tabIndex={-1} onClick={onClose} />
      </MotionDiv>
      <div style={{ height: viewHeight, minHeight: 0, flexGrow: 1 }}>
        <TerminalView service={service} sessionId={activeId} placement="bottom" width={width} height={viewHeight} appearance={appearance} focusSerial={focusSerial} />
      </div>
    </MotionDiv>
  )
}
