import { describe, expect, it } from 'bun:test'
import {
  BROWSER_PLACEMENT_ACTIVE_POLL_MS,
  BROWSER_PLACEMENT_IDLE_POLL_MS,
  sampleBrowserPlacement,
} from '../src/ui/browser-placement.ts'

describe('browser surface placement polling', () => {
  it('backs off while stationary and resumes frame-rate polling when geometry changes', () => {
    const initial = sampleBrowserPlacement([10, 20, 640, 480], true, undefined)
    expect(initial.changed).toBe(true)
    expect(initial.nextDelayMs).toBe(BROWSER_PLACEMENT_ACTIVE_POLL_MS)

    const stationary = sampleBrowserPlacement([10, 20, 640, 480], true, initial.sample)
    expect(stationary.changed).toBe(false)
    expect(stationary.nextDelayMs).toBe(BROWSER_PLACEMENT_IDLE_POLL_MS)
    expect(stationary.sample).toBe(initial.sample)

    const moved = sampleBrowserPlacement([10, 20, 720, 480], true, stationary.sample)
    expect(moved.changed).toBe(true)
    expect(moved.nextDelayMs).toBe(BROWSER_PLACEMENT_ACTIVE_POLL_MS)
  })

  it('normalizes subpixel jitter and reacts immediately to visibility changes', () => {
    const initial = sampleBrowserPlacement([10.01, 20.01, 640.01, 480.01], true, undefined)
    const jitter = sampleBrowserPlacement([10.1, 20.1, 640.1, 480.1], true, initial.sample)
    expect(jitter.changed).toBe(false)

    const hidden = sampleBrowserPlacement([10.1, 20.1, 640.1, 480.1], false, jitter.sample)
    expect(hidden.changed).toBe(true)
    expect(hidden.sample?.visible).toBe(false)
  })
})
