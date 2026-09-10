import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { FlowRuntime } from '../src/flows/runtime.ts'
import { createWorkspaceHost, hostConnectUrl, type WorkspaceHost } from '../src/host/server.ts'
import { generateHostToken } from '../src/host/token.ts'
import { BunPtyBackend, type TerminalBackend, type TerminalProcess } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import type { TerminalSpawnRequest } from '../src/terminal/types.ts'
import { WorkbenchController, type WorkbenchControllerDependencies } from '../src/workbench/controller.ts'

const root = resolve(import.meta.dir, '..')
const staticRoot = resolve(process.env.HEDDLEWORK_WEB_ROOT ?? resolve(root, 'dist', 'web'))
const probeTimeoutMs = 120_000

class RecordingPtyBackend implements TerminalBackend {
  readonly writes: string[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  kills = 0
  readonly #pty = new BunPtyBackend()

  async spawn(request: TerminalSpawnRequest & { cols: number; rows: number; cwd: string }): Promise<TerminalProcess> {
    const process = await this.#pty.spawn({ ...request, shell: '/bin/bash', args: ['--noprofile', '--norc'], env: { ...request.env, PS1: 'HW> ', PS2: '> ' } })
    return {
      ...(process.pid === undefined ? {} : { pid: process.pid }),
      write: (data) => {
        this.writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
        process.write(data)
      },
      resize: (cols, rows) => {
        this.resizes.push({ cols, rows })
        process.resize(cols, rows)
      },
      kill: () => {
        this.kills += 1
        process.kill()
      },
      onData: (listener) => process.onData(listener),
      onExit: (listener) => process.onExit(listener),
    }
  }

  textSince(index: number): string {
    return this.writes.slice(index).join('')
  }
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function controllerDependencies(): WorkbenchControllerDependencies {
  return {
    sessionCatalog: {
      list: async () => [],
      createWorkspaceSession: async () => { throw new Error('The browser probe does not create workspaces') },
    },
    workspaceDiff: {
      load: async () => ({ status: 'ready', branch: 'browser-probe', files: [], additions: 0, deletions: 0 }),
    },
  }
}

interface PageEvidence {
  requests: string[]
  sockets: string[]
  errors: Error[]
}

function observe(page: Page): PageEvidence {
  const evidence: PageEvidence = { requests: [], sockets: [], errors: [] }
  page.on('request', (request) => evidence.requests.push(request.url()))
  page.on('websocket', (socket) => evidence.sockets.push(socket.url()))
  page.on('pageerror', (error) => evidence.errors.push(error))
  return evidence
}

async function pair(page: Page, host: WorkspaceHost, evidence: PageEvidence): Promise<void> {
  await page.goto(hostConnectUrl(host), { waitUntil: 'domcontentloaded' })
  await page.getByTestId('workbench-root').waitFor({ state: 'visible' }).catch(async (error) => {
    throw new Error(`${error.message}; page errors: ${evidence.errors.map((error) => error.stack ?? error.message).join('; ')}; body: ${(await page.locator('body').innerText()).slice(0, 500)}`)
  })
  await page.getByTestId('workbench-main').waitFor({ state: 'visible' })
  await waitFor(() => host.connectionCount() > 0, 'authenticated browser websocket')
  const pairing = await page.evaluate(() => ({
    hash: location.hash,
    search: location.search,
    tokenStored: Boolean(sessionStorage.getItem('heddlework.token')),
    hostStored: Boolean(localStorage.getItem('heddlework.host')),
    workbenchWidth: document.querySelector('[data-testid="workbench-root"]')?.getBoundingClientRect().width ?? 0,
  }))
  assert(pairing.hash === '', 'Pairing fragment was not stripped from browser history')
  assert(pairing.search === '', 'Pairing credentials reached the query string')
  assert(pairing.tokenStored && pairing.hostStored, 'Pairing credentials were not retained in scoped storage')
  assert(pairing.workbenchWidth > 0, 'Shared WorkbenchApp mounted without a visible root')
  assert(evidence.requests.every((url) => !url.includes(host.token) && !new URL(url).searchParams.has('token')), 'Pairing token leaked into an HTTP request URL')
  assert(evidence.sockets.length === 1, `Expected one workspace websocket, received ${evidence.sockets.length}`)
  assert(evidence.sockets.every((url) => !url.includes(host.token) && new URL(url).search === ''), 'Websocket credentials leaked into its URL')
  assert(evidence.errors.length === 0, `Browser page error: ${evidence.errors[0]?.message ?? 'unknown error'}`)
}

async function closeContext(context: BrowserContext, host: WorkspaceHost): Promise<void> {
  await context.close()
  await waitFor(() => host.connectionCount() === 0, 'browser websocket cleanup')
}

async function desktopSmoke(browser: Awaited<ReturnType<typeof chromium.launch>>, host: WorkspaceHost): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1_440, height: 900 } })
  try {
    const page = await context.newPage()
    const evidence = observe(page)
    await pair(page, host, evidence)
    const rootBox = await page.getByTestId('workbench-root').boundingBox()
    assert(rootBox && rootBox.width >= 1_400 && rootBox.height >= 850, 'Desktop viewport did not reach the shared workbench')
    assert(await page.getByTestId('chat-project-crumb').isVisible(), 'Desktop workbench did not render desktop navigation')
    await page.getByTestId('thinking-picker').click()
    await page.getByTestId('thinking-picker-content').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.getByTestId('thinking-picker-content').waitFor({ state: 'hidden' })
    assert(evidence.errors.length === 0, 'Shared GPUix picker failed through the DOM renderer')
  } finally {
    await closeContext(context, host)
  }
}

