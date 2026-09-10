import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { SurfacePickerPanel, type SurfaceDescriptor } from '../src/ui/surface-picker.tsx'
import { ResponsiveLayoutProvider, resolveResponsiveLayout } from '../src/ui/responsive.tsx'

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const surfaces: SurfaceDescriptor[] = ['Browser', 'Terminal', 'Files', 'Diff', 'Agents'].map((title) => ({
  id: title.toLowerCase(), title, icon: 'globe', description: title === 'Agents' ? 'Watch subagents and workflows run.' : 'Open this workspace surface.',
}))

describeNative('surface picker columns', () => {
  for (const width of [390, 420, 800]) {
    it(`aligns the final card at ${width}px`, async () => {
      const root = createTestRoot({ width, height: 800 })
      // A narrow right panel can still belong to a desktop window.
      const layout = resolveResponsiveLayout(width === 390 ? 390 : 1280)
      root.render(<ResponsiveLayoutProvider layout={layout}><SurfacePickerPanel surfaces={surfaces} fullscreen panelWidth={width} onToggleFullscreen={() => {}} onSelect={() => {}} onClose={() => {}} /></ResponsiveLayoutProvider>)
      const automation = await connectTest(root.renderer)
      try {
        root.renderer.flush()
        const first = await automation.getByTestId('surface-option-browser').bounds()
        const last = await automation.getByTestId('surface-option-agents').bounds()
        const second = await automation.getByTestId('surface-option-terminal').bounds()
        expect(last.x).toBeCloseTo(first.x, 0)
        expect(last.width).toBeCloseTo(first.width, 0)
        expect(last.height).toBeCloseTo(first.height, 0)
        expect(first.width).toBeGreaterThan(100)
        if (layout.mobile) expect(second.x).toBe(first.x)
        else {
          expect(second.y).toBe(first.y)
          expect(second.width).toBeCloseTo(first.width, 0)
          expect(second.x).toBeGreaterThan(first.x + first.width)
        }
      } finally {
        await automation.close()
        root.unmount()
      }
    })
  }
})
