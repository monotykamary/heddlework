import React from 'react'
import { afterEach, describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { BrowserSessionService } from '../src/browser/service.ts'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { BrowserPanel } from '../src/ui/browser-panel.tsx'
import { SPRING_SETTLE_MS } from '../src/ui/motion.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { createTestUiRegistry, testControllerDependencies } from './helpers/workbench.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const browsers: BrowserSessionService[] = []
const controllers: WorkbenchController[] = []

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
  for (const browser of browsers.splice(0)) browser.dispose()
})

function createHarness() {
  const controller = new WorkbenchController(new DemoTransport(), '/tmp/heddlework-browser-ui', testControllerDependencies())
  const browser = new BrowserSessionService({ statePath: false, dataRoot: '/tmp/heddlework-browser-ui/data' })
  controllers.push(controller)
  browsers.push(browser)
  return { controller, browser }
}

describeNative('browser panel', () => {
  it('keeps the profile menu reachable in a compact window', async () => {
    const browser = new BrowserSessionService({ statePath: false, dataRoot: '/tmp/heddlework-browser-compact/data' })
    browsers.push(browser)
    browser.ensureTab()
    for (let index = 0; index < 8; index += 1) browser.createProfile({ name: `Profile ${index}` })
    const root = createTestRoot({ width: 280, height: 220 })
    root.render(<BrowserPanel service={browser} fullscreen fullscreenProgress={1} panelWidth={280} onToggleFullscreen={() => {}} onNewSurface={() => {}} onClose={() => {}} />)
    const automation = await connectTest(root.renderer)
    try {
      root.renderer.flush()
      await automation.getByTestId('browser-profile-button').click()
      await Bun.sleep(120)
      root.renderer.flush()
      const body = await automation.getByTestId('browser-panel-body').bounds()
      const menu = await automation.getByTestId('browser-profile-menu').bounds()
      expect(menu.x).toBeGreaterThanOrEqual(body.x)
      expect(menu.y).toBeGreaterThanOrEqual(body.y)
      expect(menu.x + menu.width).toBeLessThanOrEqual(body.x + body.width)
      expect(menu.y + menu.height).toBeLessThanOrEqual(body.y + body.height)
    } finally {
      await automation.close()
      root.unmount()
    }
  })

  it('opens, navigates, manages profiles and tabs, and resizes fullscreen', async () => {
    const { controller, browser } = createHarness()
    const root = createTestRoot({ width: 1_280, height: 760 })
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} ui={createTestUiRegistry(controller)} browsers={browser} />)
    const automation = await connectTest(root.renderer)
    try {
      await controller.start()
      root.renderer.flush()
      await automation.getByTestId('toggle-diff').click()
      await Bun.sleep(SPRING_SETTLE_MS)
      root.renderer.flush()
      await automation.getByTestId('right-panel-new-tab').click()
      root.renderer.flush()
      await automation.getByTestId('surface-option-browser').click()
      await Bun.sleep(40)
      root.renderer.flush()

      expect(await automation.getByTestId('browser-panel').count()).toBe(1)
      expect(await automation.getByTestId('browser-tabs').count()).toBe(0)
      expect(await automation.getByTestId('right-panel-tabs').count()).toBe(1)
      expect(await automation.getByTestId('browser-empty').count()).toBe(1)
      expect(browser.getSnapshot().tabs).toHaveLength(1)
      const firstTabId = browser.getSnapshot().activeTabId
      expect(firstTabId).toBeDefined()
      expect(await automation.getByTestId(`browser-tab-${firstTabId}`).count()).toBe(1)
      const headerBounds = await automation.getByTestId('right-panel-header').bounds()
      const toolbarBounds = await automation.getByTestId('browser-toolbar').bounds()
      expect(toolbarBounds.y).toBe(headerBounds.y + headerBounds.height)
      expect(headerBounds.height).toBe(40)
      // Native automation reports the content bounds, excluding the bottom border.
      expect(toolbarBounds.height).toBe(37)

      await automation.getByTestId('browser-address').fill('localhost:4173/app')
      await automation.getByTestId('browser-address').click()
      root.renderer.simulateKeystrokes('enter')
      root.renderer.flush()
      expect(browser.getSnapshot().tabs[0]).toMatchObject({
        url: 'http://localhost:4173/app',
        materialized: true,
        status: 'loading',
        commandSerial: 2,
      })
      expect(await automation.getByTestId('browser-unavailable').count()).toBe(1)
      expect(root.renderer.findByType('browser')).toHaveLength(0)
      await Bun.sleep(40)
      expect(browser.getSnapshot().placement?.visible).toBe(true)
      const activeTabId = browser.getSnapshot().activeTabId
      expect(activeTabId).toBeDefined()
      const activeGeneration = browser.getSnapshot().tabs.find((tab) => tab.id === activeTabId)!.generation
      browser.applyNativeState(activeTabId!, { generation: activeGeneration, loading: false, error: 'Navigation failed' })
      await Bun.sleep(40)
      root.renderer.flush()
      expect(await automation.getByTestId('browser-error').count()).toBe(1)
      expect(browser.getSnapshot().placement?.visible).toBe(false)

      await automation.getByTestId('browser-profile-button').click()
      root.renderer.flush()
      expect(await automation.getByTestId('browser-profile-menu').count()).toBe(1)
      await automation.getByTestId('browser-create-profile').click()
      root.renderer.flush()
      await automation.getByTestId('browser-profile-name').fill('Preview')
      await automation.getByText('Create').click()
      root.renderer.flush()
      const preview = browser.getSnapshot().profiles.find((profile) => profile.name === 'Preview')
      expect(preview).toMatchObject({ agentAccess: 'prompt', persistent: true })
      expect(browser.getSnapshot().tabs[0]?.profileId).toBe(preview?.id)

      await automation.getByTestId('browser-new-tab').click()
      root.renderer.flush()
      expect(browser.getSnapshot().tabs).toHaveLength(2)
      const second = browser.getSnapshot().activeTabId
      expect(second).toBeDefined()
      expect(await automation.getByTestId(`browser-tab-${second}`).count()).toBe(1)
      await automation.getByTestId(`browser-close-tab-${second}`).click()
      root.renderer.flush()
      expect(browser.getSnapshot().tabs).toHaveLength(1)

      const overflowTabs = Array.from({ length: 10 }, (_, index) => browser.createTab({ address: `https://example.com/${index}`, activate: false }))
      const lastTab = overflowTabs.at(-1)!
      browser.selectTab(lastTab)
      root.renderer.flush()
      await Bun.sleep(40)
      root.renderer.flush()
      const tabListBounds = await automation.getByTestId('right-panel-tabs').bounds()
      const activeTabBounds = await automation.getByTestId(`browser-tab-${lastTab}`).bounds()
      expect(activeTabBounds.x).toBeGreaterThanOrEqual(tabListBounds.x - 1)
      expect(activeTabBounds.x + activeTabBounds.width).toBeLessThanOrEqual(tabListBounds.x + tabListBounds.width + 1)

      const panelBounds = await automation.getByTestId('browser-panel').bounds()
      await automation.getByTestId('right-panel-fullscreen').click()
      await Bun.sleep(SPRING_SETTLE_MS * 2)
      root.renderer.flush()
      const fullscreenBounds = await automation.getByTestId('browser-panel').bounds()
      expect(fullscreenBounds.width).toBeGreaterThan(panelBounds.width + 200)
      expect(await automation.getByTestId('right-panel-restore').count()).toBe(1)
    } finally {
      await automation.close()
      root.unmount()
    }
  }, 15_000)
})
