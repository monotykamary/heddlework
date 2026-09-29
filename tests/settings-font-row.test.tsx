import React from 'react'
import { describe, expect, it, mock } from 'bun:test'

// Mirror tests/window-metrics.test.tsx: keep the native renderer binding out
// of the module graph so this style-contract test runs anywhere, including
// hosts where @gpuix/native cannot load. The settings view's import chain only
// re-exports `GpuixRenderer` from the binding; nothing it renders at the SSR
// level touches the renderer.
mock.module('@gpuix/native', () => ({ GpuixRenderer: class GpuixRenderer {} }))

const { renderToStaticMarkup } = await import('react-dom/server')
const { ResponsiveLayoutProvider, resolveResponsiveLayout } = await import('../src/ui/responsive.tsx')
const { TerminalFontControl } = await import('../src/ui/settings-view.tsx')

function renderFontControl(viewportWidth: number): string {
  return renderToStaticMarkup(
    React.createElement(ResponsiveLayoutProvider, {
      layout: resolveResponsiveLayout(viewportWidth),
      children: React.createElement(TerminalFontControl, {
        value: 'ui-monospace',
        testId: 'terminal-font-family',
        onApply: () => {},
      }),
    }),
  )
}

function outerControlStyle(html: string): string {
  const open = html.match(/div testId="terminal-font-control" style="([^"]*)">/)
  expect(open).not.toBeNull()
  return open![1]!
}

// Match a whole declaration so `width:360px` cannot be satisfied by the
// `max-width:360px` substring, and `width:100%` cannot be satisfied by a
// hypothetical `max-width:100%`.
function hasDeclaration(style: string, declaration: string): boolean {
  return new RegExp(`(^|;)${declaration}(;|$)`).test(style)
}

// This is a style-contract test: it pins the inline style the control emits
// for a given responsive viewport. It renders through react-dom/server and
// does not execute the native layout engine.
//
// Observed behavior being guarded (upstream issue #35): with `width: '100%'`
// on this control, the native app rendered the "Primary font" and
// "Nerd Font family" rows with the label/description column collapsed to one
// character per line at desktop window widths, while the same rows rendered
// correctly in the web client, and toggle rows without a percentage-based
// control rendered correctly in the native app. The internal layout-solver
// reason was not established. A fixed `360px` flex base at tablet/desktop
// widths reproduced correct rendering on the native app; the web client's
// desktop layout is unchanged because 360px was already its effective
// `min(100%, 360px)` cap. Rows stack on mobile (<600px), where the previous
// `width: '100%'` is kept with the same `max-width: 360px` cap.
describe('settings terminal font row style contract', () => {
  for (const viewportWidth of [600, 800, 1626]) {
    it(`uses a fixed 360px flex base at viewport ${viewportWidth}px so the native row keeps its label column`, () => {
      const style = outerControlStyle(renderFontControl(viewportWidth))
      expect(hasDeclaration(style, 'width:360px')).toBe(true)
      expect(hasDeclaration(style, 'width:100%')).toBe(false)
    })
  }

  for (const viewportWidth of [500, 599]) {
    it(`stretches with the card and stays capped below the mobile breakpoint at viewport ${viewportWidth}px`, () => {
      const style = outerControlStyle(renderFontControl(viewportWidth))
      expect(hasDeclaration(style, 'width:100%')).toBe(true)
      expect(hasDeclaration(style, 'max-width:360px')).toBe(true)
    })
  }
})
