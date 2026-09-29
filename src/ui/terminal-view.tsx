import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useGpuix } from '@gpuix/react'
import type { TerminalAppearance, TerminalGridSnapshot, TerminalPlacement, TerminalRow as TerminalGridRow, TerminalSessionId } from '../terminal/types.ts'
import { encodeTerminalKey, wrapBracketedPaste, type TerminalKeyEvent } from '../terminal/keys.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import { copyTextToClipboard } from './clipboard-media.ts'
import { useTerminalGrid, useTerminalProjectionSuspended, useTerminalServiceSnapshot } from './terminal-context.tsx'
import { colors } from './theme.ts'
import { TERMINAL_CELL_WIDTH, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT, TERMINAL_PADDING_X, TERMINAL_PADDING_Y, terminalGridSize } from './terminal-metrics.ts'
import { terminalNativeBinaryFrame, terminalNativeFrame } from './terminal-native.ts'
import { terminalPaintTheme, terminalRowRuns, type TerminalPaintTheme, type TerminalRunStyle } from './terminal-theme.ts'
import type { ResolvedTheme } from './theme.ts'

type TerminalCapableRenderer = {
  supportsNativeTerminal?: () => boolean
  setTerminalFrame?: (elementId: number, metadata: string, cells: Uint8Array) => void
}

export type TerminalSurface = 'none' | 'native' | 'grid' | 'empty'
export function terminalSurface(state: { projectionSuspended: boolean; nativeTerminal: boolean; directTerminal: boolean; sessionReady: boolean; hasSnapshot: boolean }): TerminalSurface {
  if (state.projectionSuspended) return 'none'
  // Direct frames pull the grid from the service, so a session whose first frame is still in flight (remote hosts) mounts too.
  if (state.nativeTerminal && (state.hasSnapshot || (state.directTerminal && state.sessionReady))) return 'native'
  return state.hasSnapshot ? 'grid' : 'empty'
}

