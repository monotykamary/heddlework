import { expect, it } from 'bun:test'
import { nativeDirectoryPickerAdapter, type DirectoryCleanupOutcome, type NativeDirectoryResult } from '../src/linux/native-directory-picker.ts'

it('never opens a superseded replacement while prior cleanup is pending', async () => {
  const requests: Array<{ close: (outcome: DirectoryCleanupOutcome) => void; emit: (result: NativeDirectoryResult) => void }> = []
  const adapter = nativeDirectoryPickerAdapter({ openDirectoryDialog: (_renderer, _options, emit) => {
    let close!: (outcome: DirectoryCleanupOutcome) => void
    const closed = new Promise<DirectoryCleanupOutcome>(resolve => { close = resolve })
    requests.push({ close, emit })
    return { closed, dispose() {} }
  } }, () => ({}))!
  const first = adapter.pick(new AbortController().signal).catch(error => error)
  await Bun.sleep(0)
  const second = adapter.pick(new AbortController().signal).catch(error => error)
  const third = adapter.pick(new AbortController().signal)
  expect(await first).toMatchObject({ name: 'AbortError' })
  expect(await second).toMatchObject({ name: 'AbortError' })
  expect(requests).toHaveLength(1)
  requests[0]!.close('closed')
  await Bun.sleep(0)
  expect(requests).toHaveLength(2)
  requests[1]!.emit({ status: 'cancelled' })
  requests[1]!.close('closed')
  expect(await third).toEqual({ status: 'cancelled' })
  adapter.dispose()
})
