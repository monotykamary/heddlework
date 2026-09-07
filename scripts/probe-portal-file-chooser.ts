// Run: dbus-run-session -- bun scripts/probe-portal-file-chooser.ts /path/to/rebuilt-addon.node
// Exercises the real native directory-chooser binding against a private-bus
// FileChooser portal. Requires a live Wayland/X11 display for window parenting,
// /usr/bin/python3 with PyGObject, and gdbus.
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

type DirectoryDialogResult = {
  status: 'selected' | 'cancelled' | 'unavailable'
  path?: string
  reason?: string
  safeToFallback?: boolean
}
type DirectoryDialogRequest = {
  closed: Promise<'closed' | 'uncertain'>
  dispose(): void
}

const addon = resolve(process.argv[2] ?? '')
assert(process.argv[2], 'Pass the rebuilt addon path explicitly')
const native = createRequire(import.meta.url)(addon) as {
  GpuixRenderer: new (eventCallback?: unknown) => {
    init(options?: unknown): void
    shutdown(): void
  }
  openDirectoryDialog: (
    renderer: unknown,
    options: { title?: string } | undefined | null,
    listener: (result: DirectoryDialogResult) => void,
  ) => DirectoryDialogRequest
}
assert.equal(typeof native.openDirectoryDialog, 'function')
const fixture = Bun.spawn(['/usr/bin/python3', resolve(import.meta.dir, 'fixtures/portal-file-chooser.py')], {
  stdout: 'pipe', stderr: 'inherit',
})
const reader = fixture.stdout.getReader()
// The fixture logs OpenFile/EMIT lines to stdout; an undrained pipe would
// block its GLib main loop mid-probe, so keep draining alongside the checks.
async function drainFixture() {
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const text = new TextDecoder().decode(chunk.value)
      if (text.includes('OPENFILE') || text.includes('EMIT')) console.log('[fixture]', text.trim())
    }
  } catch {}
}

async function wait(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 12000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10)
  assert(predicate(), label)
}
async function control(method: string, ...args: string[]) {
  const child = Bun.spawn(['gdbus', 'call', '--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/org/freedesktop/portal/desktop', '--method', `org.heddlework.FileChooserTest.${method}`, ...args], { stdout: 'pipe', stderr: 'pipe' })
  assert.equal(await child.exited, 0, await new Response(child.stderr).text())
}

function open() {
  const events: DirectoryDialogResult[] = []
  let returned = false
  const request = native.openDirectoryDialog(renderer, { title: 'Probe' }, (result) => {
    assert(returned, 'synchronous callback')
    events.push(result)
  })
  returned = true
  return { events, request }
}

