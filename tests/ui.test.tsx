import React from 'react'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { createComposerImage } from '../src/ui/clipboard-media.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { SPRING_SETTLE_MS } from '../src/ui/motion.ts'
import { colors, lightColors, nativeTheme } from '../src/ui/theme.ts'
import { ThemeManager } from '../src/ui/theme-manager.ts'
import { createTestUiRegistry, testControllerDependencies } from './helpers/workbench.ts'

const controllers: WorkbenchController[] = []
const workspaces: string[] = []
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true })
})

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function waitForSettled(controller: WorkbenchController): Promise<void> {
  if (isFullySettled(controller)) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = controller.subscribe(() => {
      if (!isFullySettled(controller)) return
      unsubscribe()
      resolve()
    })
  })
}

function waitForDiff(controller: WorkbenchController): Promise<void> {
  const status = controller.getSnapshot().workspaceDiff.status
  if (status === 'ready' || status === 'error') return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getSnapshot().workspaceDiff.status
      if (next !== 'ready' && next !== 'error') return
      unsubscribe()
      resolve()
    })
  })
}

function isFullySettled(controller: WorkbenchController): boolean {
  const state = controller.getSnapshot()
  return !state.session.isStreaming && state.liveAssistant === undefined && state.liveTools.length === 0
}

