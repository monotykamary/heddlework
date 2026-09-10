import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundedServerFrames, createWorkspaceHost, hostConnectUrl, ServerMessageSendQueue, type WorkspaceHost } from '../src/host/server.ts'
import { generateHostToken } from '../src/host/token.ts'
import { hostOptionsFromEnvironment } from '../src/host/plugin.ts'
import { createInitialState, type WorkbenchState } from '../src/workbench/state.ts'
import type { WorkbenchController } from '../src/workbench/controller.ts'
import type { FlowRuntime } from '../src/flows/runtime.ts'
import { WorkspaceClient } from '../src/web/client.ts'
import { MemoryTerminalBackend } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import { RemoteTerminalService } from '../src/client/remote-terminal-service.ts'
import { FrameAssembler, utf8ByteLength } from '../src/protocol/frames.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function doubles(initial: Partial<WorkbenchState> = {}) { let state: WorkbenchState = { ...createInitialState('/workspace'), connection: 'connected', ...initial }; const listeners = new Set<() => void>(); const controller = { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }, setEditorText: (text: string) => { state = { ...state, editorText: text }; for (const listener of listeners) listener() }, loadEarlierMessages: async () => {} } as unknown as WorkbenchController; const flows = { getSnapshot: () => ({ schedules: [], pending: [] }), subscribe: () => () => {} } as unknown as FlowRuntime; return { controller, flows, state: () => state } }
async function waitFor(check: () => boolean, label: string, timeout = 5_000) { const end = Date.now() + timeout; while (Date.now() < end) { if (check()) return; await Bun.sleep(10) }; throw new Error(`Timed out waiting for ${label}`) }