async function expectWrite(backend: RecordingPtyBackend, checkpoint: number, expected: string, label: string): Promise<void> {
  await waitFor(() => backend.textSince(checkpoint).includes(expected), label).catch((error) => {
    throw new Error(`${error.message}; expected ${JSON.stringify(expected)}, received ${JSON.stringify(backend.textSince(checkpoint))}`)
  })
}

async function expectTerminalText(page: Page, terminals: TerminalSessionService, id: string, expected: string): Promise<void> {
  await waitFor(() => terminals.grid(id)?.viewport.some((row) => row.text.includes(expected)) === true, `PTY output ${JSON.stringify(expected)}`)
  await page.waitForFunction((text) => document.querySelector('[data-testid="terminal-grid"]')?.textContent?.includes(text), expected)
}

async function mobileTerminalSmoke(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  host: WorkspaceHost,
  terminals: TerminalSessionService,
  backend: RecordingPtyBackend,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  })
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: host.url })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    const evidence = observe(page)
    await pair(page, host, evidence)
    assert(!(await page.getByTestId('chat-project-crumb').isVisible()), 'Mobile workbench retained desktop-only navigation')

    const terminalToggle = page.getByTestId('toggle-terminal')
    const toggleBox = await terminalToggle.boundingBox()
    assert(toggleBox && toggleBox.width > 0 && toggleBox.height > 0 && toggleBox.x >= 0 && toggleBox.x + toggleBox.width <= 390, 'Mobile terminal control is not an on-screen touch target')
    await terminalToggle.tap()
    await Bun.sleep(500)
    assert(evidence.errors.length === 0, `Opening the mobile terminal crashed the workbench: ${evidence.errors[0]?.message ?? 'unknown error'}`)
    await waitFor(() => terminals.getStateSnapshot().sessions.length === 1, 'browser-created terminal session')
    const sessionId = terminals.getStateSnapshot().sessions[0]!.id
    await waitFor(() => (terminals.getStateSnapshot().sessions[0]?.cols ?? 80) < 80, 'initial mobile terminal resize after spawn acknowledgement')
    const input = page.getByTestId('terminal-input-bottom')
    await input.waitFor({ state: 'visible' })
    await input.tap()
    const inputSemantics = await input.evaluate((element) => ({
      contentEditable: element.getAttribute('contenteditable'),
      inputMode: element.getAttribute('inputmode'),
      spellCheck: element.getAttribute('spellcheck'),
      autoCorrect: element.getAttribute('autocorrect'),
      autoCapitalize: element.getAttribute('autocapitalize'),
      role: element.getAttribute('role'),
      focused: document.activeElement === element,
    }))
    assert(inputSemantics.contentEditable === 'true' && inputSemantics.inputMode === 'text' && inputSemantics.role === 'textbox', 'Terminal is not exposed as a software-keyboard text target')
    assert(inputSemantics.focused, 'Touching the terminal did not focus its software-keyboard target')
    assert(inputSemantics.spellCheck === 'false' && inputSemantics.autoCorrect === 'off' && inputSemantics.autoCapitalize === 'none', 'Terminal allows browser spelling or case corrections')

    let checkpoint = backend.writes.length
    await page.keyboard.type('printf TYPE_NO')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('OK')
    await page.keyboard.press('Enter')
    await expectWrite(backend, checkpoint, `printf TYPE_NO\x7f\x7fOK\r`, 'typed text, backspace, and enter bytes')
    await expectTerminalText(page, terminals, sessionId, 'TYPE_OK')
    assert(backend.textSince(checkpoint) === 'printf TYPE_NO\x7f\x7fOK\r', 'Typing duplicated or dropped input bytes')

    checkpoint = backend.writes.length
    await input.tap()
    await page.keyboard.press('Tab')
    await expectWrite(backend, checkpoint, '\t', 'terminal tab byte')
    assert(await input.evaluate((element) => document.activeElement === element), 'Tab moved focus outside the terminal')

    checkpoint = backend.writes.length
    await input.tap()
    await page.keyboard.type('sleep 30')
    await page.keyboard.press('Enter')
    await Bun.sleep(100)
    await page.keyboard.press('Control+C')
    await expectWrite(backend, checkpoint, `sleep 30\r\x03`, 'terminal ctrl-c byte')
    await input.tap()
    await page.keyboard.type("printf '\\nCTRL_OK\\n'")
    await page.keyboard.press('Enter')
    await expectTerminalText(page, terminals, sessionId, 'CTRL_OK')

    checkpoint = backend.writes.length
    await page.evaluate((text) => navigator.clipboard.writeText(text), "printf '\\nPASTE_OK\\n'")
    await input.tap()
    await page.keyboard.press('ControlOrMeta+V')
    await Bun.sleep(100)
    await page.keyboard.press('Enter')
    const bracketedPaste = terminals.grid(sessionId)?.bracketedPaste === true
    const pasteText = "printf '\\nPASTE_OK\\n'"
    await expectWrite(backend, checkpoint, bracketedPaste ? `\x1b[200~${pasteText}\x1b[201~` : pasteText, 'clipboard paste bytes')
    await expectTerminalText(page, terminals, sessionId, 'PASTE_OK')

    checkpoint = backend.writes.length
    await input.evaluate((element) => {
      const input = (inputType: string, data: string | null = null) => element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data }))
      input('insertText', "printf '\\nSOFT_NO")
      input('deleteContentBackward')
      input('deleteContentBackward')
      input('insertText', "OK\\n'")
      input('insertParagraph')
    })
    await expectWrite(backend, checkpoint, "printf '\\nSOFT_NO\x7f\x7fOK\\n'\r", 'software-keyboard text, deletion, and enter bytes')
    await expectTerminalText(page, terminals, sessionId, 'SOFT_OK')

    checkpoint = backend.writes.length
    await input.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: "printf '\\nCOMPOSE_OK\\n'" }))
    })
    await page.keyboard.press('Enter')
    await expectWrite(backend, checkpoint, "printf '\\nCOMPOSE_OK\\n'\r", 'composition input bytes')
    await expectTerminalText(page, terminals, sessionId, 'COMPOSE_OK')

    checkpoint = backend.writes.length
    await input.evaluate((element) => {
      for (const order of ['before-empty', 'end-first', 'before-full'] as const) {
        const data = `printf '\\nIME_${order}_OK\\n'`
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
        if (order === 'end-first') element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data }))
        const commit = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromComposition', data, isComposing: order !== 'end-first' })
        // Chromium's constructor normalizes this WebKit input type to empty.
        if (commit.inputType !== 'insertFromComposition') Object.defineProperty(commit, 'inputType', { value: 'insertFromComposition' })
        element.dispatchEvent(commit)
        if (order !== 'end-first') element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: order === 'before-empty' ? '' : data }))
        element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' }))
      }
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      element.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'DO_NOT_SEND' }))
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
      element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: 'DO_NOT_APPEND' }))
    })
    await expectWrite(backend, checkpoint, ['before-empty', 'end-first', 'before-full'].map((order) => `printf '\\nIME_${order}_OK\\n'\r`).join(''), 'exactly-once IME commits, cancellation, and correction suppression')
    await expectTerminalText(page, terminals, sessionId, 'IME_before-full_OK')

    const composer = page.getByTestId('composer')
    await composer.focus()
    const idleResizeCount = backend.resizes.length
    terminals.write(sessionId, "printf '\\nBACKGROUND_OK\\n'\r")
    await expectTerminalText(page, terminals, sessionId, 'BACKGROUND_OK')
    assert(await composer.evaluate((element) => document.activeElement === element), 'Background terminal output stole composer focus')
    assert(backend.resizes.length === idleResizeCount, 'Terminal frames retriggered resize without a layout or ownership change')

    const mobileSize = terminals.getStateSnapshot().sessions.find((session) => session.id === sessionId)
    assert(mobileSize, 'Terminal session disappeared before resize')
    const resizeCheckpoint = backend.resizes.length
    await page.setViewportSize({ width: 1_280, height: 900 })
    await waitFor(() => {
      const current = terminals.getStateSnapshot().sessions.find((session) => session.id === sessionId)
      return Boolean(current && (current.cols !== mobileSize.cols || current.rows !== mobileSize.rows))
    }, 'terminal PTY resize after viewport change')
    assert(backend.resizes.length > resizeCheckpoint, 'Responsive viewport resize did not reach the real PTY')
    assert(await page.getByTestId('chat-project-crumb').isVisible(), 'Resized workbench did not enter desktop layout')

    await page.locator('[data-testid^="terminal-tab-close-"]').first().click()
    await waitFor(() => terminals.getStateSnapshot().sessions.length === 0, 'terminal session close')
    assert(backend.kills === 1, `Closing the terminal killed ${backend.kills} PTYs instead of one`)
    await page.getByTestId('close-terminal-dock').click()
    await page.getByTestId('terminal-dock').waitFor({ state: 'hidden' })
    assert(evidence.errors.length === 0, `Browser page error: ${evidence.errors[0]?.message ?? 'unknown error'}`)
  } finally {
    await closeContext(context, host)
  }
}