describeNative('WorkbenchApp', () => {
  it('renders and operates the T3-style native workbench shell', async () => {
    const workspace = createWorkspaceFixture()
    const project = basename(workspace)
    const controller = new WorkbenchController(new DemoTransport(), workspace, testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    controllers.push(controller)
    const root = createTestRoot()
    const themeManager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => 'dark' })
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} ui={createTestUiRegistry(controller)} themeManager={themeManager} />)
    await controller.start()
    await waitForDiff(controller)
    root.renderer.flush()

    const painted = root.renderer.getPaintedText()
    expect(painted).toContain('Heddlework')
    expect(painted).toContain('Search')
    expect(painted).toContain('All projects')
    expect(painted).toContain(project)
    expect(painted).toContain('Demo session')
    expect(painted.some((line) => line.startsWith('What should we build in '))).toBe(true)
    expect(painted).toContain('Ask anything, @tag files/folders, $use skills, or / for commands')
    expect(painted).not.toContain('Build')
    expect(painted).not.toContain('Pi tools')
    expect(root.renderer.findByType('virtual-list')).toHaveLength(1)
    expect(root.renderer.findByType('textarea')).toHaveLength(1)
    const icons = root.renderer.findByType('svg')
    expect(icons.length).toBeGreaterThan(12)
    expect(icons.every((icon) => String(icon.customProps?.src ?? '').startsWith('data:image/svg+xml,'))).toBe(true)

    const screenshotDirectory = resolve(import.meta.dir, '../screenshots')
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench.png')
      mkdirSync(screenshotDirectory, { recursive: true })
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }

    const automation = await connectTest(root.renderer)
    await automation.getByTestId('workspace-chooser-trigger').click()
    root.renderer.flush()
    expect(await automation.getByTestId('workspace-menu').count()).toBe(1)
    expect(await automation.getByTestId('workspace-choice-current').count()).toBe(1)
    expect(await automation.getByTestId('workspace-new-project').count()).toBe(1)
    expect(await automation.getByTestId('workspace-search').count()).toBe(1)
    expect(await automation.getByTestId('workspace-project-list').count()).toBe(1)
    expect(Number(root.renderer.findByTestId('workspace-project-list')?.style.height)).toBeLessThanOrEqual(210)
    expect(root.renderer.getPaintedText()).toContain('New project')
    expect(root.renderer.getPaintedText()).toContain('1 of 1 projects')
    await automation.getByTestId('workspace-search').fill('definitely missing workspace')
    root.renderer.flush()
    expect(await automation.getByTestId('workspace-search-empty').count()).toBe(1)
    expect(root.renderer.getPaintedText()).toContain('No projects match your search')
    await automation.getByTestId('workspace-search').fill('')
    root.renderer.flush()
    const workspaceTrigger = root.renderer.findByTestId('workspace-chooser-trigger')!
    expect(workspaceTrigger.style).toMatchObject({ height: 32, borderBottomWidth: 1 })
    const workspacePositioner = root.renderer.findByTestId('workspace-menu-positioner')!
    expect(workspacePositioner.style.backgroundColor).toBe(colors.transparent)
    expect(root.renderer.findByType('anchored').some((node) => node.testId === 'workspace-menu')).toBe(false)
    const workspaceStack = root.renderer.findByTestId('draft-workspace-stack')!
    const composerLayer = root.renderer.findByTestId('draft-composer-layer')!
    expect(workspaceStack.children.indexOf(workspacePositioner.id)).toBeGreaterThan(workspaceStack.children.indexOf(composerLayer.id))
    await automation.getByTestId('workspace-chooser-trigger').press('enter')
    root.renderer.flush()
    expect(await automation.getByTestId('workspace-menu').count()).toBe(0)
    expect(await automation.getByTestId('sidebar-session-active').count()).toBe(0)
    expect(await automation.getByTestId('sidebar-session-card').count()).toBe(0)
    const sidebarList = (await automation.getByTestId('sidebar-session-list').all())[0]!
    expect(Math.abs(root.renderer.getScrollOffset(sidebarList.id)?.[1] ?? 0)).toBeLessThanOrEqual(0.01)
    expect(await automation.getByTestId('toggle-left-sidebar').count()).toBe(1)
    const openSidebarToggleBounds = await automation.getByTestId('toggle-left-sidebar').bounds()
    if (process.platform === 'darwin') expect(Math.abs(openSidebarToggleBounds.x - 90)).toBeLessThanOrEqual(1)
    expect((await automation.getByTestId('left-sidebar-host').bounds()).width).toBe(256)
    await automation.getByTestId('toggle-left-sidebar').click()
    await Bun.sleep(70)
    root.renderer.flush()
    const closingSidebarWidth = (await automation.getByTestId('left-sidebar-host').bounds()).width
    expect(closingSidebarWidth).toBeGreaterThan(0)
    expect(closingSidebarWidth).toBeLessThan(256)
    await Bun.sleep(SPRING_SETTLE_MS)
    root.renderer.flush()
    expect((await automation.getByTestId('left-sidebar-host').bounds()).width).toBeLessThanOrEqual(1)
    const collapsedToggleBounds = await automation.getByTestId('toggle-left-sidebar').bounds()
    const collapsedBreadcrumbBounds = await automation.getByTestId('chat-breadcrumb').bounds()
    expect(collapsedBreadcrumbBounds.x).toBeGreaterThanOrEqual(collapsedToggleBounds.x + collapsedToggleBounds.width + 10)
    await automation.getByTestId('toggle-left-sidebar').click()
    await Bun.sleep(70)
    root.renderer.flush()
    const openingSidebarWidth = (await automation.getByTestId('left-sidebar-host').bounds()).width
    expect(openingSidebarWidth).toBeGreaterThan(0)
    expect(openingSidebarWidth).toBeLessThan(256)
    await Bun.sleep(SPRING_SETTLE_MS)
    root.renderer.flush()
    expect(Math.abs((await automation.getByTestId('left-sidebar-host').bounds()).width - 256)).toBeLessThanOrEqual(1)
    const longDraft = 'responsive input '.repeat(32).slice(0, 500)
    const inputStartedAt = performance.now()
    await automation.getByTestId('composer').fill(longDraft)
    root.renderer.flush()
    expect(controller.getSnapshot().editorText).toBe(longDraft)
    expect(performance.now() - inputStartedAt).toBeLessThan(5_000)
    await automation.getByTestId('composer').fill('')

    const pastedImage = createComposerImage(readFileSync(resolve(import.meta.dir, 'fixtures/pasted-image.png')), 'image/png')
    controller.addEditorImage(pastedImage)
    expect(controller.getSnapshot().editorImages).toHaveLength(1)
    await Bun.sleep(35)
    root.renderer.flush()
    expect(await automation.getByTestId('composer-image-preview').count()).toBe(1)
    expect(root.renderer.findByType('img')).toHaveLength(1)
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-image-paste.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }

    await controller.submit('Inspect the repository')
    await waitForSettled(controller)
    root.renderer.flush()
    const conversation = root.renderer.getPaintedText()
    const transcriptList = root.renderer.findByTestId('transcript-list')!
    expect(root.renderer.findByType('virtual-list')).toHaveLength(2)
    expect(transcriptList.events.has('visibleRange')).toBe(true)
    expect(transcriptList.customProps?.alignment).toBe('bottom')
    expect(root.renderer.getScrollOffset(transcriptList.id)).not.toBeNull()
    expect(conversation).toContain('Inspect the repository')
    expect(conversation.some((line) => line.includes('native GPUIX transcript'))).toBe(true)

    const userBounds = await automation.getByTestId('user-message').bounds()
    await automation.call('mouseMove', { x: userBounds.x + userBounds.width - 4, y: userBounds.y + userBounds.height - 3 })
    await Bun.sleep(30)
    root.renderer.flush()
    expect(await automation.getByTestId('copy-message').count()).toBeGreaterThanOrEqual(2)
    expect(await automation.getByTestId('fork-message').count()).toBeGreaterThanOrEqual(2)
    const assistantRows = await automation.getByTestId('assistant-message').all()
    const assistantBounds = assistantRows.at(-1)?.bounds
    expect(assistantBounds).toBeDefined()
    await automation.call('mouseMove', { x: assistantBounds!.x + assistantBounds!.width / 2, y: assistantBounds!.y + assistantBounds!.height / 2 })
    await Bun.sleep(80)
    root.renderer.flush()
    expect(await automation.getByTestId('copy-message').count()).toBeGreaterThanOrEqual(2)
    expect(await automation.getByTestId('fork-message').count()).toBeGreaterThanOrEqual(2)
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-message-actions.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }

    const sidebarBounds = await automation.getByTestId('sidebar').bounds()
    const projectToggleBounds = await automation.getByTestId('sidebar-project-toggle').bounds()
    const projectLabelBounds = await automation.getByTestId('sidebar-project-label').bounds()
    const projectChevronBounds = await automation.getByTestId('sidebar-project-chevron').bounds()
    const projectLeftInset = projectLabelBounds.x - projectToggleBounds.x
    const projectRightInset = projectToggleBounds.x + projectToggleBounds.width - projectChevronBounds.x - projectChevronBounds.width
    expect(Math.abs(projectLeftInset - projectRightInset)).toBeLessThanOrEqual(1)

    const newThreadBounds = await automation.getByTestId('sidebar-new-thread').bounds()
    const newProjectBounds = await automation.getByTestId('sidebar-new-project').bounds()
    expect(Math.abs(newThreadBounds.x + newThreadBounds.width / 2 - newProjectBounds.x - newProjectBounds.width / 2)).toBeLessThanOrEqual(1)

    const settingsBounds = await automation.getByTestId('sidebar-settings').bounds()
    const connectionBounds = await automation.getByTestId('sidebar-connection-status').bounds()
    const footerLeftInset = settingsBounds.x - sidebarBounds.x
    const footerRightInset = sidebarBounds.x + sidebarBounds.width - connectionBounds.x - connectionBounds.width
    expect(Math.abs(footerLeftInset - footerRightInset)).toBeLessThanOrEqual(1)

    const composerSurfaceBounds = await automation.getByTestId('composer-surface').bounds()
    const contextBarBounds = await automation.getByTestId('composer-context-bar').bounds()
    const surfaceBottom = composerSurfaceBounds.y + composerSurfaceBounds.height
    const contextBottom = contextBarBounds.y + contextBarBounds.height
    expect(Math.abs(surfaceBottom - contextBarBounds.y - 21)).toBeLessThanOrEqual(1)
    expect(Math.abs(contextBottom - surfaceBottom - 27)).toBeLessThanOrEqual(1)
    expect(Math.abs(contextBarBounds.width - composerSurfaceBounds.width + 44)).toBeLessThanOrEqual(2)
    const contextShadow = root.renderer.findByTestId('composer-context-shadow')!
    const contextShadowBounds = await automation.getByTestId('composer-context-shadow').bounds()
    const checkoutLabel = root.renderer.findByTestId('composer-checkout-label')!
    const checkoutLabelBounds = await automation.getByTestId('composer-checkout-label').bounds()
    const branchLabel = root.renderer.findByTestId('composer-branch-label')!
    expect(contextShadowBounds.y + contextShadowBounds.height).toBeLessThanOrEqual(checkoutLabelBounds.y + 1)
    expect(Math.abs(contextShadowBounds.width - contextBarBounds.width)).toBeLessThanOrEqual(1)
    expect(contextShadowBounds.height).toBe(10)
    expect(contextShadow.style.top).toBe(12)
    expect(contextShadow.style.left).toBe(0)
    expect(contextShadow.style.right).toBe(0)
    expect(checkoutLabel.style.fontSize).toBe(12)
    expect(checkoutLabel.style.color).toBe('#767679')
    expect(branchLabel.style.fontSize).toBe(12)
    expect(branchLabel.style.color).toBe('#767679')
    const contextMeterBounds = await automation.getByTestId('context-meter').bounds()
    const sendBounds = await automation.getByTestId('send').bounds()
    expect(sendBounds.x - contextMeterBounds.x - contextMeterBounds.width).toBeGreaterThanOrEqual(8)
    await automation.getByTestId('context-meter').hover()
    expect(await automation.getByTestId('context-popover').count()).toBe(1)
    const contextPositioner = root.renderer.findByTestId('context-popover-positioner')!
    expect(contextPositioner.type).toBe('div')
    expect(contextPositioner.style.backgroundColor).toBe(colors.transparent)
    expect(contextPositioner.style).toMatchObject({ position: 'absolute', right: 46, bottom: 84, width: 256 })
    expect(root.renderer.findByType('anchored').some((node) => node.testId === 'context-popover-layer')).toBe(false)
    const contextPopoverBounds = await automation.getByTestId('context-popover').bounds()
    expect(contextPopoverBounds.y + contextPopoverBounds.height).toBeLessThanOrEqual(contextMeterBounds.y - 4)
    expect(Math.abs(contextPopoverBounds.x + contextPopoverBounds.width - contextMeterBounds.x - contextMeterBounds.width)).toBeLessThanOrEqual(12)
    const contextPopover = root.renderer.findByTestId('context-popover')!
    const openMotion = contextPopover.customProps?.motion as { initial: { opacity: number; top: number }; animate: { opacity: number; top: number } }
    expect(openMotion.initial).toEqual({ opacity: 0, top: 4 })
    expect(openMotion.animate).toEqual({ opacity: 1, top: 0 })
    await automation.call('mouseMove', { x: contextMeterBounds.x - 20, y: contextMeterBounds.y + contextMeterBounds.height / 2 })
    await Bun.sleep(0)
    root.renderer.flush()
    expect(await automation.getByTestId('context-popover').count()).toBe(1)
    const exitMotion = (root.renderer.findByTestId('context-popover')!.customProps?.motion as { animate: { opacity: number; top: number } }).animate
    expect(exitMotion).toEqual({ opacity: 0, top: 4 })
    await Bun.sleep(180)
    root.renderer.flush()
    expect(await automation.getByTestId('context-popover').count()).toBe(0)
    expect(root.renderer.getPaintedText()).not.toContain(process.platform === 'darwin' ? '⌥↵ queue' : 'Alt+Enter queue')
    expect(root.renderer.findByType('img').length).toBeGreaterThan(0)
    expect(await automation.getByTestId('transcript-bottom-fade').count()).toBe(1)

    await automation.getByTestId('add-action').click()
    expect(root.renderer.getPaintedText()).toContain('Clone thread')
    expect(root.renderer.getPaintedText()).toContain('Compact context')
    expect(root.renderer.getPaintedText()).toContain('Refresh sessions')
    expect(root.renderer.getPaintedText()).toContain('Export transcript')
    await automation.getByTestId('add-action').click()
    await automation.getByTestId('sidebar-project-toggle').click()
    expect(await automation.getByTestId('sidebar-project-filter').count()).toBe(1)
    expect(await automation.getByTestId('sidebar-session-active').count()).toBe(1)
    await automation.getByTestId('sidebar-project-option-1').click()
    expect(await automation.getByTestId('sidebar-session-active').count()).toBe(1)
    await automation.getByTestId('sidebar-search').fill('no such thread')
    expect(root.renderer.getPaintedText()).toContain('No threads found')
    await automation.getByTestId('sidebar-search').fill('')

    expect(root.renderer.findByType('code')).toHaveLength(0)
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-conversation.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }
    await automation.getByTestId('tool-row').press('enter')
    root.renderer.flush()
    expect(root.renderer.getPaintedText()).toContain('TOOL CALL')
    expect(await automation.getByTestId('execution-timeline').count()).toBe(1)
    expect(root.renderer.findByTestId('tool-summary-label')?.style.fontFamily).toBe('Menlo')
    await automation.getByTestId('tool-detail-row').press('enter')
    root.renderer.flush()
    expect(root.renderer.findByType('code').length).toBeGreaterThan(0)
    await automation.getByTestId('tool-detail-row').press('enter')
    await automation.getByTestId('tool-row').press('enter')
    root.renderer.flush()

    await automation.getByTestId('toggle-diff').click()
    await Bun.sleep(70)
    root.renderer.flush()
    const openingRightWidth = (await automation.getByTestId('right-panel-host').bounds()).width
    const rightPanelTargetWidth = (await automation.getByTestId('diff-panel').bounds()).width
    expect(openingRightWidth).toBeGreaterThan(0)
    expect(openingRightWidth).toBeLessThan(rightPanelTargetWidth)
    await Bun.sleep(SPRING_SETTLE_MS)
    await waitForDiff(controller)
    root.renderer.flush()
    expect(await automation.getByTestId('diff-panel').count()).toBe(1)
    themeManager.setMode('light')
    await Bun.sleep(0)
    root.renderer.flush()
    expect(root.renderer.findByTestId('sidebar')?.style.backgroundColor).toBe(lightColors.sidebar)
    expect(root.renderer.findByTestId('diff-panel')?.style.backgroundColor).toBe(lightColors.panel)
    expect(root.renderer.findByTestId('composer-context-shadow-strong')?.style.backgroundColor).toBe('#00000012')
    await automation.getByTestId('diff-wrap-toggle').click()
    root.renderer.flush()
    const wrappedCodeColors = root.renderer.findByType('text').filter((node) => node.testId === 'diff-wrapped-code').map((node) => node.style.color)
    expect(wrappedCodeColors).toContain(nativeTheme.codeText)
    expect(root.renderer.findByTestId('diff-wrapped-scroll')?.style.selectionColor).toBe(`${lightColors.primary}66`)
    await automation.getByTestId('diff-wrap-toggle').click()
    root.renderer.flush()
    themeManager.setMode('dark')
    await Bun.sleep(0)
    root.renderer.flush()
    expect(root.renderer.getPaintedText()).toContain('Working tree')
    expect(root.renderer.getPaintedText()).toContain('README.md')
    expect(root.renderer.findByTestId('diff-content')?.style.fontFamily).toBe('Menlo')
    expect(await automation.getByTestId('diff-native').count()).toBe(1)
    expect(await automation.getByTestId('diff-horizontal-scroll').count()).toBe(0)
    expect(await automation.getByTestId('diff-sticky-gutter').count()).toBe(0)
    const wrapStartedAt = performance.now()
    await automation.getByTestId('diff-wrap-toggle').click()
    root.renderer.flush()
    expect(performance.now() - wrapStartedAt).toBeLessThan(500)
    expect(await automation.getByTestId('diff-native').count()).toBe(0)
    expect(await automation.getByTestId('diff-wrapped-scroll').count()).toBe(1)
    expect(root.renderer.findByTestId('diff-wrapped-code')?.style.fontFamily).toBe('Menlo')
    expect(root.renderer.findByTestId('diff-wrapped-code')?.style.whiteSpace).toBe('normal')
    await automation.getByTestId('diff-wrap-toggle').click()
    await automation.getByTestId('diff-file-list').click()
    await Bun.sleep(70)
    root.renderer.flush()
    expect(await automation.getByTestId('diff-file-list-panel').count()).toBe(1)
    const openingFileListWidth = (await automation.getByTestId('diff-file-list-host').bounds()).width
    expect(openingFileListWidth).toBeGreaterThan(0)
    expect(openingFileListWidth).toBeLessThan(212)
    expect(root.renderer.findByTestId('diff-file-row')?.style.height).toBe(40)
    expect(root.renderer.getPaintedText()).toContain('All changes')
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-diff.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }
    await Bun.sleep(SPRING_SETTLE_MS)
    root.renderer.flush()
    expect(Math.abs((await automation.getByTestId('diff-file-list-host').bounds()).width - 212)).toBeLessThanOrEqual(3)
    await automation.getByTestId('diff-file-list').click()
    await Bun.sleep(70)
    root.renderer.flush()
    const closingFileListWidth = (await automation.getByTestId('diff-file-list-host').bounds()).width
    expect(closingFileListWidth).toBeGreaterThan(0)
    expect(closingFileListWidth).toBeLessThan(212)
    await Bun.sleep(SPRING_SETTLE_MS)
    root.renderer.flush()
    expect(await automation.getByTestId('diff-file-list-host').count()).toBe(0)
    const refreshBounds = await automation.getByTestId('right-panel-refresh').bounds()
    const fullscreenBounds = await automation.getByTestId('right-panel-fullscreen').bounds()
    const closeBounds = await automation.getByTestId('close-diff').bounds()
    expect(Math.abs(refreshBounds.y + refreshBounds.height / 2 - fullscreenBounds.y - fullscreenBounds.height / 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(closeBounds.y + closeBounds.height / 2 - fullscreenBounds.y - fullscreenBounds.height / 2)).toBeLessThanOrEqual(1)
    const rootBounds = await automation.getByTestId('workbench-root').bounds()
    await automation.getByTestId('right-panel-fullscreen').click()
    await Bun.sleep(25)
    root.renderer.flush()
    const expandingPanelBounds = await automation.getByTestId('diff-panel').bounds()
    expect(expandingPanelBounds.width).toBeGreaterThan(rightPanelTargetWidth)
    expect(expandingPanelBounds.width).toBeLessThan(rootBounds.width)
    await Bun.sleep(SPRING_SETTLE_MS * 2)
    root.renderer.flush()
    const fullscreenPanelBounds = await automation.getByTestId('diff-panel').bounds()
    expect(Math.abs(fullscreenPanelBounds.width - rootBounds.width)).toBeLessThanOrEqual(2)
    expect(Math.abs(fullscreenPanelBounds.height - rootBounds.height)).toBeLessThanOrEqual(2)
    expect((await automation.getByTestId('left-sidebar-host').bounds()).width).toBeLessThanOrEqual(1)
    if (process.platform === 'darwin') expect((await automation.getByTestId('right-panel-tab').bounds()).x).toBeGreaterThanOrEqual(rootBounds.x + 100)
    await automation.getByTestId('right-panel-restore').click()
    await Bun.sleep(25)
    root.renderer.flush()
    const restoringPanelBounds = await automation.getByTestId('diff-panel').bounds()
    expect(restoringPanelBounds.width).toBeGreaterThan(rightPanelTargetWidth)
    expect(restoringPanelBounds.width).toBeLessThan(rootBounds.width)
    await Bun.sleep(SPRING_SETTLE_MS)
    root.renderer.flush()
    expect(await automation.getByTestId('sidebar').count()).toBe(1)
    await automation.getByTestId('right-panel-new-tab').click()
    expect(await automation.getByTestId('surface-picker').count()).toBe(1)
    expect(root.renderer.getPaintedText()).toContain('Open a surface')
    expect(root.renderer.getPaintedText()).toContain('Browser')
    expect(root.renderer.getPaintedText()).toContain('Terminal')
    expect(root.renderer.getPaintedText()).toContain('Files')
    expect(root.renderer.getPaintedText()).toContain('Agents')
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-surface-picker.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }
    await automation.getByTestId('surface-option-terminal').click()
    expect(await automation.getByTestId('surface-placeholder').count()).toBe(1)
    await automation.getByTestId('right-panel-new-tab').click()
    await automation.getByTestId('surface-option-diff').click()
    expect(await automation.getByTestId('diff-panel').count()).toBe(1)
    const openRightWidth = (await automation.getByTestId('right-panel-host').bounds()).width
    await automation.getByTestId('close-diff').click()
    await Bun.sleep(70)
    root.renderer.flush()
    const closingRightWidth = (await automation.getByTestId('right-panel-host').bounds()).width
    expect(closingRightWidth).toBeGreaterThan(0)
    expect(closingRightWidth).toBeLessThan(openRightWidth)
    await Bun.sleep(SPRING_SETTLE_MS)
    root.renderer.flush()
    expect(await automation.getByTestId('right-panel-host').count()).toBe(0)

    const sessionCardBeforeHover = await automation.getByTestId('sidebar-session-card-active').bounds()
    const sessionSurfaceBounds = await automation.getByTestId('sidebar-session-surface').bounds()
    const cardLeftInset = sessionSurfaceBounds.x - sidebarBounds.x
    const cardRightInset = sidebarBounds.x + sidebarBounds.width - sessionSurfaceBounds.x - sessionSurfaceBounds.width
    expect(cardLeftInset).toBeGreaterThanOrEqual(8)
    expect(cardRightInset).toBeGreaterThanOrEqual(8)
    expect(Math.abs(cardLeftInset - cardRightInset)).toBeLessThanOrEqual(2)
    await automation.call('mouseMove', { x: sessionCardBeforeHover.x + sessionCardBeforeHover.width / 2, y: sessionCardBeforeHover.y + 3 })
    await Bun.sleep(30)
    root.renderer.flush()
    const sessionCardAfterHover = await automation.getByTestId('sidebar-session-card-active').bounds()
    expect(sessionCardAfterHover).toEqual(sessionCardBeforeHover)
    expect(root.renderer.findByTestId('sidebar-settle')?.style.backgroundColor ?? colors.transparent).toBe(colors.transparent)
    expect(root.renderer.findByTestId('sidebar-settle-label')?.style.color).toBe(colors.textFaint)
    const settleBounds = await automation.getByTestId('sidebar-settle').bounds()
    await automation.call('mouseMove', { x: settleBounds.x + settleBounds.width / 2, y: settleBounds.y + settleBounds.height / 2 })
    await Bun.sleep(30)
    root.renderer.flush()
    expect(root.renderer.findByTestId('sidebar-settle-label')?.style.color).toBe(colors.text)
    expect(root.renderer.findByTestId('sidebar-settle')?.style.backgroundColor ?? colors.transparent).toBe(colors.transparent)
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-thread-hover.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }
    await automation.getByTestId('sidebar-snooze').click()
    expect(root.renderer.getPaintedText()).toContain('In 1 hour')
    await automation.getByTestId('snooze-option-0').click()
    expect(root.renderer.getPaintedText()).toContain('Snoozed (1)')
    await Bun.sleep(40)
    root.renderer.flush()
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-snoozed.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }
    await automation.getByTestId('sidebar-wake').click()
    const restoredBounds = await automation.getByTestId('sidebar-session-active').bounds()
    await automation.call('mouseMove', { x: restoredBounds.x + restoredBounds.width / 2, y: restoredBounds.y + 3 })
    await Bun.sleep(30)
    root.renderer.flush()
    await automation.getByTestId('sidebar-settle').click()
    expect(root.renderer.getPaintedText()).toContain('Settled (1)')
    expect(await automation.getByTestId('sidebar-settled-row').count()).toBe(1)
    await automation.getByTestId('sidebar-settled-toggle').click()
    await Bun.sleep(40)
    root.renderer.flush()
    expect(root.renderer.getPaintedText()).not.toContain('Settled (1)')
    expect(await automation.getByTestId('sidebar-settled-row').count()).toBe(1)
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-settled.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }
    await automation.getByTestId('sidebar-wake').click()

    await automation.getByTestId('sidebar-settings').click()
    expect(root.renderer.getPaintedText()).toContain('Pi executable')
    expect(await automation.getByTestId('settings-global').count()).toBe(1)
    expect(root.renderer.getPaintedText()).toContain('Pinned above composer')
    expect(await automation.getByTestId('theme-mode-system').count()).toBe(1)
    await automation.getByTestId('theme-mode-light').click()
    root.renderer.flush()
    expect(root.renderer.findByTestId('workbench-root')?.style.backgroundColor).toBe(lightColors.background)
    expect(root.renderer.findByTestId('sidebar')?.style.backgroundColor).toBe(lightColors.sidebar)
    expect(nativeTheme.appearance).toBe('light')
    await automation.getByTestId('theme-mode-dark').click()
    root.renderer.flush()
    expect(root.renderer.findByTestId('workbench-root')?.style.backgroundColor).toBe(colors.background)
    expect(nativeTheme.appearance).toBe('dark')
    expect(root.renderer.getPaintedText()).not.toContain('Saved threads')
    expect(root.renderer.getPaintedText()).not.toContain('Persistence')
    expect(root.renderer.getPaintedText()).toContain('Alpha')
    const alphaBounds = await automation.getByTestId('settings-alpha').bounds()
    expect(alphaBounds.y).toBeGreaterThanOrEqual(52)
    expect(alphaBounds.y + alphaBounds.height).toBeLessThanOrEqual(sidebarBounds.y + sidebarBounds.height)
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-settings.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }
    await automation.getByTestId('sidebar-session-active').click()
    await Bun.sleep(30)
    root.renderer.flush()
    expect(await automation.getByTestId('settings-view').count()).toBe(0)
    expect(await automation.getByTestId('composer-surface').count()).toBe(1)

    await automation.close()
    root.unmount()
    themeManager.dispose()
  }, 20_000)
})

function createWorkspaceFixture(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'example-workspace-'))
  workspaces.push(workspace)
  writeFileSync(join(workspace, 'README.md'), '# Workbench fixture\n')
  run(workspace, ['git', 'init', '-q'])
  run(workspace, ['git', 'add', '.'])
  run(workspace, ['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'test: seed workbench'])
  run(workspace, ['git', 'branch', '-M', 'main'])
  writeFileSync(join(workspace, 'README.md'), '# Workbench fixture\n\nA changed line.\n')
  return workspace
}

function run(cwd: string, command: string[]): void {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}
