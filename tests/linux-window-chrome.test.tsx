import React from 'react'
import { describe, expect, it } from 'bun:test'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { connectTest } from '@gpuix/react/automation'
import { LinuxResizeHandles, LinuxWindowChrome } from '../src/ui/linux-window-chrome.tsx'
import type { NativeWindowState } from '../src/ui/window-controls.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const state: NativeWindowState = { decorations: 'client', maximized: false, fullscreen: false, resizable: true, canMinimize: true, canMaximize: true }

describeNative('Linux titlebar presentation', () => {
  it('keeps resize targets clear of every titlebar control', async () => {
    const root = createTestRoot({ width: 360, height: 200 })
    root.render(<div style={{ position: 'relative', width: '100%', height: '100%' }}><LinuxWindowChrome renderer={{ minimizeWindow() {}, toggleMaximizeWindow() {} }} state={state} title="Heddlework" onQuit={() => {}} reducedMotion /><LinuxResizeHandles state={state} /></div>)
    const automation = await connectTest(root.renderer)
    try {
      root.renderer.flush()
      for (const control of ['window-minimize', 'window-maximize', 'window-close']) {
        const button = await automation.getByTestId(control).bounds()
        for (const edge of ['top', 'topRight', 'right']) {
          const resize = await automation.getByTestId(`window-resize-${edge}`).bounds()
          const overlaps = button.x < resize.x + resize.width && button.x + button.width > resize.x
            && button.y < resize.y + resize.height && button.y + button.height > resize.y
          expect(overlaps).toBe(false)
        }
      }
    } finally { await automation.close(); root.unmount() }
  })
  it('removes resize targets when the compositor maximizes the window', () => {
    const root = createTestRoot({ width: 360, height: 200 })
    try {
      root.render(<div style={{ position: 'relative', width: '100%', height: '100%' }}><LinuxResizeHandles state={state} /></div>)
      root.renderer.flush()
      expect(root.renderer.findByTestId('window-resize-bottomRight')).toBeDefined()
      root.render(<div style={{ position: 'relative', width: '100%', height: '100%' }}><LinuxResizeHandles state={{ ...state, maximized: true }} /></div>)
      root.renderer.flush()
      expect(root.renderer.findByTestId('window-resize-bottomRight')).toBeUndefined()
    } finally { root.unmount() }
  })
  it('keeps three controls separate from the native drag region and dispatches actions', async () => {
    const calls: string[] = []
    const renderer = { minimizeWindow: () => { calls.push('minimize') }, toggleMaximizeWindow: () => { calls.push('maximize') } }
    const root = createTestRoot({ width: 360, height: 80 })
    root.render(<LinuxWindowChrome renderer={renderer} state={state} title="Heddlework" onQuit={() => { calls.push('quit') }} reducedMotion />)
    const automation = await connectTest(root.renderer)
    try {
      root.renderer.flush()
      const drag = await automation.getByTestId('linux-window-drag-region').bounds()
      const minimize = await automation.getByTestId('window-minimize').bounds()
      const maximize = await automation.getByTestId('window-maximize').bounds()
      const close = await automation.getByTestId('window-close').bounds()
      expect(drag.x + drag.width).toBeLessThanOrEqual(minimize.x)
      expect(minimize.x + minimize.width).toBeLessThanOrEqual(maximize.x)
      expect(maximize.x + maximize.width).toBeLessThanOrEqual(close.x)
      expect(close.x + close.width).toBeLessThanOrEqual(360)
      for (const id of ['window-minimize', 'window-maximize', 'window-close']) await automation.getByTestId(id).click()
      expect(calls).toEqual(['minimize', 'maximize', 'quit'])
      root.renderer.focusElement(root.renderer.findByTestId('window-maximize')!.id)
      root.renderer.nativeSimulateKeyDown(root.renderer.findByTestId('window-maximize')!.id, 'enter', true)
      root.renderer.flush()
      expect(calls).toHaveLength(3)
      root.renderer.nativeSimulateKeyDown(root.renderer.findByTestId('window-maximize')!.id, 'enter', false)
      root.renderer.flush()
      expect(calls.at(-1)).toBe('maximize')
    } finally {
      await automation.close()
      root.unmount()
    }
  })
})
