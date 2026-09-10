import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useGpuix } from '@gpuix/react'
import type { ComposerImage, PiModel, PiSessionStats, SlashCommand, ThinkingLevel } from '../pi/types.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { questionnaireFromTool } from '../workbench/ask-user.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { Button, ChipSelect, type SelectOption } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'
import { editorTextAfterImagePaste, readClipboardImage } from './clipboard-media.ts'
import { DROPDOWN_MOTION_MS, DropdownSurface } from './dropdown.tsx'
import { useResponsiveLayout } from './responsive.tsx'
import { QueueDock } from './queue-dock.tsx'
import { LAYOUT_MOTION_TRANSITION, MotionDiv } from './motion.ts'
import { CommandPalette, ExtensionSurfaceRail, QuestionnaireWaitingDock } from './composer-surfaces.tsx'

export { extensionSurfaceRailReserveHeight, questionnaireWaitingDockReserveHeight } from './composer-surfaces.tsx'

export const QUEUE_HINT_DURATION_MS = 1_700
const PRIMARY_ACTION_SIZE = 34

export function Composer({ state, controller, draft = false, onPickerOpenChange }: { state: WorkbenchState; controller: WorkbenchController; draft?: boolean; onPickerOpenChange?(open: boolean): void }) {
  const layout = useResponsiveLayout()
  const [pastingImage, setPastingImage] = useState(false)
  const [contextPopoverMounted, setContextPopoverMounted] = useState(false)
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false)
  const [queueHintVisible, setQueueHintVisible] = useState(false)
  const contextPopoverExitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queueHintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const gpuix = useGpuix()
  const composerId = useRef<number | undefined>(undefined)
  const setComposerNode = useCallback((instance: { id: number } | null) => {
    composerId.current = instance?.id
  }, [])
  const queuedByKeyDown = useRef(false)
  const hintShownOnce = useRef(false)
  const commandPickedByKeyDown = useRef(false)
  const suppressComposerChange = useRef(false)
  const editor = useSyncExternalStore(controller.subscribeEditor, controller.getEditorSnapshot)
  const commandQuery = composerCommandQuery(editor.editorText)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const matchingCommands = useMemo(() => (
    slashDismissed || commandQuery === undefined ? [] : matchCommands(state.commands, commandQuery).slice(0, 8)
  ), [commandQuery, slashDismissed, state.commands])
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const collapsedQuestionnaire = useMemo(() => state.questionnaireCollapsed === undefined
    ? undefined
    : state.liveTools
      .map(questionnaireFromTool)
      .find((questionnaire) => questionnaire?.toolCallId === state.questionnaireCollapsed), [state.liveTools, state.questionnaireCollapsed])
  useEffect(() => setActiveCommandIndex(0), [commandQuery])
  useEffect(() => {
    if (slashDismissed) setSlashDismissed(false)
  }, [slashDismissed, editor.editorText])
  useEffect(() => {
    const request = state.uiRequest
    if (request?.kind === 'model' || request?.kind === 'thinking') controller.completeUiRequest(request.id)
  }, [controller, state.uiRequest])
  useEffect(() => () => {
    if (contextPopoverExitTimer.current) clearTimeout(contextPopoverExitTimer.current)
    if (queueHintTimer.current) clearTimeout(queueHintTimer.current)
  }, [])
  const showContextPopover = () => {
    if (contextPopoverExitTimer.current) clearTimeout(contextPopoverExitTimer.current)
    contextPopoverExitTimer.current = undefined
    setContextPopoverMounted(true)
    setContextPopoverOpen(true)
  }
  const hideContextPopover = () => {
    setContextPopoverOpen(false)
    if (contextPopoverExitTimer.current) clearTimeout(contextPopoverExitTimer.current)
    contextPopoverExitTimer.current = setTimeout(() => {
      contextPopoverExitTimer.current = undefined
      setContextPopoverMounted(false)
    }, DROPDOWN_MOTION_MS)
  }
  const toggleContextPopover = () => {
    if (contextPopoverOpen) hideContextPopover()
    else showContextPopover()
  }
  const connected = state.connection === 'connected'
  const modelOptions: SelectOption[] = state.models.map((model) => ({
    value: modelKey(model),
    label: model.name ?? model.id,
    detail: `${model.provider}/${model.id}`,
  }))
  const thinkingOptions: SelectOption[] = state.thinkingLevels.map((level) => ({ value: level, label: thinkingLabel(level) }))
  const currentModel = state.session.model ? modelKey(state.session.model) : ''
  const above = Object.values(state.widgets).filter((widget) => widget.placement === 'aboveEditor')
  const below = Object.values(state.widgets).filter((widget) => widget.placement === 'belowEditor')
  const contextPercent = state.stats?.contextUsage?.percent
  const hasComposerInput = Boolean(editor.editorText.trim() || editor.editorImages.length > 0)
  const canResumeQueue = !state.session.isStreaming && state.queue.paused && state.queue.items.length > 0 && !hasComposerInput
  const queueHintOpen = queueHintVisible && connected && !state.session.isStreaming
  const primaryActionWidth = queueHintOpen ? queueHintExpandedWidth() : PRIMARY_ACTION_SIZE

  const clearQueueHint = () => {
    if (queueHintTimer.current) clearTimeout(queueHintTimer.current)
    queueHintTimer.current = undefined
    setQueueHintVisible(false)
  }

  const send = (value: string, queue = false) => {
    clearQueueHint()
    if (!value.trim() && editor.editorImages.length === 0) {
      if (!queue && state.queue.paused && state.queue.items.length > 0) controller.resumeQueue()
      return
    }
    void controller.submit(value, { queue })
  }

  const pasteClipboardImage = async (editorTextBeforePaste: string) => {
    if (pastingImage) return
    setPastingImage(true)
    try {
      const image = await readClipboardImage()
      if (!image) return
      controller.addEditorImage(image)
      const currentText = controller.getSnapshot().editorText
      const restoredText = editorTextAfterImagePaste(editorTextBeforePaste, currentText)
      if (restoredText !== currentText) controller.setEditorText(restoredText)
    } finally {
      setPastingImage(false)
    }
  }

  const showQueueHint = () => {
    if (!connected || state.session.isStreaming) return
    hintShownOnce.current = true
    if (queueHintTimer.current) clearTimeout(queueHintTimer.current)
    setQueueHintVisible(true)
    queueHintTimer.current = setTimeout(() => {
      queueHintTimer.current = undefined
      setQueueHintVisible(false)
    }, QUEUE_HINT_DURATION_MS)
  }

  const keepComposerFocus = () => {
    const id = composerId.current
    if (id !== undefined) gpuix.renderer?.focusElement?.(id)
  }
  const chooseCommand = (command: SlashCommand) => {
    suppressComposerChange.current = true
    controller.setEditorText(`/${command.name} `)
  }
  const completeActiveSlashCommand = () => {
    if (matchingCommands.length === 0 || !commandQuery) return false
    const command = matchingCommands[Math.min(activeCommandIndex, matchingCommands.length - 1)]
    if (!command) return false
    commandPickedByKeyDown.current = true
    chooseCommand(command)
    queueMicrotask(() => { commandPickedByKeyDown.current = false })
    return true
  }
  const handleComposerKeyDown = (event: { key?: string; keyChar?: string; modifiers?: { alt?: boolean; cmd?: boolean; ctrl?: boolean } }) => {
    const key = event.key?.toLowerCase()
    const tab = key === 'tab' || event.keyChar === '\t'
    if (key === 'escape' && commandQuery !== undefined) {
      setSlashDismissed(true)
      return
    }
    if (matchingCommands.length > 0 && commandQuery !== undefined) {
      if (key === 'down' || key === 'arrowdown') {
        setActiveCommandIndex((index) => (index + 1) % matchingCommands.length)
        return
      }
      if (key === 'up' || key === 'arrowup') {
        setActiveCommandIndex((index) => (index - 1 + matchingCommands.length) % matchingCommands.length)
        return
      }
      const command = matchingCommands[Math.min(activeCommandIndex, matchingCommands.length - 1)]
      if (command && (tab || ((key === 'enter' || key === 'return') && commandQuery !== command.name))) {
        completeActiveSlashCommand()
        if (tab) keepComposerFocus()
        queueMicrotask(() => { if (tab) keepComposerFocus() })
        return
      }
    }
    if (tab && matchingCommands.length > 0) {
      completeActiveSlashCommand()
      keepComposerFocus()
    }
    if (key === 'v' && (event.modifiers?.cmd || event.modifiers?.ctrl)) void pasteClipboardImage(editor.editorText)
    if (key === 'enter' && event.modifiers?.alt) {
      queuedByKeyDown.current = true
      send(editor.editorText, true)
      queueMicrotask(() => { queuedByKeyDown.current = false })
    }
  }

  return (
    <div
      style={{
        position: draft ? 'relative' : 'absolute',
        ...(draft ? {} : { left: 0, right: 0, bottom: 0 }),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
        paddingLeft: layout.composerGutter,
        paddingRight: layout.composerGutter,
        paddingBottom: draft ? 0 : 10,
        gap: 0,
        overflow: 'visible',
        pointerEvents: 'none',
      }}
    >
      {collapsedQuestionnaire && <QuestionnaireWaitingDock questionnaire={collapsedQuestionnaire} controller={controller} />}
      {matchingCommands.length > 0 && <CommandPalette commands={matchingCommands} activeIndex={Math.min(activeCommandIndex, matchingCommands.length - 1)} onChoose={chooseCommand} />}
      <ExtensionSurfaceRail above={above} below={below} statuses={state.statusItems} />
      <QueueDock state={state} controller={controller} />

      <div style={{ position: 'relative', width: '100%', maxWidth: 768, paddingBottom: 32, overflow: 'visible' }}>
        <ComposerContextBar branch={state.workspaceDiff.branch || 'workspace'} />
        <div
          testId="composer-surface"
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            pointerEvents: 'auto',
            borderRadius: 22,
            borderWidth: 1,
            borderColor: state.session.isStreaming ? '#343D60' : colors.composerFrame,
            backgroundColor: colors.composer,
            paddingTop: 14,
            paddingBottom: 12,
            overflow: 'visible',
          }}
        >
        <div style={{ position: 'absolute', left: 1, right: 1, top: 1, bottom: 1, borderWidth: 1, borderColor: colors.composerHighlight, borderRadius: 21, pointerEvents: 'none' }} />
        {editor.editorImages.length > 0 && <ComposerImages images={editor.editorImages} onRemove={(id) => controller.removeEditorImage(id)} />}
        {pastingImage && <text style={{ color: colors.textFaint, fontSize: 10, paddingLeft: 16, paddingBottom: 6 }}>Reading image from clipboard…</text>}
        <textarea
          ref={setComposerNode}
          testId="composer"
          tabIndex={0}
          value={editor.editorText}
          placeholder={connected ? (draft ? (layout.mobile ? 'Ask anything, @tag files, or / for commands' : 'Ask anything, @tag files/folders, $use skills, or / for commands') : 'Ask for follow-up changes or attach images') : 'Reconnect to Pi to begin'}
          minRows={3}
          maxRows={7}
          autoFocus
          readOnly={!connected}
          theme={nativeTheme}
          style={{
            width: '100%',
            minWidth: 0,
            paddingLeft: layout.mobile ? 13 : 16,
            paddingRight: layout.mobile ? 13 : 16,
            color: colors.text,
            fontSize: 14,
            lineHeight: 21,
            borderWidth: 0,
            backgroundColor: colors.transparent,
          }}
          onChange={(event) => {
            if (suppressComposerChange.current) {
              suppressComposerChange.current = false
              return
            }
            controller.setEditorText(String(event.value ?? ''))
          }}
          onFocus={showQueueHint}
          onClick={() => { if (!hintShownOnce.current) showQueueHint() }}
          onKeyDown={handleComposerKeyDown}
          onSubmit={(event) => {
            if (commandPickedByKeyDown.current) {
              commandPickedByKeyDown.current = false
              return
            }
            if (queuedByKeyDown.current) {
              queuedByKeyDown.current = false
              return
            }
            send(String(event.value ?? editor.editorText), Boolean(event.modifiers?.alt))
          }}
        />
        {matchingCommands.length > 0 && commandQuery ? (
          <div
            testId="slash-tab-catcher"
            tabIndex={0}
            style={{ width: 0, height: 0, overflow: 'hidden', pointerEvents: 'auto' }}
            onFocus={() => {
              completeActiveSlashCommand()
              keepComposerFocus()
            }}
          />
        ) : null}

        <div testId="composer-toolbar" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: layout.mobile ? 2 : 4, marginTop: 10, paddingLeft: layout.mobile ? 8 : 10, paddingRight: layout.mobile ? 8 : 11, overflow: 'visible', userSelect: 'none' }}>
          <ChipSelect
            backdropColor={colors.composer}
            tabIndex={matchingCommands.length > 0 ? -1 : 0}
            testId="model-picker"
            icon="sparkles"
            value={currentModel}
            options={modelOptions}
            width={layout.mobile ? layout.popoverWidth : 320}
            triggerMaxWidth={layout.mobile ? 106 : 320}
            searchable
            {...(state.uiRequest?.kind === 'model' ? { openRequest: state.uiRequest.id } : {})}
            {...(onPickerOpenChange ? { onOpenChange: onPickerOpenChange } : {})}
            onChange={(value) => {
              const model = state.models.find((candidate) => modelKey(candidate) === value)
              if (model) void controller.setModel(model)
            }}
          />
          {!layout.mobile && <ToolbarSeparator />}
          <ChipSelect
            backdropColor={colors.composer}
            tabIndex={matchingCommands.length > 0 ? -1 : 0}
            testId="thinking-picker"
            value={state.session.thinkingLevel}
            options={thinkingOptions}
            width={layout.mobile ? Math.min(180, layout.popoverWidth) : 130}
            triggerMaxWidth={layout.mobile ? 68 : 130}
            {...(state.uiRequest?.kind === 'thinking' ? { openRequest: state.uiRequest.id } : {})}
            {...(onPickerOpenChange ? { onOpenChange: onPickerOpenChange } : {})}
            onChange={(value) => void controller.setThinkingLevel(value as ThinkingLevel)}
          />
          <div style={{ flexGrow: 1 }} />
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: layout.mobile ? 4 : 9 }}>
            {typeof contextPercent === 'number' && state.stats && <ContextMeter stats={state.stats} compact={layout.mobile} popoverOpen={contextPopoverOpen} tabIndex={matchingCommands.length > 0 ? -1 : 0} onToggle={toggleContextPopover} onMouseEnter={showContextPopover} onMouseLeave={hideContextPopover} />}
            <PrimaryAction
              running={state.session.isStreaming}
              disabled={!connected || (!state.session.isStreaming && !hasComposerInput && !canResumeQueue)}
              tabIndex={matchingCommands.length > 0 ? -1 : 0}
              queueHintVisible={queueHintOpen}
              width={primaryActionWidth}
              onSend={() => send(editor.editorText)}
              onStop={() => void controller.abort()}
            />
          </div>
        </div>
        <div testId="composer-seam-mask" style={{ position: 'absolute', left: 22, right: 22, bottom: 0, height: 2, backgroundColor: colors.composer, pointerEvents: 'none' }} />
      </div>
      {contextPopoverMounted && state.stats && (
        <MotionDiv initial={false} animate={{ right: layout.mobile ? 0 : 46 + primaryActionWidth - PRIMARY_ACTION_SIZE }} transition={LAYOUT_MOTION_TRANSITION} testId="context-popover-positioner" style={{ position: 'absolute', right: layout.mobile ? 0 : 46 + primaryActionWidth - PRIMARY_ACTION_SIZE, bottom: 84, width: layout.mobile ? layout.popoverWidth : 256, display: 'flex', backgroundColor: colors.transparent }}>
          <ContextPopover stats={state.stats} open={contextPopoverOpen} width={layout.mobile ? layout.popoverWidth : 256} />
        </MotionDiv>
      )}
      </div>

    </div>
  )
}

