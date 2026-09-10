import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { NativeDiffViewport, WrappedDiff } from '../src/ui/diff-panel.tsx'

const describeNative = hasNativeTestRenderer ? describe : describe.skip
// `check` repeats these budgets in a fresh process after the functional suite.
const enforceBudgets = process.env.HEDDLEWORK_PERFORMANCE_BUDGETS === '1'

describeNative('diff viewport performance', () => {
  it('bounds the first native reconciliation while keeping the remaining lines accessible', async () => {
    const body = Array.from({ length: 1_200 }, (_, index) => ` context line ${index}`).join('\n')
    const patch = `diff --git a/large.ts b/large.ts\n@@ -1,1200 +1,1200 @@\n${body}`
    const root = createTestRoot()
    const startedAt = performance.now()
    root.render(
      <div style={{ width: 620, height: 560, display: 'flex' }}>
        <WrappedDiff patch={patch} />
      </div>,
    )
    const elapsed = performance.now() - startedAt
    const automation = await connectTest(root.renderer)

    if (enforceBudgets) expect(elapsed).toBeLessThan(2_500)
    expect(await automation.getByTestId('diff-wrapped-code').count()).toBe(400)
    expect(await automation.getByTestId('diff-wrapped-show-more').count()).toBe(1)
    const wrappedBounds = await automation.getByTestId('diff-wrapped-viewport').bounds()
    const hunkBounds = await automation.getByTestId('diff-wrapped-row:hunk').bounds()
    expect(hunkBounds.width).toBe(wrappedBounds.width)
    const wrappedList = (await automation.getByTestId('diff-wrapped-scroll').all())[0]!
    root.renderer.scrollToItem(wrappedList.id, 400)
    root.renderer.flush()
    await automation.getByTestId('diff-wrapped-show-more').click()
    root.renderer.flush()
    expect(await automation.getByTestId('diff-wrapped-code').count()).toBe(800)

    await automation.close()
    root.unmount()
  })

  it('opens a ten-thousand-line patch in the native virtualized scroller', async () => {
    const body = Array.from({ length: 10_000 }, (_, index) => ` context native line ${index}`).join('\n')
    const patch = `diff --git a/huge.ts b/huge.ts\n@@ -1,10000 +1,10000 @@\n${body}`
    const file = { path: 'huge.ts', patch, additions: 0, deletions: 0 }
    const root = createTestRoot()
    const startedAt = performance.now()
    root.render(
      <div style={{ width: 620, height: 560, display: 'flex' }}>
        <NativeDiffViewport patch={patch} files={[file]} canvasWidth={1_200} />
      </div>,
    )
    const elapsed = performance.now() - startedAt
    const automation = await connectTest(root.renderer)

    if (enforceBudgets) expect(elapsed).toBeLessThan(3_000)
    expect(await automation.getByTestId('diff-native').count()).toBe(1)
    expect(await automation.getByTestId('diff-horizontal-scroll').count()).toBe(0)
    expect(await automation.getByTestId('diff-sticky-gutter').count()).toBe(0)

    await automation.close()
    root.unmount()
  })

  it('keeps deep scrolling bounded without a React gutter chasing native frames', async () => {
    const body = Array.from({ length: 10_000 }, (_, index) => ` context deep-scroll line ${index}`).join('\n')
    const patch = `diff --git a/deep.ts b/deep.ts\n@@ -1,10000 +1,10000 @@\n${body}`
    const file = { path: 'deep.ts', patch, additions: 0, deletions: 0 }
    const root = createTestRoot()
    let commits = 0
    root.render(
      <React.Profiler id="native-diff-scroll" onRender={() => { commits += 1 }}>
        <div style={{ width: 620, height: 560, display: 'flex' }}>
          <NativeDiffViewport patch={patch} files={[file]} canvasWidth={4_000} />
        </div>
      </React.Profiler>,
    )
    const automation = await connectTest(root.renderer)
    const viewport = await automation.getByTestId('diff-native-viewport').bounds()

    for (let index = 0; index < 80; index += 1) {
      root.renderer.nativeSimulateScrollWheel(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2, 0, -1_200)
    }
    root.renderer.flush()

    const settledCommits = commits
    expect(settledCommits).toBeGreaterThan(0)
    const settledStartedAt = performance.now()
    for (let index = 0; index < 12; index += 1) {
      root.renderer.nativeSimulateScrollWheel(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2, 0, -400)
    }
    if (enforceBudgets) expect(performance.now() - settledStartedAt).toBeLessThan(300)
    expect(commits).toBe(settledCommits)
    expect(await automation.getByTestId('diff-native').count()).toBe(1)
    expect(await automation.getByTestId('diff-native-show-more').count()).toBe(0)
    expect(await automation.getByTestId('diff-gutter-edge').count()).toBe(0)

    await automation.close()
    root.unmount()
  }, 15_000)

})