describe('authenticated workspace host', () => {
 it('is loopback/off by default and requires explicit network exposure', () => { expect(hostOptionsFromEnvironment({})).toMatchObject({ enabled: false, hostname: '127.0.0.1', allowNetwork: false }); const { controller, flows } = doubles(); expect(() => createWorkspaceHost({ controller, flows, workspacePath: '/workspace', port: 0, hostname: '0.0.0.0', token: generateHostToken() })).toThrow(/ALLOW_NETWORK/) })
 it('protects origins, pairing data, static assets, and symlink escapes', async () => { const root = mkdtempSync(join(tmpdir(), 'heddlework-web-')); const outside = join(root, '..', `secret-${crypto.randomUUID()}.txt`); writeFileSync(join(root, 'index.html'), '<h1>shell</h1>'); writeFileSync(outside, 'private'); symlinkSync(outside, join(root, 'escape.txt')); cleanups.push(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { force: true }) }); const { controller, flows } = doubles(); const host = createWorkspaceHost({ controller, flows, workspacePath: '/private/workspace', port: 0, token: generateHostToken(), staticRoot: root }); cleanups.push(() => host.close()); const health = await fetch(`${host.url}/health`); expect(await health.text()).not.toContain('/private/workspace'); expect(health.headers.get('referrer-policy')).toBe('no-referrer'); expect((await fetch(`${host.url}/escape.txt`)).status).toBe(403); const missingAsset = await fetch(`${host.url}/main.js`); expect(missingAsset.status).toBe(404); expect(missingAsset.headers.get('cache-control')).toBe('no-store'); writeFileSync(join(root, 'main.js'), 'globalThis.restored = true'); const restoredAsset = await fetch(`${host.url}/main.js`); expect(restoredAsset.status).toBe(200); expect(restoredAsset.headers.get('content-type')).toContain('text/javascript'); expect(await restoredAsset.text()).toContain('restored'); const route = await fetch(`${host.url}/session/current`, { headers: { accept: 'text/html' } }); expect(route.status).toBe(200); expect(await route.text()).toContain('shell'); expect((await fetch(`${host.url}/ws?token=${host.token}`, { headers: { origin: 'https://evil.example' } })).status).toBe(403); expect((await fetch(`${host.url}/ws?token=wrong`)).status).toBe(401); expect((await fetch(`${host.url}/ws?token=${host.token}`)).status).toBe(401); expect((await fetch(`${host.url}/ws?token=wrong`, { headers: { authorization: `Bearer ${host.token}` } })).status).toBe(426); expect(hostConnectUrl(host)).toContain('#token='); expect(hostConnectUrl(host)).not.toContain('?token=') })
 it('applies authenticated websocket commands and streams stable patches', async () => { const fixture = doubles(); const host = createWorkspaceHost({ controller: fixture.controller, flows: fixture.flows, workspacePath: '/workspace', port: 0, token: generateHostToken() }); cleanups.push(() => host.close()); const client = new WorkspaceClient(); cleanups.push(() => client.disconnect()); client.connect(host.url, host.token); await waitFor(() => client.getSnapshot().status === 'open', 'client welcome'); await client.send({ type: 'setEditorText', text: 'remote edit' }); await waitFor(() => client.getSnapshot().state?.editorText === 'remote edit', 'snapshot patch'); expect(fixture.state().editorText).toBe('remote edit') })
 it('streams one message larger than the socket buffer without interleaving frames', () => {
   let buffered = 0
   let maxBuffered = 0
   const sent: string[] = []
   const closes: Array<[number | undefined, string | undefined]> = []
   const queue = new ServerMessageSendQueue({
     getBufferedAmount: () => buffered,
     send: (frame) => { sent.push(frame); buffered += utf8ByteLength(frame); maxBuffered = Math.max(maxBuffered, buffered); return buffered >= 768 ? -1 : utf8ByteLength(frame) },
     close: (code, reason) => { closes.push([code, reason]) },
   }, { maxBufferedBytes: 1_024, maxQueuedBytes: 1_024, maxFrameBytes: 512, messageLifetimeMs: 10_000 })
   const message = { kind: 'error', message: 'x'.repeat(4_096) } as const
   expect(boundedServerFrames(message, 512).length).toBeGreaterThan(1)
   queue.enqueue(message)
   for (let attempt = 0; queue.hasActiveMessage && attempt < 100; attempt += 1) { buffered = 0; queue.drain() }
   queue.dispose()
   const assembler = new FrameAssembler()
   let assembled: string | undefined
   for (const frame of sent) assembled = assembler.push(frame) ?? assembled
   expect(JSON.parse(assembled!)).toEqual(message)
   expect(maxBuffered).toBeLessThanOrEqual(1_024)
   expect(closes).toEqual([])
 })
 it('bounds queued messages and expires a stalled active message', () => {
   const cappedCloses: Array<[number | undefined, string | undefined]> = []
   const stalledSocket = { getBufferedAmount: () => 500, send: () => 1, close: (code?: number, reason?: string) => { cappedCloses.push([code, reason]) } }
   const capped = new ServerMessageSendQueue(stalledSocket, { maxBufferedBytes: 512, maxQueuedBytes: 128, maxFrameBytes: 512, messageLifetimeMs: 10_000 })
   capped.enqueue({ kind: 'pong' })
   capped.enqueue({ kind: 'error', message: 'x'.repeat(512) })
   expect(cappedCloses).toEqual([[1013, 'Client is too slow']])

   let now = 0
   const expiredCloses: Array<[number | undefined, string | undefined]> = []
   const expiring = new ServerMessageSendQueue({ getBufferedAmount: () => 500, send: () => 1, close: (code, reason) => { expiredCloses.push([code, reason]) } }, { maxBufferedBytes: 512, maxFrameBytes: 512, messageLifetimeMs: 100, now: () => now })
   expiring.enqueue({ kind: 'pong' })
   now = 101
   expiring.drain()
   expect(expiredCloses).toEqual([[1013, 'Client is too slow']])
 })
 it('delivers a large bounded tool output in a welcome snapshot larger than the 8 MiB socket budget', async () => { const toolOutput = 'x'.repeat(9 * 1024 * 1024); const fixture = doubles({ messages: [{ role: 'toolResult', toolCallId: 'large-output', toolName: 'read', content: toolOutput, timestamp: 1 }] }); const host = createWorkspaceHost({ controller: fixture.controller, flows: fixture.flows, workspacePath: '/workspace', port: 0, token: generateHostToken() }); cleanups.push(() => host.close()); const client = new WorkspaceClient(); cleanups.push(() => client.disconnect()); client.connect(host.url, host.token); await waitFor(() => client.getSnapshot().state?.messages.length === 1, 'large client welcome', 15_000); expect((client.getSnapshot().state?.messages[0] as { content?: string } | undefined)?.content?.length).toBe(toolOutput.length); expect(client.getSnapshot().status).toBe('open') })
})

describe('remote terminal service', () => {
 it('opens, resizes, writes, receives frames, and closes through the real host', async () => { const fixture = doubles(); const terminals = new TerminalSessionService({ cwd: '/workspace', backend: new MemoryTerminalBackend('ready\r\n'), appearancePath: false }); cleanups.push(() => terminals.dispose()); const host = createWorkspaceHost({ controller: fixture.controller, flows: fixture.flows, workspacePath: '/workspace', port: 0, token: generateHostToken(), terminals }); cleanups.push(() => host.close()); const client = new WorkspaceClient(); cleanups.push(() => client.disconnect()); client.connect(host.url, host.token); await waitFor(() => client.getSnapshot().status === 'open', 'terminal client'); const remote = new RemoteTerminalService(client); cleanups.push(() => remote.dispose()); const id = await remote.ensureSession('bottom', { cols: 42, rows: 10 }); await waitFor(() => remote.getStateSnapshot().sessions.some((session) => session.id === id), 'terminal state'); remote.write(id, 'hello'); await waitFor(() => remote.grid(id)?.viewport.some((row) => row.text.includes('hello')) === true, 'terminal frame'); expect(remote.grid(id)?.cols).toBe(42); await remote.close(id); await waitFor(() => !remote.getStateSnapshot().sessions.some((session) => session.id === id), 'terminal close') })
})
