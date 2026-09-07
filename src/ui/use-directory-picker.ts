import { useEffect, useRef, useState } from 'react'
import type { pickWorkspaceDirectory } from './open-external.ts'

export function useDirectoryPicker(picker: typeof pickWorkspaceDirectory, controller: { notify(kind: 'error', message: string): void; switchWorkspace(path: string): Promise<unknown> }) {
  const active = useRef<AbortController | undefined>(undefined)
  const completion = useRef<(() => void) | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    // Only a replacement setup completes an aborted pick; unmount cleanup does not.
    const finishPrevious = completion.current
    completion.current = undefined
    finishPrevious?.()
    setPicking(false)
    return () => { active.current?.abort(); active.current = undefined }
  }, [picker, controller])
  const pick = async (onComplete?: () => void) => {
    if (active.current) return
    const operation = new AbortController()
    active.current = operation
    completion.current = onComplete
    setPicking(true)
    try {
      const result = await picker(operation.signal)
      if (operation.signal.aborted) return
      if (result.error) controller.notify('error', result.error)
      else if (result.path) await controller.switchWorkspace(result.path)
    } catch (error) {
      if (!operation.signal.aborted && (error as Error)?.name !== 'AbortError') controller.notify('error', String(error))
    } finally {
      if (active.current === operation) {
        active.current = undefined
        completion.current = undefined
        setPicking(false)
        onComplete?.()
      }
    }
  }
  return { picking, pick }
}
