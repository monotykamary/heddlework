import React, { useEffect, useState } from 'react'
import { createRenderer, createRoot, flushSync, startFrameLoop } from '@gpuix/react'
import { sameWindowState, type NativeWindowState } from '../src/ui/window-controls.ts'

const decorations = process.env.HEDDLEWORK_SMOKE_DECORATIONS
if (process.platform !== 'linux') throw new Error(`Linux smoke app cannot run on ${process.platform}`)
if (decorations !== 'client' && decorations !== 'server') {
  throw new Error('HEDDLEWORK_SMOKE_DECORATIONS must be client or server')
}

const title = process.env.HEDDLEWORK_SMOKE_TITLE ?? 'Heddlework Linux Window Smoke'
const appId = process.env.HEDDLEWORK_SMOKE_APP_ID ?? 'io.github.monotykamary.heddlework.smoke'

type WindowRenderer = ReturnType<typeof createRenderer> & {
  getWindowState(): NativeWindowState
  minimizeWindow(): void
  toggleMaximizeWindow(): void
  closeWindow(): void
}

const renderer = createRenderer() as WindowRenderer
for (const method of ['getWindowState', 'minimizeWindow', 'toggleMaximizeWindow', 'closeWindow'] as const) {
  if (typeof renderer[method] !== 'function') throw new Error(`Missing native window API: ${method}`)
}

renderer.init({
  title,
  appId,
  windowDecorations: decorations,
  width: 900,
  height: 620,
  resizable: true,
  fullscreen: process.env.HEDDLEWORK_SMOKE_START_FULLSCREEN === '1',
  focus: true,
  show: true,
} as Parameters<typeof renderer.init>[0])

const dragRegionProps = { testId: 'window-drag-region', windowDragRegion: true }
const resizeEdges = ['top', 'topRight', 'right', 'bottomRight', 'bottom', 'bottomLeft', 'left', 'topLeft'] as const
type ResizeEdge = (typeof resizeEdges)[number]

function resizeStyle(edge: ResizeEdge): Record<string, unknown> {
  const style: Record<string, unknown> = { position: 'absolute' }
  if (edge === 'right' || edge === 'left') Object.assign(style, { top: 8, bottom: 8, width: 8, [edge]: 0 })
  else if (edge === 'top' || edge === 'bottom') Object.assign(style, { left: 8, right: 8, height: 8, [edge]: 0 })
  else {
    Object.assign(style, { width: 8, height: 8 })
    style[edge.startsWith('top') ? 'top' : 'bottom'] = 0
    style[edge.endsWith('Right') ? 'right' : 'left'] = 0
  }
  return style
}

let statePollingEnabled = true

function readState(): NativeWindowState | undefined {
  try {
    return renderer.getWindowState() as NativeWindowState
  } catch {
    return undefined
  }
}

function requestClose(): void {
  statePollingEnabled = false
  setTimeout(() => renderer.closeWindow(), 100)
}

function SmokeWindow() {
  const [state, setState] = useState<NativeWindowState | undefined>(readState)

  useEffect(() => {
    const timer = setInterval(() => setState((current) => {
      if (!statePollingEnabled) return current
      const next = readState()
      return sameWindowState(current, next) ? current : next
    }), 25)
    return () => clearInterval(timer)
  }, [])

  const action = (invoke: () => void) => () => {
    invoke()
    setState(readState())
  }
  const maximizeEnabled = Boolean(state && (state.fullscreen || (state.canMaximize && state.resizable)))

  return (
    <div style={{ width: '100%', height: '100%', backgroundColor: '#111827', position: 'relative' }}>
      <div
        {...dragRegionProps}
        style={{ height: 48, backgroundColor: decorations === 'client' ? '#1f2937' : '#374151', padding: 12 }}
      >
        <text style={{ color: '#f9fafb', fontSize: 16 }}>Heddlework compositor smoke</text>
      </div>
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div testId="smoke-state">
          <text style={{ color: '#d1d5db' }}>{state ? JSON.stringify(state) : 'pending'}</text>
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', gap: 12 }}>
          <div testId="action-minimize" onClick={action(() => renderer.minimizeWindow())} style={{ padding: 12, backgroundColor: '#334155' }}>
            <text style={{ color: '#f8fafc' }}>Minimize</text>
          </div>
          <div
            testId="action-maximize"
            {...(maximizeEnabled ? { onClick: action(() => renderer.toggleMaximizeWindow()) } : {})}
            style={{ padding: 12, backgroundColor: '#334155' }}
          >
            <text style={{ color: '#f8fafc' }}>Toggle maximize</text>
          </div>
          <div testId="maximize-enabled">
            <text>{String(maximizeEnabled)}</text>
          </div>
          <div testId="action-close" onClick={requestClose} style={{ padding: 12, backgroundColor: '#7f1d1d' }}>
            <text style={{ color: '#fef2f2' }}>Close</text>
          </div>
        </div>
      </div>
      {resizeEdges.map((edge) => (
        // Spread form: windowResizeEdge is a host-only prop the react element
        // types do not declare (same pattern as dragRegionProps above).
        <div key={edge} testId={`window-resize-${edge}`} {...{ windowResizeEdge: edge }} style={resizeStyle(edge) as never} />
      ))}
    </div>
  )
}

const root = createRoot(renderer)
flushSync(() => root.render(<SmokeWindow />))
const loop = startFrameLoop(renderer, {
  onTerminated: () => {
    console.error('HEDDLEWORK_SMOKE_TERMINATED')
    process.exit(0)
  },
})

const safetyTimer = setTimeout(() => {
  console.error('HEDDLEWORK_SMOKE_TIMEOUT')
  process.exit(124)
}, 105_000)

process.on('SIGUSR1', requestClose)

process.once('SIGTERM', () => {
  clearTimeout(safetyTimer)
  loop.stop()
  try { root.unmount() } catch { /* The compositor may already have destroyed the surface. */ }
  try { renderer.shutdown() } catch { /* Preserve the signal exit path. */ }
  process.exit(143)
})

console.error(`HEDDLEWORK_SMOKE_READY ${JSON.stringify({ title, appId, decorations })}`)
