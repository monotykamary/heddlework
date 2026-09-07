import { expect, it } from 'bun:test'
import { nativeAppearanceAdapter, type SystemAppearanceEvent } from '../src/linux/native-appearance.ts'

it('detects missing bindings independently of portal availability', () => {
  expect(nativeAppearanceAdapter({})).toBeUndefined()
})

it('fences queued callbacks and disposes the binding once', () => {
  let emit: ((event: SystemAppearanceEvent) => void) | undefined
  let disposals = 0
  const events: SystemAppearanceEvent[] = []
  const subscribe = nativeAppearanceAdapter({
    subscribeSystemAppearance(listener) {
      emit = listener
      return { dispose() { disposals++ } }
    },
  })!
  const subscription = subscribe(event => events.push(event))
  emit!({ status: 'available', preference: 'none' })
  subscription.dispose()
  subscription.dispose()
  emit!({ status: 'available', preference: 'dark' })
  expect(events).toEqual([{ status: 'available', preference: 'none' }])
  expect(disposals).toBe(1)
})
