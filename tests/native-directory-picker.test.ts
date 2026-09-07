import { expect, it } from 'bun:test'
import { nativeDirectoryPickerAdapter, type NativeDirectoryResult, type DirectoryCleanupOutcome } from '../src/linux/native-directory-picker.ts'
import { LinuxDesktopIntegration } from '../src/linux/desktop-integration.ts'

function fixture() {
  const requests: Array<{ emit(value: NativeDirectoryResult): void; close(value: DirectoryCleanupOutcome): void; disposals: number }> = []
  const adapter = nativeDirectoryPickerAdapter({ openDirectoryDialog: (_renderer, _options, emit) => {
    let close!: (value: DirectoryCleanupOutcome) => void
    const closed = new Promise<DirectoryCleanupOutcome>(resolve => { close = resolve })
    const request = { emit, close, disposals: 0 }
    requests.push(request)
    return { closed, dispose() { request.disposals++ } }
  } }, () => ({}))!
  return { adapter, requests }
}

it('aborts a non-cooperative native picker and ignores its late selection', async () => {
  let complete!: (value: NativeDirectoryResult) => void
  let fallbacks = 0
  let disposals = 0
  const service = new LinuxDesktopIntegration({
    resolveAppearance: () => 'dark',
    nativeDirectoryPicker: {
      pick() { return new Promise(resolve => { complete = resolve }) },
      dispose() { disposals++ },
    },
    portal: async () => { fallbacks++; return { status: 'cancelled' } },
  })
  const snapshot = service.getSnapshot()
  const controller = new AbortController()
  const pending = service.pickDirectory(controller.signal).catch(error => error)
  controller.abort()
  const result = await Promise.race([pending, Bun.sleep(30).then(() => 'still pending')])
  expect(result).toMatchObject({ name: 'AbortError' })
  complete({ status: 'selected', path: '/late' })
  await pending
  expect(service.getSnapshot()).toBe(snapshot)
  expect(fallbacks).toBe(0)
  service.dispose()
  service.dispose()
  expect(disposals).toBe(1)
})

it('provider disposal aborts a pending native request without fallback', async () => {
  let signal: AbortSignal | undefined
  let disposals = 0
  const service = new LinuxDesktopIntegration({
    resolveAppearance: () => 'dark',
    nativeDirectoryPicker: {
      pick(active) { signal = active; return new Promise(() => {}) },
      dispose() { disposals++ },
    },
    portal: async () => { throw new Error('disposed picker must not fall back') },
  })
  const pending = service.pickDirectory().catch(error => error)
  service.dispose()
  service.dispose()
  expect(await pending).toMatchObject({ name: 'AbortError' })
  expect(signal?.aborted).toBe(true)
  expect(disposals).toBe(1)
})

for (const terminal of [
  { status: 'selected', path: '/native' },
  { status: 'cancelled' },
  { status: 'unavailable', reason: 'fixture', safeToFallback: true },
] satisfies NativeDirectoryResult[]) {
  for (const outcome of ['closed', 'uncertain'] as const) {
    it(`waits for autonomous cleanup after ${terminal.status}; cleanup ${outcome} controls delivery and fallback`, async () => {
      const { adapter, requests } = fixture()
      let fallbacks = 0
      let settled = false
      const service = new LinuxDesktopIntegration({
        resolveAppearance: () => 'dark',
        nativeDirectoryPicker: adapter,
        portal: async () => { fallbacks++; return { status: 'cancelled' } },
      })
      const pending = service.pickDirectory().then(result => { settled = true; return result })
      try {
        await Bun.sleep(0)
        requests[0]!.emit(terminal)
        await Bun.sleep(0)
        expect(settled).toBe(false)
        expect(fallbacks).toBe(0)
        expect(requests[0]!.disposals).toBe(0)
        // Native terminal cleanup must settle without waiting for JS disposal.
        requests[0]!.close(outcome)
        const result = await pending
        expect(result.status).toBe(outcome === 'uncertain' ? 'unavailable' : terminal.status === 'selected' ? 'selected' : 'cancelled')
        expect(fallbacks).toBe(outcome === 'closed' && terminal.status === 'unavailable' ? 1 : 0)
        expect(requests[0]!.disposals).toBe(1)
        if (outcome === 'uncertain') {
          expect((await service.pickDirectory()).status).toBe('unavailable')
          expect(requests).toHaveLength(1)
          expect(fallbacks).toBe(0)
        }
      } finally {
        service.dispose()
        await pending.catch(() => {})
      }
    })
  }
}

it('feature detects a missing native binding', () => {
  expect(nativeDirectoryPickerAdapter({}, () => ({}))).toBeUndefined()
})

it('waits for cleanup before opening a superseding request and fences late selection', async () => {
  const { adapter, requests } = fixture()
  const first = adapter.pick(new AbortController().signal)
  const rejected = first.catch(error => error)
  await Bun.sleep(0)
  const second = adapter.pick(new AbortController().signal)
  await Bun.sleep(0)
  expect(await rejected).toMatchObject({ name: 'AbortError' })
  expect(requests).toHaveLength(1)
  requests[0]!.emit({ status: 'selected', path: '/stale' })
  requests[0]!.close('closed')
  await Bun.sleep(0)
  expect(requests).toHaveLength(2)
  requests[1]!.emit({ status: 'selected', path: '/new' })
  requests[1]!.close('closed')
  expect(await second).toEqual({ status: 'selected', path: '/new' })
  adapter.dispose()
})

it('blocks all later opens when cancellation cleanup is uncertain', async () => {
  const { adapter, requests } = fixture()
  const abort = new AbortController()
  const first = adapter.pick(abort.signal).catch(error => error)
  await Bun.sleep(0)
  abort.abort()
  expect(await first).toMatchObject({ name: 'AbortError' })
  requests[0]!.close('uncertain')
  expect(await adapter.pick(new AbortController().signal)).toMatchObject({ status: 'unavailable', safeToFallback: false })
  expect(requests).toHaveLength(1)
  adapter.dispose()
})

it('native selection and cancellation never invoke CLI fallback', async () => {
  for (const result of [{ status: 'selected', path: '/native' }, { status: 'cancelled' }] as const) {
    const service = new LinuxDesktopIntegration({ resolveAppearance: () => 'dark', nativeDirectoryPicker: {
      async pick() { return result }, dispose() {},
    }, portal: async () => { throw new Error('unexpected portal child') }, dialog: async () => { throw new Error('unexpected dialog child') } })
    expect(await service.pickDirectory()).toEqual(result)
    expect(service.getSnapshot().pickerBackend).toBe('native-portal')
    service.dispose()
  }
})

it('falls back only after native unavailable with confirmed cleanup', async () => {
  for (const safeToFallback of [true, false]) {
    let calls = 0
    const service = new LinuxDesktopIntegration({ resolveAppearance: () => 'dark', nativeDirectoryPicker: {
      async pick() { return { status: 'unavailable', reason: 'fixture', safeToFallback } }, dispose() {},
    }, portal: async () => { calls++; return { status: 'cancelled' } } })
    expect((await service.pickDirectory()).status).toBe(safeToFallback ? 'cancelled' : 'unavailable')
    expect(calls).toBe(safeToFallback ? 1 : 0)
    service.dispose()
  }
})
