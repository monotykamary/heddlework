import { Window } from 'happy-dom'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createInitialState } from '../src/workbench/state.ts'
const window = new Window({ url: `http://localhost/#token=${'a'.repeat(43)}` })
window.document.body.innerHTML = '<div id="root"></div>'
const state = { ...createInitialState('/workspace/mobile'), connection: 'connected' as const, connectionMessage: 'Connected' }
class FakeWebSocket extends window.EventTarget {
  static readonly OPEN = 1; readyState = 0; bufferedAmount = 0
  constructor(readonly url: string) { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new window.Event('open')) }) }
  send(raw: string) { const message = JSON.parse(raw) as { kind: string }; if (message.kind === 'hello') queueMicrotask(() => this.dispatchEvent(new window.MessageEvent('message', { data: JSON.stringify({ kind: 'welcome', protocol: 2, workspacePath: '/workspace/mobile', snapshot: state, flows: { schedules: [], pending: [] }, terminal: { sessions: [] } }) }))) }
  close() { this.readyState = 3; this.dispatchEvent(new window.Event('close')) }
}
const globals = globalThis as unknown as Record<string, unknown>
Object.assign(globals, { window, document: window.document, navigator: window.navigator, location: window.location, history: window.history, localStorage: window.localStorage, sessionStorage: window.sessionStorage, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, MessageEvent: window.MessageEvent, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, InputEvent: window.InputEvent, MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver, getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), WebSocket: FakeWebSocket })
await import(`${pathToFileURL(resolve(import.meta.dir, '../dist/web/main.js')).href}?probe=${Date.now()}`)
for (let attempt = 0; attempt < 200 && !window.document.querySelector('[data-testid="workbench-root"]'); attempt += 1) await Bun.sleep(10)
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
assert(window.document.querySelector('[data-testid="workbench-root"]'), 'Shared WorkbenchApp did not mount')
assert(window.document.querySelector('[data-testid="workbench-main"]'), 'Workbench main surface did not mount')
assert(window.location.hash === '', 'Pairing fragment was not stripped')
assert(window.sessionStorage.getItem('heddlework.token') === 'a'.repeat(43), 'Pairing token was not retained for this tab')
assert(!window.document.documentElement.outerHTML.includes('windowdragregion'), 'Native drag props leaked into DOM')
console.log('web DOM probe passed')
process.exit(0)