function ToolbarSeparator() {
  return <div style={{ width: 1, height: 16, backgroundColor: colors.borderStrong, marginLeft: 1, marginRight: 1 }} />
}

function ContextMeter({ stats, compact, popoverOpen, tabIndex = 0, onToggle, onMouseEnter, onMouseLeave }: { stats: PiSessionStats; compact: boolean; popoverOpen: boolean; tabIndex?: number; onToggle(): void; onMouseEnter(): void; onMouseLeave(): void }) {
  const percent = Math.max(0, Math.min(100, stats.contextUsage?.percent ?? 0))
  const tone = percent > 80 ? colors.warning : percent > 60 ? '#D8A95B' : colors.textMuted
  return (
    <div testId="context-meter" tabIndex={tabIndex} style={{ position: 'relative', height: 30, display: 'flex', flexDirection: 'row', alignItems: 'center', ...(compact ? { width: 30, justifyContent: 'center' } : {}), paddingLeft: compact ? 0 : 9, paddingRight: compact ? 0 : 2, borderRadius: 9, backgroundColor: popoverOpen ? colors.hover : colors.transparent, cursor: 'pointer' }} onClick={onToggle} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div testId="context-ring" style={{ width: compact ? 16 : 18, height: compact ? 16 : 18, borderRadius: 9, borderWidth: 2, borderColor: tone }} />
    </div>
  )
}

