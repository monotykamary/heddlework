import { abortError, abortable, throwIfAborted } from './process.ts'

export type DirectoryCleanupOutcome = 'closed' | 'uncertain'
export type NativeDirectoryResult =
  | { status: 'selected'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: string; safeToFallback: boolean }

export interface NativeDirectoryRequest {
  /** Settles independently of result delivery; uncertainty blocks replacement and fallback. */
  readonly closed: Promise<DirectoryCleanupOutcome>
  dispose(): void
}
export type OpenDirectoryDialog = (
  renderer: unknown,
  options: { title?: string },
  listener: (result: NativeDirectoryResult) => void,
) => NativeDirectoryRequest

export interface NativeDirectoryPicker {
  pick(signal: AbortSignal): Promise<NativeDirectoryResult>
  dispose(): void
}

/** Serializes native requests through server-side cleanup, not just JS completion. */
export function nativeDirectoryPickerAdapter(
  binding: { openDirectoryDialog?: OpenDirectoryDialog },
  renderer: () => unknown,
): NativeDirectoryPicker | undefined {
  const open = binding.openDirectoryDialog
  if (typeof open !== 'function') return undefined
  let disposed = false
  let uncertain = false
  let active: AbortController | undefined
  let cleanup: Promise<void> = Promise.resolve()
  return {
    async pick(signal) {
      throwIfAborted(signal)
      if (disposed) throw abortError()
      active?.abort()
      const operation = new AbortController()
      active = operation
      const abort = () => operation.abort()
      signal.addEventListener('abort', abort, { once: true })
      let request: NativeDirectoryRequest | undefined
      let accepting = true
      try {
        await abortable(cleanup, operation.signal)
        throwIfAborted(operation.signal)
        if (uncertain) return { status: 'unavailable', reason: 'The previous folder dialog could not be confirmed closed. Restart the application before opening another.', safeToFallback: false }
        let complete!: (result: NativeDirectoryResult) => void
        const result = new Promise<NativeDirectoryResult>(resolve => { complete = resolve })
        try {
          request = open(renderer(), { title: 'Open project in Heddlework' }, value => {
            if (accepting && !operation.signal.aborted && !disposed) { accepting = false; complete(value) }
          })
        } catch {
          // A throwing binding may have started native work before failing.
          uncertain = true
          return { status: 'unavailable', reason: 'Native folder dialog initialization failed', safeToFallback: false }
        }
        cleanup = request.closed.then(outcome => { uncertain ||= outcome !== 'closed' }, () => { uncertain = true })
        const stop = () => { accepting = false; request!.dispose() }
        operation.signal.addEventListener('abort', stop, { once: true })
        try {
          throwIfAborted(operation.signal)
          const value = await abortable(result, operation.signal)
          await abortable(cleanup, operation.signal)
          if (uncertain) return { status: 'unavailable', reason: 'Native folder dialog cleanup could not be confirmed', safeToFallback: false }
          if (value.status === 'unavailable' && !value.safeToFallback) uncertain = true
          return value
        } finally { operation.signal.removeEventListener('abort', stop) }
      } finally {
        accepting = false
        request?.dispose()
        signal.removeEventListener('abort', abort)
        if (active === operation) active = undefined
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      active?.abort()
    },
  }
}
