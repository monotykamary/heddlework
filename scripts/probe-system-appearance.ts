// Run: dbus-run-session -- bun scripts/probe-system-appearance.ts /path/to/addon.node
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { SubscribeSystemAppearance, SystemAppearanceEvent } from '../src/linux/native-appearance.ts'

const addon = resolve(process.argv[2] ?? '')
assert(process.argv[2], 'Pass the rebuilt addon path explicitly')
const { subscribeSystemAppearance: subscribe } = createRequire(import.meta.url)(addon) as {
  subscribeSystemAppearance: SubscribeSystemAppearance
}
assert.equal(typeof subscribe, 'function')
const fixture = Bun.spawn(['/usr/bin/python3', resolve(import.meta.dir, 'fixtures/appearance-portal.py')], { stdout: 'pipe', stderr: 'inherit' })
const reader = fixture.stdout.getReader()
const handles: Array<{ dispose(): void }> = []
async function wait(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10)
  assert(predicate(), label)
}
async function control(method: string, ...args: string[]) {
  const child = Bun.spawn(['gdbus', 'call', '--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/org/freedesktop/portal/desktop', '--method', `org.heddlework.AppearanceTest.${method}`, ...args], { stdout: 'pipe', stderr: 'pipe' })
  assert.equal(await child.exited, 0, await new Response(child.stderr).text())
}
function observe() {
  const events: SystemAppearanceEvent[] = []
  let returned = false
  const handle = subscribe(event => { assert(returned, 'synchronous callback'); events.push(event) })
  returned = true
  handles.push(handle)
  return { events, handle }
}
try {
  const ready = await reader.read()
  assert(new TextDecoder().decode(ready.value).includes('READY'))
  // Cancellation before async setup and after an event has been queued.
  for (let index = 0; index < 20; index++) {
    const cancelled = observe()
    cancelled.handle.dispose()
    cancelled.handle.dispose()
    await Bun.sleep(5)
    assert.equal(cancelled.events.length, 0, 'dispose during initialization')
  }
  const queued = observe()
  // Block JS while the native worker can enqueue its initial event.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  queued.handle.dispose()
  await Bun.sleep(50)
  assert.equal(queued.events.length, 0, 'queued delivery after disposal')
  let selfCalls = 0
  const self = subscribe(() => { selfCalls++; self.dispose() })
  handles.push(self)
  await wait(() => selfCalls === 1, 'listener self-disposal')
  await control('Set', '1')
  await Bun.sleep(50)
  assert.equal(selfCalls, 1, 'listener removed during delivery')
  await control('Set', '0')
  // A live weak callback must neither retain a process nor crash env teardown.
  const teardown = Bun.spawn([process.execPath, '-e', `const addon = require(${JSON.stringify(addon)}); globalThis.subscription = addon.subscribeSystemAppearance(() => {}); setTimeout(() => {}, 100)`], { stdout: 'pipe', stderr: 'pipe' })
  await wait(() => teardown.exitCode !== null, 'environment teardown retained process')
  assert.equal(await teardown.exited, 0, await new Response(teardown.stderr).text())
  const first = observe()
  await wait(() => first.events.length === 1, 'initial event')
  assert.deepEqual(first.events[0], { status: 'available', preference: 'none' })
  for (const [raw, preference] of [[1, 'dark'], [2, 'light'], [99, 'none']] as const) {
    const count = first.events.length
    await control('Set', String(raw))
    await wait(() => first.events.length > count, `change ${raw}`)
    assert.deepEqual(first.events.at(-1), { status: 'available', preference })
  }
  const count = first.events.length
  await control('Set', '0')
  await Bun.sleep(50)
  assert.equal(first.events.length, count, 'duplicate preference')
  first.handle.dispose()
  await control('Set', '1')
  await Bun.sleep(50)
  assert.equal(first.events.length, count, 'delivery after disposal')
  await control('Race', '2')
  const race = observe()
  await wait(() => race.events.length > 0, 'read/change race')
  assert.deepEqual(race.events[0], { status: 'available', preference: 'light' })
  race.handle.dispose()
  const invalid = observe()
  await wait(() => invalid.events.length > 0, 'invalid-data setup')
  await control('Invalid')
  await wait(() => invalid.events.some(event => event.status === 'unavailable'), 'invalid data failure')
  invalid.handle.dispose()
  const lost = observe()
  await wait(() => lost.events.length > 0, 'disconnect setup')
  await control('Release')
  await wait(() => lost.events.some(event => event.status === 'unavailable'), 'portal owner loss must terminate subscription')
  console.log(`PASS actual addon lifecycle: ${addon}`)
} finally {
  for (const handle of handles) { handle.dispose(); handle.dispose() }
  fixture.kill()
  await fixture.exited
  reader.releaseLock()
}
