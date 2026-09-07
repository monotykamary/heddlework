import React from 'react'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { MemoryTerminalBackend } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { TerminalView } from '../src/ui/terminal-view.tsx'
import { SPRING_SETTLE_MS } from '../src/ui/motion.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { createTestUiRegistry, testControllerDependencies } from './helpers/workbench.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const services: TerminalSessionService[] = []
const controllers: WorkbenchController[] = []

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
  await Promise.all(services.splice(0).map((service) => service.dispose()))
})

function createHarness() {
  const controller = new WorkbenchController(new DemoTransport(), '/tmp/heddlework-terminal-ui', testControllerDependencies())
  const terminals = new TerminalSessionService({ cwd: '/tmp/heddlework-terminal-ui', backend: new MemoryTerminalBackend('prompt> ') })
  controllers.push(controller)
  services.push(terminals)
  return { controller, terminals }
}

describeNative('terminal panels', () => {
  it('stages interactive output before the next React or GPUI flush', async () => {
    const terminals = new TerminalSessionService({
      cwd: '/tmp/heddlework-terminal-ui',
      backend: new MemoryTerminalBackend(),
    })
    services.push(terminals)
    const sessionId = await terminals.spawn({ cols: 80, rows: 24 })
    const root = createTestRoot({ width: 800, height: 420 })
    const renderer = root.renderer as typeof root.renderer & {
      setTerminalFrame?: (...args: unknown[]) => void
    }
    const setTerminalFrame = renderer.setTerminalFrame?.bind(renderer)
    expect(setTerminalFrame).toBeDefined()
    let stagedFrames = 0
    renderer.setTerminalFrame = (...args: unknown[]) => {
      stagedFrames += 1
      setTerminalFrame!(...args)
    }
    try {
      root.render(
        <TerminalView
          service={terminals}
          sessionId={sessionId}
          placement="bottom"
          width={800}
          height={420}
          appearance="dark"
        />,
      )
      root.renderer.flush()
      const initialFrames = stagedFrames
      const stateSnapshot = terminals.getStateSnapshot()

      terminals.write(sessionId, 'x')

      expect(stagedFrames).toBe(initialFrames + 1)
      expect(terminals.getStateSnapshot()).toBe(stateSnapshot)
      root.renderer.flush()
      expect(root.renderer.getPaintedText()).toContain('x')
    } finally {
      root.unmount()
    }
  })

  it('routes Ctrl+Shift+C to copy (zero PTY bytes) and plain Ctrl+C to one ETX', async () => {
    const terminals = new TerminalSessionService({ cwd: '/tmp/heddlework-terminal-ui', backend: new MemoryTerminalBackend() })
    services.push(terminals)
    const sessionId = await terminals.spawn({ cols: 80, rows: 24 })
    const copyInput: string[] = []
    const writes: string[] = []
    const originalWrite = terminals.write.bind(terminals)
    terminals.write = (id: string, data: string) => { writes.push(data); return originalWrite(id, data) }
    const root = createTestRoot({ width: 800, height: 420 })
    try {
      root.render(
        <TerminalView
          service={terminals}
          sessionId={sessionId}
          placement="bottom"
          width={800}
          height={420}
          appearance="dark"
          copy={(text) => { copyInput.push(text) }}
        />,
      )
      root.renderer.flush()
      root.renderer.simulateKeystrokes('ctrl+shift+c')
      root.renderer.flush()
      // Ctrl+Shift+C resolves as a copy command: zero PTY bytes even when the
      // (empty) copied scope yields an empty payload.
      expect(writes).toEqual([])

      root.renderer.simulateKeystrokes('ctrl+c')
      root.renderer.flush()
      // Plain Ctrl+C remains exactly one interrupt (ETX) write.
      expect(writes).toEqual([String.fromCharCode(3)])

      root.renderer.simulateKeystrokes('ctrl+shift+c')
      root.renderer.flush()
      // A repeated copy after an interrupt still adds zero PTY bytes.
      expect(writes).toEqual([String.fromCharCode(3)])
    } finally {
      root.unmount()
    }
  })

  it('opens the layout-owned bottom dock and the right terminal surface', async () => {
    const { controller, terminals } = createHarness()
    const root = createTestRoot({ width: 1_280, height: 720 })
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} ui={createTestUiRegistry(controller)} terminals={terminals} />)
    const automation = await connectTest(root.renderer)
    try {
      await controller.start()
      root.renderer.flush()
      expect(await automation.getByTestId('toggle-terminal').count()).toBe(1)
      expect(await automation.getByTestId('terminal-dock').count()).toBe(0)

      await automation.getByTestId('toggle-terminal').click()
      await Bun.sleep(SPRING_SETTLE_MS)
      root.renderer.flush()
      expect(await automation.getByTestId('terminal-dock').count()).toBe(1)
      expect(await automation.getByTestId('terminal-view-bottom').count()).toBe(1)
      expect(await automation.getByTestId('terminal-input-bottom').count()).toBe(1)
      expect(await automation.getByTestId('terminal-dock-fullscreen').count()).toBe(1)
      const nativeTerminal = (root.renderer as unknown as { supportsNativeTerminal?: () => boolean }).supportsNativeTerminal?.() === true
      if (nativeTerminal) expect(root.renderer.findByType('terminal')).toHaveLength(1)
      expect(root.renderer.getPaintedText().some((text) => text.includes('prompt>'))).toBe(true)
      const activeBottomId = terminals.getSnapshot().activeBottomId
      expect(activeBottomId).toBeDefined()
      const dockedSize = terminals.getSnapshot().sessions.find((session) => session.id === activeBottomId)!
      await automation.getByTestId('terminal-input-bottom').click()
      root.renderer.simulateKeystrokes('tab x shift-tab y')
      root.renderer.flush()
      const terminalGrid = terminals.grid(activeBottomId)
      const terminalText = terminalGrid?.viewport.map((row) => row.text).join('\n') ?? ''
      expect(terminalText).toContain('x')
      expect(terminalText).toContain('y')
      expect(terminalGrid?.cursorX).toBeGreaterThan(10)
      const dockBounds = await automation.getByTestId('terminal-dock').bounds()
      const sidebarBounds = await automation.getByTestId('left-sidebar-host').bounds()
      expect(sidebarBounds.width).toBeGreaterThan(100)
      expect(await automation.getByTestId('toggle-left-sidebar').count()).toBe(1)
      await automation.getByTestId('terminal-dock-fullscreen').click()
      await Bun.sleep(SPRING_SETTLE_MS * 2)
      root.renderer.flush()
      const fullDockBounds = await automation.getByTestId('terminal-dock').bounds()
      const fullscreenSize = terminals.getSnapshot().sessions.find((session) => session.id === activeBottomId)!
      expect(fullDockBounds.height).toBeGreaterThan(dockBounds.height + 80)
      expect(fullscreenSize.cols).toBeGreaterThan(dockedSize.cols)
      expect(fullscreenSize.rows).toBeGreaterThan(dockedSize.rows)
      expect((await automation.getByTestId('left-sidebar-host').bounds()).width).toBeLessThanOrEqual(1)
      expect(await automation.getByTestId('toggle-left-sidebar').count()).toBe(0)
      await automation.getByTestId('terminal-dock-restore').click()
      await Bun.sleep(SPRING_SETTLE_MS * 2)
      root.renderer.flush()
      expect(await automation.getByTestId('toggle-left-sidebar').count()).toBe(1)

      await automation.getByTestId('toggle-diff').click()
      await Bun.sleep(SPRING_SETTLE_MS)
      root.renderer.flush()
      await automation.getByTestId('right-panel-new-tab').click()
      await Bun.sleep(40)
      root.renderer.flush()
      await automation.getByTestId('surface-option-terminal').click()
      await Bun.sleep(40)
      root.renderer.flush()
      expect(await automation.getByTestId('terminal-panel').count()).toBe(1)
      expect(await automation.getByTestId('terminal-view-right').count()).toBe(1)
      expect(await automation.getByTestId('surface-placeholder').count()).toBe(0)
      const activeRightId = terminals.getSnapshot().activeRightId
      expect(activeRightId).toBe(activeBottomId)
      root.renderer.simulateKeystrokes('z')
      root.renderer.flush()
      expect(terminals.grid(activeRightId)?.viewport.map((row) => row.text).join('\n')).toContain('z')
      const rightOwnedSize = terminals.getSnapshot().sessions.find((session) => session.id === activeRightId)!
      if (nativeTerminal) expect(root.renderer.findByType('terminal')).toHaveLength(2)

      await automation.getByTestId('terminal-dock-fullscreen').click()
      root.renderer.flush()
      expect(await automation.getByTestId('terminal-view-bottom').count()).toBe(1)
      expect(await automation.getByTestId('terminal-view-right').count()).toBe(1)
      expect(await automation.getByTestId('terminal-grid').count()).toBe(1)
      if (nativeTerminal) expect(root.renderer.findByType('terminal')).toHaveLength(1)
      await Bun.sleep(SPRING_SETTLE_MS * 2)
      root.renderer.flush()

      await automation.getByTestId('terminal-dock-restore').click()
      await Bun.sleep(SPRING_SETTLE_MS * 2)
      root.renderer.flush()
      expect(await automation.getByTestId('terminal-view-right').count()).toBe(1)
      if (nativeTerminal) expect(root.renderer.findByType('terminal')).toHaveLength(2)
      const restoredBottomSize = terminals.getSnapshot().sessions.find((session) => session.id === activeBottomId)!
      expect(restoredBottomSize.rows).toBeLessThan(rightOwnedSize.rows)

      await automation.getByTestId('close-surface').click()
      await Bun.sleep(SPRING_SETTLE_MS * 2)
      root.renderer.flush()
      expect(await automation.getByTestId('terminal-panel').count()).toBe(0)

      await automation.getByTestId('close-terminal-dock').click()
      await Bun.sleep(SPRING_SETTLE_MS * 2)
      root.renderer.flush()
      expect(await automation.getByTestId('terminal-dock').count()).toBe(0)
    } finally {
      await automation.close()
      root.unmount()
    }
  }, 15_000)

  it('applies terminal font and renderer preferences from Settings at runtime', async () => {
    const { controller, terminals } = createHarness()
    const root = createTestRoot({ width: 1_280, height: 820 })
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} ui={createTestUiRegistry(controller)} terminals={terminals} />)
    const automation = await connectTest(root.renderer)
    try {
      await controller.start()
      await controller.submit('/settings')
      await Bun.sleep(30)
      root.renderer.flush()

      expect(await automation.getByTestId('terminal-font-family').count()).toBe(1)
      expect(await automation.getByTestId('terminal-ligatures').count()).toBe(1)
      expect(await automation.getByTestId('terminal-nerd-font').count()).toBe(1)
      expect(await automation.getByTestId('terminal-muted-emoji').count()).toBe(1)

      await automation.getByTestId('terminal-font-family').fill('Fira Code')
      await automation.getByTestId('terminal-font-family-apply').click()
      await automation.getByTestId('terminal-ligatures-off').click()
      await automation.getByTestId('terminal-nerd-font-on').click()
      const settingsScroll = root.renderer.findByTestId('settings-scroll')!
      const settingsBounds = await automation.getByTestId('settings-scroll').bounds()
      const mutedBounds = await automation.getByTestId('terminal-muted-emoji-off').bounds()
      const overflow = mutedBounds.y + mutedBounds.height - settingsBounds.y - settingsBounds.height
      if (overflow > 0) {
        const offset = root.renderer.getScrollOffset(settingsScroll.id)?.[1] ?? 0
        root.renderer.scrollTo(settingsScroll.id, 0, offset - Math.ceil(overflow) - 48)
        root.renderer.flush()
      }
      await automation.getByTestId('terminal-muted-emoji-off').click()
      root.renderer.flush()

      expect(terminals.getSnapshot().appearance).toMatchObject({
        fontFamily: 'Fira Code',
        ligaturesEnabled: false,
        nerdFontEnabled: true,
        muteEmojiColors: false,
      })
    } finally {
      await automation.close()
      root.unmount()
    }
  }, 10_000)
})