export const TerminalView = memo(function TerminalView({
  service,
  sessionId,
  placement,
  width,
  height,
  appearance,
  focusSerial = 1,
}: {
  service: TerminalSessionService
  sessionId: TerminalSessionId | undefined
  placement: TerminalPlacement
  width: number
  height: number
  appearance: ResolvedTheme
  focusSerial?: number
}) {
  const projectionSuspensionRequested = useTerminalProjectionSuspended()
  const projectionSuspended = placement === 'right' && projectionSuspensionRequested
  const gpuix = useGpuix()
  const renderer = gpuix?.renderer as TerminalCapableRenderer | undefined
  const nativeTerminal = renderer?.supportsNativeTerminal?.() === true
  const directTerminal = nativeTerminal && typeof renderer?.setTerminalFrame === 'function'
  const serviceSnapshot = useTerminalServiceSnapshot(service, projectionSuspended)
  const sessionReady = serviceSnapshot.sessions.some((session) => session.id === sessionId)
  const rendering = serviceSnapshot.appearance
  const snapshot = useTerminalGrid(service, sessionId, projectionSuspended || directTerminal)
  const surface = terminalSurface({ projectionSuspended, nativeTerminal, directTerminal, sessionReady, hasSnapshot: snapshot !== undefined })
  const theme = useMemo(() => terminalPaintTheme(appearance), [appearance])
  const size = terminalGridSize(width, height)
  const sizeRef = useRef(size)
  sizeRef.current = size
  const inputId = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (projectionSuspended || !sessionId || !sessionReady) return
    service.resize(sessionId, size.cols, size.rows, placement)
  }, [placement, projectionSuspended, service, sessionId, sessionReady, size.cols, size.rows])

  useEffect(() => {
    if (focusSerial < 1 || !sessionId || !sessionReady || inputId.current === undefined) return
    service.claimSize(sessionId, placement)
    service.resize(sessionId, sizeRef.current.cols, sizeRef.current.rows, placement)
    gpuix?.renderer?.focusElement?.(inputId.current)
  }, [focusSerial, gpuix, placement, service, sessionId, sessionReady])

  const focusInput = useCallback(() => {
    if (sessionId) {
      service.claimSize(sessionId, placement)
      service.resize(sessionId, size.cols, size.rows, placement)
    }
    if (inputId.current !== undefined) gpuix?.renderer?.focusElement?.(inputId.current)
  }, [gpuix, placement, service, sessionId, size.cols, size.rows])

  const onKeyDown = useCallback((event: TerminalKeyEvent) => {
    if (!sessionId) return
    const grid = service.grid(sessionId)
    if (event.eventType === 'textInput' || event.eventType === 'paste') {
      const text = event.keyChar ?? ''
      if (text) service.write(sessionId, event.eventType === 'paste' ? wrapBracketedPaste(text, Boolean(grid?.bracketedPaste)) : text)
      return
    }
    const key = (event.key ?? '').toLowerCase()
    const mods = event.modifiers as { ctrl?: boolean; control?: boolean; alt?: boolean; cmd?: boolean; shift?: boolean } | undefined
    const ctrl = Boolean(mods?.ctrl || mods?.control)
    if (ctrl && !mods?.alt && (key === 'c' || key === 'ctrl-c' || key.endsWith('-c'))) {
      service.write(sessionId, String.fromCharCode(3))
      return
    }
    if (key === 'c' && (mods?.cmd || ctrl) && mods?.shift) {
      void copyTextToClipboard(grid?.viewport.map((row) => row.text).join('\n') ?? '')
      return
    }
    if (key === 'v' && (event.modifiers?.cmd || event.modifiers?.ctrl)) {
      void pasteClipboardText().then((text) => {
        if (!text) return
        service.write(sessionId, wrapBracketedPaste(text, Boolean(grid?.bracketedPaste)))
      })
      return
    }
    const encoded = encodeTerminalKey(event, grid?.applicationCursor)
    if (!encoded) return
    service.write(sessionId, encoded)
  }, [service, sessionId])

  const onScroll = useCallback((event: { deltaY?: number }) => {
    if (!sessionId) return
    const snapshot = service.grid(sessionId)
    if (!snapshot) return
    const delta = event.deltaY ?? 0
    if (delta === 0) return
    const next = snapshot.scrollOffset + (delta > 0 ? -1 : 1) * Math.max(1, Math.round(Math.abs(delta) / TERMINAL_LINE_HEIGHT))
    service.setScrollOffset(sessionId, next)
  }, [service, sessionId])

  return (
    <div
      testId={'terminal-view-' + placement}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        paddingLeft: TERMINAL_PADDING_X,
        paddingRight: TERMINAL_PADDING_X,
        paddingTop: TERMINAL_PADDING_Y,
        paddingBottom: TERMINAL_PADDING_Y,
        backgroundColor: theme.background,
        overflow: 'hidden',
        cursor: 'text',
      }}
      onMouseDown={focusInput}
      onClick={focusInput}
      onScroll={onScroll}
    >
      {surface === 'native'
        ? <NativeTerminalGrid
            service={service}
            sessionId={sessionId!}
            snapshot={directTerminal ? undefined : snapshot}
            cols={size.cols}
            rows={size.rows}
            theme={theme}
            rendering={rendering}
          />
        : surface === 'grid' && snapshot ? <TerminalGrid snapshot={snapshot} theme={theme} rendering={rendering} />
        : surface === 'empty' ? <text style={{ color: colors.textFaint, fontSize: 11 }}>No terminal session.</text>
        : null}
      <div
        ref={(instance: { id: number } | null) => { inputId.current = instance?.id }}
        testId={'terminal-input-' + placement}
        tabIndex={projectionSuspended ? -1 : 0}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          width: '100%',
          height: '100%',
          backgroundColor: '#01010101',
          cursor: 'text',
          pointerEvents: projectionSuspended ? 'none' : 'auto',
        }}
        onMouseDown={focusInput}
        onClick={focusInput}
        onFocus={focusInput}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
      />
    </div>
  )
})

const NativeTerminalGrid = memo(function NativeTerminalGrid({
  service,
  sessionId,
  snapshot,
  cols,
  rows,
  theme,
  rendering,
}: {
  service: TerminalSessionService
  sessionId: TerminalSessionId
  snapshot: TerminalGridSnapshot | undefined
  cols: number
  rows: number
  theme: TerminalPaintTheme
  rendering: TerminalAppearance
}) {
  const gpuix = useGpuix()
  const renderer = gpuix?.renderer as TerminalCapableRenderer | undefined
  const direct = typeof renderer?.setTerminalFrame === 'function'
  const binaryCells = useRef<Uint8Array | undefined>(undefined)
  const terminalId = useRef<number | undefined>(undefined)

  const stageFrame = useCallback(() => {
    if (!direct || terminalId.current === undefined || !renderer?.setTerminalFrame) return
    const current = service.grid(sessionId)
    if (!current) return
    const frame = terminalNativeBinaryFrame(current, theme, rendering, binaryCells.current)
    binaryCells.current = frame.cells
    const { cells, ...metadata } = frame
    const payload = typeof Buffer === 'undefined'
      ? cells
      : Buffer.from(cells.buffer, cells.byteOffset, cells.byteLength)
    renderer.setTerminalFrame(terminalId.current, JSON.stringify(metadata), payload)
  }, [direct, renderer, rendering, service, sessionId, theme])

  useLayoutEffect(() => {
    if (!direct) return
    stageFrame()
    return service.subscribeFrames((changedId) => {
      if (changedId === sessionId) stageFrame()
    })
  }, [direct, service, sessionId, stageFrame])

  const fallbackFrame = useMemo(
    () => direct || !snapshot ? undefined : terminalNativeFrame(snapshot, theme, rendering),
    [direct, rendering, snapshot, theme],
  )

  return React.createElement('terminal', {
    ref: (instance: { id: number } | null) => { terminalId.current = instance?.id },
    testId: 'terminal-grid',
    ...(fallbackFrame ? { frame: fallbackFrame } : {}),
    style: {
      position: 'relative',
      width: (snapshot?.cols ?? cols) * TERMINAL_CELL_WIDTH,
      height: (snapshot?.rows ?? rows) * TERMINAL_LINE_HEIGHT,
      overflow: 'hidden',
    },
  })
})