function ContextPopover({ stats, open, width }: { stats: PiSessionStats; open: boolean; width: number }) {
  const percent = Math.max(0, Math.min(100, stats.contextUsage?.percent ?? 0))
  const rounded = Math.round(percent * 10) / 10
  const tokens = stats.contextUsage?.tokens ?? 0
  const contextWindow = stats.contextUsage?.contextWindow ?? 0
  return (
    <DropdownSurface testId="context-popover" open={open} style={{ width, borderRadius: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
          <text style={{ color: colors.text, fontSize: 13, fontFamily: nativeTheme.fontMono }}>{`${rounded}%`}</text>
          <div style={{ flexGrow: 1 }} />
          <text style={{ color: colors.textMuted, fontSize: 11, fontFamily: nativeTheme.fontMono }}>{`${formatTokenCount(tokens)} / ${formatTokenCount(contextWindow)}`}</text>
        </div>
        <div style={{ position: 'relative', width: '100%', height: 8, borderRadius: 4, backgroundColor: colors.hover, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 226 * percent / 100, backgroundColor: percent > 80 ? colors.warning : colors.primary }} />
        </div>
      </div>
      <div style={{ height: 1, backgroundColor: colors.borderStrong }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 14 }}>
        <ContextStat label="Messages" value={String(stats.totalMessages ?? 0)} />
        <ContextStat label="Tool calls" value={String(stats.toolCalls ?? 0)} />
      </div>
      <div style={{ height: 1, backgroundColor: colors.borderStrong }} />
      <div style={{ display: 'flex', flexDirection: 'row', padding: 14, backgroundColor: colors.card }}>
        <text style={{ color: colors.textMuted, fontSize: 11 }}>Total cost</text>
        <div style={{ flexGrow: 1 }} />
        <text style={{ color: colors.text, fontSize: 12, fontFamily: nativeTheme.fontMono }}>{`$${(stats.cost ?? 0).toFixed(2)}`}</text>
      </div>
    </DropdownSurface>
  )
}

function ContextStat({ label, value }: { label: string; value: string }) {
  return <div style={{ display: 'flex', flexDirection: 'row' }}><text style={{ color: colors.textMuted, fontSize: 11 }}>{label}</text><div style={{ flexGrow: 1 }} /><text style={{ color: colors.text, fontSize: 11, fontFamily: nativeTheme.fontMono }}>{value}</text></div>
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`
  return String(value)
}

function ComposerContextShadow() {
  const alphas = nativeTheme.appearance === 'light'
    ? ['12', '10', '0E', '0C', '0A', '08', '06', '04', '02', '01']
    : ['28', '24', '20', '1C', '18', '14', '10', '0C', '08', '04']
  return (
    <div testId="composer-context-shadow" style={{ position: 'absolute', left: 0, right: 0, top: 12, height: 10, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
      {alphas.map((alpha, index) => (
        <React.Fragment key={alpha}>
          <div {...(index === 0 ? { testId: 'composer-context-shadow-strong' } : {})} style={{ height: 1, backgroundColor: `#000000${alpha}` }} />
        </React.Fragment>
      ))}
    </div>
  )
}