const renderer = new native.GpuixRenderer()
renderer.init({ focus: false, show: false, nativeBrowserEnabled: false, title: 'Heddlework directory probe' })
try {
  const ready = await reader.read()
  assert(new TextDecoder().decode(ready.value).includes('READY'))
  drainFixture()

  // Selection with exactly one valid local URI.
  {
    const { events, request } = open()
    await control('Respond', '/org/freedesktop/portal/desktop/request/last', '0', "['file:///tmp/heddlework-probe']")
    await wait(() => events.length === 1, 'single selection')
    assert.deepEqual(events[0], { status: 'selected', path: '/tmp/heddlework-probe' })
    assert.equal(await request.closed, 'closed')
    // Mirror production: dispose a settled handle before opening the next one.
    request.dispose()
  }

  // A response emitted inside the opening-call interval is still observed.
  {
    await control('RespondEarly', '0', "['file:///early']")
    const { events, request } = open()
    await wait(() => events.length === 1, 'early response observed')
    assert.equal(events[0]!.path, '/early')
    assert.equal(await request.closed, 'closed')
  }

  // User cancellation never resolves to a selection.
  {
    const { events, request } = open()
    await control('Respond', '/org/freedesktop/portal/desktop/request/last', '1', '[]')
    await wait(() => events.length === 1, 'user cancellation')
    assert.deepEqual(events[0], { status: 'cancelled' })
    assert.equal(await request.closed, 'closed')
  }

  // Malformed payloads: zero or multiple selections, bad schemes, invalid escapes.
  for (const [label, uris] of [
    ['multiple selections', "['file:///a', 'file:///b']"],
    ['unsupported scheme', "['ftp:///a']"],
    ['invalid escape', "['file:///a%zz']"],
  ] as const) {
    const { events, request } = open()
    await control('Respond', '/org/freedesktop/portal/desktop/request/last', '0', uris)
    await wait(() => events.length === 1, label)
    assert.deepEqual(events[0], { status: 'unavailable', reason: events[0]!.reason, safeToFallback: true })
    assert.equal(await request.closed, 'closed')
  }

  // A response body with the wrong signature is unavailable, not a crash.
  {
    const { events, request } = open()
    await control('Malformed', '/org/freedesktop/portal/desktop/request/last')
    await wait(() => events.length === 1, 'malformed response body')
    assert.equal(events[0]!.status, 'unavailable')
    assert.equal(await request.closed, 'closed')
  }

  // A response for an uncorrelated path is ignored entirely.
  {
    const { events, request } = open()
    await control('RespondPath', '/org/freedesktop/portal/desktop/request/other/token', '0', "['file:///spoof']")
    await Bun.sleep(100)
    assert.equal(events.length, 0, 'uncorrelated response ignored')
    request.dispose()
    assert.equal(await request.closed, 'closed')
  }

  // Disposal closes the portal server-side; the close is confirmed.
  {
    const { events, request } = open()
    request.dispose()
    request.dispose()
    assert.equal(await request.closed, 'closed', 'disposal closes the dialog')
    assert.equal(events.length, 0, 'no result after disposal')
  }

  // A close the portal cannot confirm reports uncertainty.
  {
    await control('CloseMode', "'silent'")
    const { request } = open()
    request.dispose()
    assert.equal(await request.closed, 'uncertain', 'unconfirmed close is uncertain')
    await control('CloseMode', "'ok'")
  }

  // A close that the portal rejects reports uncertainty.
  {
    await control('CloseMode', "'denied'")
    const { request } = open()
    request.dispose()
    assert.equal(await request.closed, 'uncertain', 'rejected close is uncertain')
    await control('CloseMode', "'ok'")
  }

  // A close proving the request already ended is confirmed.
  {
    await control('CloseMode', "'gone'")
    const { request } = open()
    request.dispose()
    assert.equal(await request.closed, 'closed', 'close on a gone request is confirmed')
    await control('CloseMode', "'ok'")
  }

  // A listener that disposes the request during delivery must not crash.
  {
    let selfCalls = 0
    const request = native.openDirectoryDialog(renderer, { title: 'Probe' }, () => {
      selfCalls++
      request.dispose()
    })
    await control('Respond', '/org/freedesktop/portal/desktop/request/last', '0', "['file:///tmp/self']")
    await wait(() => selfCalls === 1, 'listener self-disposal during delivery')
    assert.equal(await request.closed, 'closed')
  }

  // Repeated disposal of a settled handle is harmless.
  {
    const { request } = open()
    request.dispose()
    assert.equal(await request.closed, 'closed')
    request.dispose()
  }

  // Portal-owner loss is a terminal transport failure with uncertain cleanup.
  // It runs last because releasing the name ends every later portal scenario.
  {
    const { events, request } = open()
    await control('Release')
    await wait(() => events.length === 1, 'owner loss reported')
    assert.equal(events[0]!.status, 'unavailable')
    assert.equal(events[0]!.safeToFallback, false)
    assert.equal(await request.closed, 'uncertain')
  }

  // A live handle must not retain the process through environment teardown.
  const teardown = Bun.spawn([process.execPath, '-e', `const addon = require(${JSON.stringify(addon)}); const r = new addon.GpuixRenderer(); r.init({ focus: false, show: false, nativeBrowserEnabled: false }); globalThis.request = addon.openDirectoryDialog(r, { title: 'teardown' }, () => {}); setTimeout(() => {}, 100)`], { stdout: 'pipe', stderr: 'pipe' })
  await wait(() => teardown.exitCode !== null, 'environment teardown retained process')
  assert.equal(await teardown.exitCode, 0, await new Response(teardown.stderr).text())
  console.log('portal-file-chooser probe passed')
} finally {
  fixture.kill()
}
