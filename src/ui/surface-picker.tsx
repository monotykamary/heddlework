import React from 'react'
import { Icon, type IconName } from './icons.tsx'
import { colors } from './theme.ts'
import { RightPanelHeader, rightPanelStyle } from './right-panel-header.tsx'
import { useResponsiveLayout } from './responsive.tsx'
import { NativeVirtualList, useNativeVirtualWindow } from './virtual-list.tsx'

export interface SurfaceDescriptor {
  id: string
  title: string
  description: string
  icon: IconName
}

export function SurfacePickerPanel({ surfaces, fullscreen, fullscreenProgress, fullscreenLocked = false, panelWidth, onToggleFullscreen, onSelect, onClose }: { surfaces: readonly SurfaceDescriptor[]; fullscreen: boolean; fullscreenProgress?: number | undefined; fullscreenLocked?: boolean; panelWidth?: number; onToggleFullscreen(): void; onSelect(surfaceId: string): void; onClose(): void }) {
  const { mobile } = useResponsiveLayout()
  const columns = mobile ? 1 : 2
  const rows = Array.from({ length: Math.ceil(surfaces.length / columns) }, (_, index) => surfaces.slice(index * columns, index * columns + columns))
  const virtualWindow = useNativeVirtualWindow(rows.length, `surface-picker:${columns}:${surfaces.length}:${surfaces[0]?.id ?? ''}:${surfaces.at(-1)?.id ?? ''}`)
  const visibleRows = rows.slice(virtualWindow.windowStart, virtualWindow.windowEnd)
  return (
    <PanelFrame testId="surface-picker" title="New surface" icon="plus" fullscreen={fullscreen} fullscreenProgress={fullscreenProgress} fullscreenLocked={fullscreenLocked} {...(panelWidth === undefined ? {} : { panelWidth })} onToggleFullscreen={onToggleFullscreen} onClose={onClose}>
      <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 22, overflow: 'hidden' }}>
        <text style={{ color: colors.text, fontSize: 14, fontWeight: 550 }}>Open a surface</text>
        <text style={{ color: colors.textFaint, fontSize: 10, marginTop: 7 }}>Choose what to show in the right panel.</text>
        <div style={{ width: '100%', maxWidth: 430, flexGrow: 1, minHeight: 0, display: 'flex', marginTop: 24 }}>
          <NativeVirtualList testId="surface-picker-list" alignment="top" estimatedItemHeight={101} overdraw={202} itemCount={Math.max(1, rows.length)} windowStart={virtualWindow.windowStart} onVisibleRange={virtualWindow.onVisibleRange} style={{ width: '100%', flexGrow: 1, minHeight: 0 }}>
            {rows.length === 0
              ? <text key="empty" style={{ color: colors.textFaint, fontSize: 10 }}>No surfaces are registered.</text>
              : visibleRows.map((row, visibleIndex) => (
                <div key={`surface-row-${virtualWindow.windowStart + visibleIndex}`} style={{ width: '100%', minHeight: 101, flexShrink: 0, display: 'flex', flexDirection: 'row', gap: 9, paddingBottom: 9 }}>
                  {row.map((surface) => <div key={surface.id} style={{ width: 0, minWidth: 0, flexBasis: 0, flexGrow: 1, display: 'flex' }}><SurfaceCard surface={surface} onClick={() => onSelect(surface.id)} /></div>)}
                  {row.length < columns && <div style={{ width: 0, minWidth: 0, flexBasis: 0, flexGrow: columns - row.length }} />}
                </div>
              ))}
          </NativeVirtualList>
        </div>
      </div>
    </PanelFrame>
  )
}

export function SurfacePlaceholderPanel({ descriptor, fullscreen, fullscreenProgress, fullscreenLocked = false, panelWidth, onToggleFullscreen, onNew, onClose }: { descriptor: SurfaceDescriptor; fullscreen: boolean; fullscreenProgress?: number | undefined; fullscreenLocked?: boolean; panelWidth?: number; onToggleFullscreen(): void; onNew(): void; onClose(): void }) {
  return (
    <div testId="surface-placeholder" style={rightPanelStyle(fullscreen, panelWidth)}>
      <RightPanelHeader icon={descriptor.icon} title={descriptor.title} fullscreen={fullscreen} fullscreenProgress={fullscreenProgress} fullscreenLocked={fullscreenLocked} onNew={onNew} onToggleFullscreen={onToggleFullscreen} onClose={onClose} />
      <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 30 }}>
        <Icon name={descriptor.icon} size={22} color={colors.textFaint} />
        <text style={{ color: colors.textMuted, fontSize: 12 }}>{`${descriptor.title} surface`}</text>
        <text style={{ color: colors.textFaint, fontSize: 10, lineHeight: 16, textAlign: 'center' }}>The native surface host is ready. Runtime integration can arrive with the feature plugin.</text>
      </div>
    </div>
  )
}

function PanelFrame({ testId, title, icon, fullscreen, fullscreenProgress, fullscreenLocked, panelWidth, onToggleFullscreen, onClose, children }: { testId: string; title: string; icon: IconName; fullscreen: boolean; fullscreenProgress?: number | undefined; fullscreenLocked?: boolean; panelWidth?: number; onToggleFullscreen(): void; onClose(): void; children: React.ReactNode }) {
  return (
    <div testId={testId} style={rightPanelStyle(fullscreen, panelWidth)}>
      <RightPanelHeader icon={icon} title={title} fullscreen={fullscreen} fullscreenProgress={fullscreenProgress} {...(fullscreenLocked === undefined ? {} : { fullscreenLocked })} onToggleFullscreen={onToggleFullscreen} onClose={onClose} />
      {children}
    </div>
  )
}

function SurfaceCard({ surface, onClick }: { surface: SurfaceDescriptor; onClick(): void }) {
  return (
    <div testId={`surface-option-${surface.id}`} tabIndex={0} style={{ width: '100%', minWidth: 0, minHeight: 92, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: 13, borderRadius: 9, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter') onClick() }}>
      <Icon name={surface.icon} size={17} color={colors.text} />
      <text style={{ color: colors.text, fontSize: 12, fontWeight: 550 }}>{surface.title}</text>
      <text style={{ minHeight: 28, color: colors.textFaint, fontSize: 9, lineHeight: 14 }}>{surface.description}</text>
    </div>
  )
}