function TerminalGrid({ snapshot, theme, rendering }: { snapshot: TerminalGridSnapshot; theme: TerminalPaintTheme; rendering: TerminalAppearance }) {
  return (
    <div testId="terminal-grid" style={{ position: 'relative', width: snapshot.cols * TERMINAL_CELL_WIDTH, height: snapshot.rows * TERMINAL_LINE_HEIGHT, display: 'flex', flexDirection: 'column' }}>
      {snapshot.viewport.map((row, rowIndex) => (
        <TerminalRow key={rowIndex} row={row} theme={theme} rendering={rendering} />
      ))}
      {snapshot.cursorVisible ? <TerminalCursor x={snapshot.cursorX} y={snapshot.cursorY} color={theme.cursor} /> : null}
    </div>
  )
}

const TerminalRow = memo(function TerminalRow({ row, theme, rendering }: { row: TerminalGridRow; theme: TerminalPaintTheme; rendering: TerminalAppearance }) {
  const runs = useMemo(() => terminalRowRuns(row.cells, theme, rendering), [rendering, row, theme])
  return (
    <div style={{ height: TERMINAL_LINE_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row' }}>
      {runs.map((run, runIndex) => <TerminalRun key={runIndex} run={run} theme={theme} />)}
    </div>
  )
})

function TerminalRun({ run, theme }: { run: TerminalRunStyle; theme: TerminalPaintTheme }) {
  const width = run.columns * TERMINAL_CELL_WIDTH
  const backgroundColor = run.fill ? run.color : run.backgroundColor === theme.background ? colors.transparent : run.backgroundColor
  const fontFamily = run.fontStyle === 'italic' ? `${run.fontFamily} Italic` : run.fontFamily
  return (
    <div style={{ position: 'relative', width, height: TERMINAL_LINE_HEIGHT, flexShrink: 0, backgroundColor }}>
      {run.fill ? null : (
        <text style={{ color: run.color, fontSize: TERMINAL_FONT_SIZE, lineHeight: TERMINAL_LINE_HEIGHT, fontFamily, ...(run.fontWeight ? { fontWeight: run.fontWeight } : {}), whiteSpace: 'nowrap' }}>{run.text}</text>
      )}
      {!run.fill && run.underline ? <div style={{ position: 'absolute', left: 0, right: 0, bottom: 1, height: 1, backgroundColor: run.color, pointerEvents: 'none' }} /> : null}
      {!run.fill && run.strike ? <div style={{ position: 'absolute', left: 0, right: 0, top: Math.floor(TERMINAL_LINE_HEIGHT * 0.52), height: 1, backgroundColor: run.color, pointerEvents: 'none' }} /> : null}
    </div>
  )
}

const TerminalCursor = memo(function TerminalCursor({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <div
      testId="terminal-cursor"
      style={{
        position: 'absolute',
        left: x * TERMINAL_CELL_WIDTH,
        top: y * TERMINAL_LINE_HEIGHT,
        width: TERMINAL_CELL_WIDTH,
        height: TERMINAL_LINE_HEIGHT,
        backgroundColor: color,
        opacity: 0.35,
        pointerEvents: 'none',
      }}
    />
  )
})

async function pasteClipboardText(): Promise<string | undefined> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) return (await navigator.clipboard.readText()) || undefined
    if (process.platform === 'darwin') {
      const proc = Bun.spawn(['/usr/bin/pbpaste'], { stdout: 'pipe' })
      return (await new Response(proc.stdout).text()) || undefined
    }
    if (process.platform === 'win32') {
      const proc = Bun.spawn(['powershell', '-NoProfile', '-Command', 'Get-Clipboard'], { stdout: 'pipe' })
      return (await new Response(proc.stdout).text()) || undefined
    }
    for (const command of [['wl-paste'], ['xclip', '-selection', 'clipboard', '-o']] as const) {
      try {
        const proc = Bun.spawn(command as unknown as string[], { stdout: 'pipe' })
        const text = await new Response(proc.stdout).text()
        if (text) return text
      } catch {
        continue
      }
    }
  } catch {
    return undefined
  }
  return undefined
}
