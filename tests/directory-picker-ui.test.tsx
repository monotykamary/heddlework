import React from 'react'
import { describe, expect, it } from 'bun:test'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { useDirectoryPicker } from '../src/ui/use-directory-picker.ts'
import type { WorkspaceDirectoryPick } from '../src/ui/open-external.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('directory picker lifecycle', () => {
  it('completes a replaced operation once but suppresses completion after unmount', async () => {
    const root = createTestRoot()
    let hook: ReturnType<typeof useDirectoryPicker> | undefined
    const releases: Array<(value: WorkspaceDirectoryPick) => void> = []
    const signals: AbortSignal[] = []
    const pending = (signal?: AbortSignal) => {
      signals.push(signal!)
      return new Promise<WorkspaceDirectoryPick>(resolve => releases.push(resolve))
    }
    let switches = 0
    let completions = 0
    const controller = { notify() {}, async switchWorkspace() { switches++ } }
    function Probe({ picker }: { picker: typeof pending }) {
      hook = useDirectoryPicker(picker, controller)
      return <text>picker</text>
    }
    const until = async (ready: () => boolean) => {
      const deadline = Date.now() + 2000
      while (!ready() && Date.now() < deadline) {
        root.renderer.flush()
        await Bun.sleep(1)
      }
      expect(ready()).toBe(true)
    }
    root.render(<Probe picker={pending} />)
    await until(() => hook !== undefined)
    // Let the initial passive effect settle before starting an operation.
    root.renderer.flush()
    await Bun.sleep(0)
    const first = hook!.pick(() => { completions++ })
    root.render(<Probe picker={signal => pending(signal)} />)
    await until(() => signals[0]!.aborted && hook?.picking === false && completions === 1)
    expect(signals[0]!.aborted).toBe(true)
    expect(hook!.picking).toBe(false)
    expect(completions).toBe(1)
    releases[0]!({ path: '/stale' })
    await first
    expect(switches).toBe(0)
    expect(completions).toBe(1)
    const second = hook!.pick(() => { completions++ })
    root.render(<text>unmounted</text>)
    await until(() => signals[1]!.aborted)
    expect(signals[1]!.aborted).toBe(true)
    releases[1]!({ path: '/stale' })
    await second
    expect(switches).toBe(0)
    expect(completions).toBe(1)
  })
})
