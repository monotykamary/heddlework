import { hasNativeTrafficLights } from './window-chrome.ts'
import React, { useCallback, useEffect, useRef } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import { Icon, type IconName } from './icons.tsx'
import { IconButton } from './primitives.tsx'
import { colors } from './theme.ts'
import { LAYOUT_MOTION_TRANSITION, MotionDiv } from './motion.ts'

interface HeaderRenderer {
  getElementBounds?(id: number): readonly number[] | undefined
  getScrollOffset?(id: number): readonly number[] | null
  scrollTo?(id: number, x: number, y: number): void
}

export interface RightPanelHeaderTab {
  id: string
  title: string
  icon: IconName
  testId?: string
  closeTestId?: string
}

export function RightPanelHeader({
  icon,
  title,
  fullscreen,
  fullscreenProgress,
  fullscreenLocked = false,
  refreshDisabled = false,
  compact = false,
  tabs,
  activeTabId,
  newTabLabel = 'New tab',
  newTabTestId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onNew,
  onRefresh,
  onToggleFullscreen,
  onClose,
}: {
  icon: IconName
  title: string
  fullscreen: boolean
  fullscreenProgress?: number | undefined
  fullscreenLocked?: boolean
  refreshDisabled?: boolean
  compact?: boolean
  tabs?: readonly RightPanelHeaderTab[]
  activeTabId?: string
  newTabLabel?: string
  newTabTestId?: string
  onSelectTab?(id: string): void
  onCloseTab?(id: string): void
  onNewTab?(): void
  onNew?(): void
  onRefresh?(): void
  onToggleFullscreen(): void
  onClose(): void
}) {
  const titlebarProgress = fullscreenProgress ?? (fullscreen ? 1 : 0)
  const trafficLightInset = hasNativeTrafficLights() ? 96 * titlebarProgress : 0
  const renderer = useGpuixRequired() as HeaderRenderer
  const tabViewportId = useRef<number | undefined>(undefined)
  const tabScrollId = useRef<number | undefined>(undefined)
  const activeTabElementId = useRef<number | undefined>(undefined)
  const setTabViewportRef = useCallback((instance: { id: number } | null) => {
    tabViewportId.current = instance?.id
  }, [])
  const setTabScrollRef = useCallback((instance: { id: number } | null) => {
    tabScrollId.current = instance?.id
  }, [])
  const setActiveTabRef = useCallback((instance: { id: number } | null) => {
    activeTabElementId.current = instance?.id
  }, [])

  useEffect(() => {
    if (!tabs || !activeTabId) return
    const timer = setTimeout(() => {
      const viewportId = tabViewportId.current
      const scrollId = tabScrollId.current
      const tabId = activeTabElementId.current
      if (viewportId === undefined || scrollId === undefined || tabId === undefined) return
      const viewport = renderer.getElementBounds?.(viewportId)
      const active = renderer.getElementBounds?.(tabId)
      if (!viewport || viewport.length < 4 || !active || active.length < 4) return
      const listLeft = viewport[0] ?? 0
      const listRight = listLeft + (viewport[2] ?? 0)
      const activeLeft = active[0] ?? 0
      const activeRight = activeLeft + (active[2] ?? 0)
      const adjustment = activeLeft < listLeft
        ? listLeft - activeLeft
        : activeRight > listRight
          ? listRight - activeRight
          : 0
      if (adjustment === 0) return
      const offset = renderer.getScrollOffset?.(scrollId) ?? [0, 0]
      renderer.scrollTo?.(scrollId, Math.min(0, (offset[0] ?? 0) + adjustment), offset[1] ?? 0)
    }, 16)
    return () => clearTimeout(timer)
  }, [activeTabId, renderer, tabs])

  return (
    <MotionDiv initial={false} animate={{ paddingLeft: 9 + trafficLightInset }} transition={LAYOUT_MOTION_TRANSITION} testId="right-panel-header" style={{ height: compact ? 40 : 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 9 + trafficLightInset, paddingRight: 9 }}>
      {tabs ? (
        <div ref={setTabViewportRef} testId="right-panel-tabs" style={{ minWidth: 0, height: 30, flexGrow: 1, overflow: 'hidden' }}>
          <div ref={setTabScrollRef} testId="right-panel-tab-scroll" style={{ width: '100%', height: 30, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 3, overflow: 'scroll' }}>
            {tabs.map((tab) => {
            const active = tab.id === activeTabId
            return (
              <div key={tab.id} {...(active ? { ref: setActiveTabRef } : {})} {...(tab.testId ? { testId: tab.testId } : {})} style={{ width: 0, minWidth: 78, maxWidth: 180, height: 30, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 8, paddingRight: 4, borderRadius: 8, borderWidth: 1, borderColor: active ? colors.borderStrong : colors.transparent, backgroundColor: active ? colors.raised : colors.transparent }}>
                <div tabIndex={0} style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, cursor: 'pointer' }} onClick={() => onSelectTab?.(tab.id)} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onSelectTab?.(tab.id) }}>
                  <Icon name={tab.icon} size={11} color={active ? colors.textMuted : colors.textFaint} />
                  <text style={{ minWidth: 0, color: active ? colors.text : colors.textMuted, fontSize: 10, fontWeight: active ? 600 : 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{tab.title}</text>
                </div>
                {onCloseTab && (
                  <div {...(tab.closeTestId ? { testId: tab.closeTestId } : {})} tabIndex={0} style={{ width: 19, height: 19, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={() => onCloseTab(tab.id)} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onCloseTab(tab.id) }}>
                    <Icon name="x" size={10} color={colors.textFaint} />
                  </div>
                )}
              </div>
              )
            })}
            <div style={{ width: 8, height: 1, flexShrink: 0 }} />
          </div>
        </div>
      ) : (
        <div testId="right-panel-tab" style={{ height: 30, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 9, paddingRight: 9, borderRadius: 8, backgroundColor: colors.raised }}>
          <Icon name={icon} size={13} color={colors.textMuted} />
          <text style={{ color: colors.text, fontSize: 11, fontWeight: 600 }}>{title}</text>
        </div>
      )}
      {onNewTab && <IconButton icon="plus" label={newTabLabel} {...(newTabTestId ? { testId: newTabTestId } : {})} onClick={onNewTab} />}
      {!tabs && onNew && <IconButton icon="plus" label="Open a new surface" testId="right-panel-new-tab" onClick={onNew} />}
      {!tabs && <div style={{ flexGrow: 1 }} />}
      <div testId="right-panel-actions" style={{ height: 30, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2 }}>
        {tabs && onNew && <IconButton icon="panel" label="Open another sidepanel tab" testId="right-panel-new-tab" onClick={onNew} />}
        {onRefresh && <IconButton icon="refresh" label={`Refresh ${title}`} testId="right-panel-refresh" disabled={refreshDisabled} onClick={onRefresh} />}
        {!fullscreenLocked && <IconButton icon={fullscreen ? 'minimize' : 'maximize'} label={fullscreen ? `Restore ${title} panel` : `Fullscreen ${title} panel`} testId={fullscreen ? 'right-panel-restore' : 'right-panel-fullscreen'} onClick={onToggleFullscreen} />}
        <IconButton icon="x" label={`Close ${title} panel`} testId={title === 'Diff' ? 'close-diff' : 'close-surface'} onClick={onClose} />
      </div>
    </MotionDiv>
  )
}

export function rightPanelStyle(fullscreen: boolean, panelWidth?: number) {
  return {
    width: fullscreen ? '100%' : panelWidth ?? '44%',
    minWidth: fullscreen || panelWidth !== undefined ? 0 : 420,
    height: '100%',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
  }
}