async function run(): Promise<void> {
  assert(existsSync(resolve(staticRoot, 'main.js')) && existsSync(resolve(staticRoot, 'index.html')), 'Missing dist/web build; run bun run build:web first')
  assert(typeof Bun.Terminal === 'function', 'Bun.Terminal is unavailable; a real PTY is required')

  const backend = new RecordingPtyBackend()
  const terminals = new TerminalSessionService({ cwd: root, backend, appearancePath: false })
  const transport = new DemoTransport()
  const controller = new WorkbenchController(transport, root, controllerDependencies())
  const flows = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
  let host: WorkspaceHost | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        await controller.start()
        host = createWorkspaceHost({
          controller,
          flows,
          terminals,
          workspacePath: root,
          hostname: '127.0.0.1',
          port: 0,
          token: generateHostToken(),
          staticRoot,
        })
        const executablePath = process.env.HEDDLEWORK_CHROMIUM_EXECUTABLE?.trim()
        browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
        await desktopSmoke(browser, host)
        await mobileTerminalSmoke(browser, host, terminals, backend)
        console.log('browser probe passed: desktop mount/pairing; mobile touch terminal input, paste, composition, resize, and close')
        console.log('note: Chromium validates the contenteditable/inputmode/composition path, not a real iOS software keyboard')
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Browser probe exceeded ${probeTimeoutMs}ms`)), probeTimeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    await browser?.close()
    await host?.close()
    flows.dispose()
    await terminals.dispose()
    await controller.dispose()
  }
}

await run()
