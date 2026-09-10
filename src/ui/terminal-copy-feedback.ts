import type { TerminalCopy } from './terminal-view.tsx'

/**
 * WP-01 repair 2: terminal-local copy failure feedback.
 *
 * The terminal copy shortcut must report a failed clipboard write instead of
 * failing silently. This adapter is a narrow, renderer-free helper — not a
 * clipboard service and not a global notification system. It consumes the
 * boolean contract of `copyTextToClipboard`, converts every definite failure
 * (resolved `false`, synchronous throw, or rejected promise) into one generic
 * local error, and ignores stale completions so an older attempt can never
 * overwrite newer feedback. WP-02 will migrate the boolean contract to
 * classified outcomes; WP-08 will share result-to-message formatting.
 */

export const TERMINAL_COPY_FAILED_MESSAGE = "Couldn't copy visible terminal text. Try Copy again."

export type TerminalCopyFailureSink = (failure: string | undefined) => void

export interface TerminalCopyAction {
  /** Handled copy: resolves when the outcome has been consumed and reported. */
  readonly copy: (text: string) => Promise<void>
  /** Withdraws the action; pending completions can no longer publish state. */
  readonly dispose: () => void
}

export function createTerminalCopyAction(options: {
  readonly writer: TerminalCopy
  readonly onFailure: TerminalCopyFailureSink
}): TerminalCopyAction {
  const { writer, onFailure } = options
  let attempts = 0
  let disposed = false
  const copy = async (text: string): Promise<void> => {
    if (disposed) return
    const attempt = ++attempts
    // A new attempt clears the previous failure: repeating the Copy shortcut
    // is the local retry path.
    onFailure(undefined)
    try {
      const outcome = await writer(text)
      if (disposed || attempt !== attempts) return
      if (outcome === false) onFailure(TERMINAL_COPY_FAILED_MESSAGE)
    } catch {
      if (disposed || attempt !== attempts) return
      onFailure(TERMINAL_COPY_FAILED_MESSAGE)
    }
  }
  const dispose = () => {
    disposed = true
  }
  return { copy, dispose }
}