function ComposerContextBar({ branch }: { branch: string }) {
  const { mobile } = useResponsiveLayout()
  return (
    <div testId="composer-context-bar" style={{ position: 'absolute', left: 22, right: 22, bottom: 0, height: 48, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 20, paddingBottom: 4, paddingLeft: 13, paddingRight: 13, userSelect: 'none' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderWidth: 1, borderColor: colors.composerOutline, borderRadius: 16, backgroundColor: colors.contextBar }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 16, backgroundColor: colors.contextBar }} />
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 16, backgroundColor: colors.composerOutline }} />
      <div style={{ position: 'absolute', right: 0, top: 0, width: 1, height: 16, backgroundColor: colors.composerOutline }} />
      <ComposerContextShadow />
      <Icon name="folder" size={13} color={colors.contextIcon} />
      {!mobile && <text testId="composer-checkout-label" style={{ color: colors.contextText, fontSize: 12 }}>Local checkout</text>}
      <div style={{ flexGrow: 1 }} />
      <Icon name="gitBranch" size={12} color={colors.contextIcon} />
      <text testId="composer-branch-label" style={{ minWidth: 0, color: colors.contextText, fontSize: 12, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{branch}</text>
    </div>
  )
}

function ComposerImages({ images, onRemove }: { images: ComposerImage[]; onRemove(id: string): void }) {
  return (
    <div testId="composer-images" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8, minHeight: 64, paddingLeft: 16, paddingRight: 16, paddingBottom: 8 }}>
      {images.map((image) => (
        <React.Fragment key={image.id}>
        <div testId="composer-image-preview" style={{ position: 'relative', width: 64, height: 64, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background, overflow: 'hidden', flexShrink: 0 }}>
          {React.createElement('img', { src: image.previewPath, alt: image.fileName, objectFit: 'cover', style: { width: 64, height: 64 } } as never)}
          <div testId={`remove-composer-image-${image.id}`} tabIndex={0} style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: '#090A0ADD', cursor: 'pointer', hover: { backgroundColor: '#181919EE' } }} onClick={() => onRemove(image.id)}>
            <Icon name="x" size={12} color={colors.textMuted} />
          </div>
        </div>
        </React.Fragment>
      ))}
    </div>
  )
}

