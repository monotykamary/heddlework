import { hasNativeTrafficLights } from './window-chrome.ts'
import React from 'react'
import { basename } from 'node:path'
import { Select, SelectContent, SelectItem, SelectTrigger, type SelectItemState, type SelectTriggerState } from '@gpuix/react'
import type { WorkbenchController } from '../workbench/controller.ts'
import { contentText, type WorkbenchState } from '../workbench/state.ts'
import { DropdownSurface, useDropdownState } from './dropdown.tsx'
import { Button, IconButton } from './primitives.tsx'
import { Icon } from './icons.tsx'
import { openPath } from './open-external.ts'
import { colors, nativeTheme } from './theme.ts'
import { LAYOUT_MOTION_TRANSITION, MotionDiv } from './motion.ts'
import { useResponsiveLayout } from './responsive.tsx'

export function ChatHeader({
  state,
  controller,
  diffOpen,
  terminalOpen = false,
  leftSidebarProgress,
  onToggleDiff,
  onToggleTerminal,
}: {
  state: WorkbenchState
  controller: WorkbenchController
  diffOpen: boolean
  terminalOpen?: boolean
  leftSidebarProgress: number
  onToggleDiff(): void
  onToggleTerminal?(): void
}) {
  const projectName = basename(state.workspacePath) || state.workspacePath
  const title = activeThreadTitle(state)
  const layout = useResponsiveLayout()
  const collapsedLeftInset = hasNativeTrafficLights() ? 132 : 54
  return (
    <MotionDiv
      initial={false}
      animate={{ paddingLeft: 20 + (collapsedLeftInset - 20) * (1 - leftSidebarProgress) }}
      transition={LAYOUT_MOTION_TRANSITION}
      style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: layout.mobile ? 5 : 10, paddingLeft: 20 + (collapsedLeftInset - 20) * (1 - leftSidebarProgress), paddingRight: layout.mobile ? 8 : 12, backgroundColor: colors.background, userSelect: 'none' }}
    >
      <div testId="chat-breadcrumb" style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
        {!layout.mobile && (
          <>
            <Icon name="folder" size={14} color={colors.textFaint} />
            <text testId="chat-project-crumb" style={{ color: colors.textMuted, fontSize: 12, fontWeight: 500, maxWidth: 160, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{projectName}</text>
            <text style={{ color: colors.textFaint, fontSize: 12 }}>/</text>
          </>
        )}
        <text testId="chat-thread-title" style={{ width: 0, flexGrow: 1, color: colors.text, fontSize: 12, fontWeight: 600, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{title}</text>
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: layout.mobile ? 3 : 7, flexShrink: 0 }}>
        <ActionMenu state={state} controller={controller} compact={layout.compact || diffOpen} />
        {!layout.mobile && (layout.compact || diffOpen ? (
          <>
            <IconButton testId="header-open" icon="box" label="Open" onClick={() => openPath(state.workspacePath)} />
            <IconButton testId="header-export" icon="download" label="Export" disabled={state.messages.length === 0} onClick={() => void controller.exportSession()} />
          </>
        ) : (
          <>
            <Button testId="header-open" label="Open" icon="box" compact onClick={() => openPath(state.workspacePath)} />
            <Button testId="header-export" label="Export" compact disabled={state.messages.length === 0} onClick={() => void controller.exportSession()} />
          </>
        ))}
        {onToggleTerminal && <IconButton icon="panelBottom" label="Toggle terminal panel" testId="toggle-terminal" active={terminalOpen} onClick={onToggleTerminal} />}
        <IconButton icon="panel" label="Toggle Diff panel" testId="toggle-diff" active={diffOpen} onClick={onToggleDiff} />
      </div>
    </MotionDiv>
  )
}

function ActionMenu({ state, controller, compact }: { state: WorkbenchState; controller: WorkbenchController; compact: boolean }) {
  const dropdown = useDropdownState()
  const options = [
    { value: 'new', label: 'New thread', detail: 'Start a clean Pi session' },
    { value: 'open', label: 'Open project', detail: 'Open this workspace externally' },
    { value: 'clone', label: 'Clone thread', detail: 'Duplicate the current Pi branch' },
    { value: 'compact', label: 'Compact context', detail: 'Reduce the current context window' },
    { value: 'refresh', label: 'Refresh sessions', detail: 'Rescan every saved Pi session' },
    { value: 'export', label: 'Export transcript', detail: 'Write this thread as HTML' },
  ]
  return (
    <Select
      value=""
      open={dropdown.mounted}
      onOpenChange={dropdown.setOpen}
      onValueChange={(value) => {
        if (value === 'new') void controller.newSession()
        if (value === 'open') openPath(state.workspacePath)
        if (value === 'clone') void controller.cloneSession()
        if (value === 'compact') void controller.compact()
        if (value === 'refresh') void controller.refreshSessions()
        if (value === 'export') void controller.exportSession()
      }}
    >
      <SelectTrigger
        testId="add-action"
        style={(_trigger: SelectTriggerState) => ({ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, width: compact ? 30 : 'auto', height: 28, paddingLeft: compact ? 0 : 9, paddingRight: compact ? 0 : 9, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: dropdown.open ? colors.hover : colors.raised, cursor: 'pointer', hover: { backgroundColor: colors.hover } })}
      >
        <Icon name="plus" size={13} color={colors.text} />
        {!compact && <text style={{ color: colors.text, fontSize: 11, fontWeight: 550 }}>Add action</text>}
      </SelectTrigger>
      <SelectContent testId="add-action-content" side="bottom" sideOffset={7} align="end" style={{ width: 254, padding: 0, borderWidth: 0, borderRadius: 0, backgroundColor: colors.background, overflow: 'visible', pointerEvents: dropdown.open ? 'auto' : 'none' }}>
        <DropdownSurface testId="add-action-menu" open={dropdown.open} style={{ width: '100%', padding: 5 }}>
          {options.map((option) => {
            const alwaysEnabled = option.value === 'refresh' || option.value === 'open'
            const disabled = alwaysEnabled ? false : state.session.isStreaming || (option.value !== 'new' && state.messages.length === 0)
            return (
              <SelectItem
                key={option.value}
                value={option.value}
                textValue={option.label}
                disabled={disabled}
                style={(item: SelectItemState) => ({ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 7, paddingBottom: 7, paddingLeft: 9, paddingRight: 9, borderRadius: 7, opacity: disabled ? 0.4 : 1, backgroundColor: item.highlighted ? colors.hover : colors.popover, cursor: disabled ? 'default' : 'pointer' })}
              >
                <text style={{ color: colors.text, fontSize: 11, lineHeight: 16, fontWeight: 600, fontFamily: nativeTheme.fontMono }}>{option.label}</text>
                <text style={{ color: colors.textFaint, fontSize: 10, lineHeight: 15, fontFamily: nativeTheme.fontMono }}>{option.detail}</text>
              </SelectItem>
            )
          })}
        </DropdownSurface>
      </SelectContent>
    </Select>
  )
}

export function activeThreadTitle(state: WorkbenchState): string {
  if (state.session.sessionName) return state.session.sessionName
  const current = state.sessions.find((session) => session.path === state.session.sessionFile)
  if (current) return current.title
  const firstUser = state.messages.find((message) => message.role === 'user')
  const text = firstUser ? contentText(firstUser.content).trim() : ''
  if (!text) return 'New thread'
  return text.length > 68 ? `${text.slice(0, 65)}…` : text
}