function PrimaryAction({ running, disabled, queueHintVisible, width, tabIndex, onSend, onStop }: { running: boolean; disabled: boolean; queueHintVisible: boolean; width: number; tabIndex?: number; onSend(): void; onStop(): void }) {
  const action = running ? onStop : onSend
  const background = running ? '#D72C58' : colors.primary
  return (
    <MotionDiv
      initial={false}
      animate={{ width }}
      transition={LAYOUT_MOTION_TRANSITION}
      testId={running ? 'abort' : 'send'}
      tabIndex={disabled ? -1 : tabIndex ?? 0}
      style={{
        width,
        minWidth: PRIMARY_ACTION_SIZE,
        height: PRIMARY_ACTION_SIZE,
        borderRadius: PRIMARY_ACTION_SIZE / 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background,
        opacity: disabled ? 0.32 : 1,
        overflow: 'hidden',
        flexShrink: 0,
        ...(disabled ? {} : { cursor: 'pointer', hover: { backgroundColor: running ? '#EB3567' : colors.primaryHover } }),
      }}
      {...(disabled ? {} : { onClick: action, onKeyDown: (event: { key?: string }) => { if (event.key === 'enter') action() } })}
    >
      {queueHintVisible
        ? (
          <MotionDiv initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16, ease: 'easeOut' }}>
            <text testId="composer-queue-hint" style={{ color: '#FFFFFF', fontSize: 11, fontWeight: 700, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap' }}>{queueHintLabel()}</text>
          </MotionDiv>
        )
        : <Icon name={running ? 'stop' : 'arrowUp'} size={17} color="#FFFFFF" />}
    </MotionDiv>
  )
}

function queueHintLabel(): string {
  return process.platform === 'darwin' ? '⌥↵ queue' : 'Alt+Enter queue'
}

function queueHintExpandedWidth(): number {
  return process.platform === 'darwin' ? 92 : 126
}

function composerCommandQuery(value: string): string | undefined {
  const match = /^\/([^\s]*)$/.exec(value)
  return match?.[1]?.toLowerCase()
}

function matchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const normalized = query.toLowerCase()
  return commands
    .map((command, index) => {
      const name = command.name.toLowerCase()
      const description = command.description?.toLowerCase() ?? ''
      const score = name === normalized ? 0 : name.startsWith(normalized) ? 1 : name.includes(normalized) ? 2 : description.includes(normalized) ? 3 : 4
      return { command, index, score }
    })
    .filter(({ score }) => normalized.length === 0 || score < 4)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ command }) => command)
}

function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`
}

function thinkingLabel(level: ThinkingLevel): string {
  if (level === 'off') return 'Off'
  if (level === 'xhigh') return 'Extra high'
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`
}
