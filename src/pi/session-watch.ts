import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'

export interface PiSessionWatchOptions {
  recursive?: boolean
  debounceMs?: number
  retryMs?: number
  watch?: typeof watch
}

/**
 * Watches one catalog root rather than every session file. The periodic stat only
 * repairs missing/replaced roots and unsupported native watches; it never scans
 * session contents.
 *
 * Adapted from 0xCUB3/heddlework db62554.
 */
export function watchPiSessions(
  directory: string,
  changed: () => void,
  options: PiSessionWatchOptions = {},
): () => void {
  let closed = false
  let watcher: FSWatcher | undefined
  let identity: string | undefined
  let probing = false
  let notification: ReturnType<typeof setTimeout> | undefined

  const notify = () => {
    if (closed) return
    if (notification) clearTimeout(notification)
    notification = setTimeout(() => {
      notification = undefined
      if (!closed) changed()
    }, options.debounceMs ?? 150)
    notification.unref?.()
  }

  const openWatcher = () => {
    if (closed || watcher) return
    try {
      const opened = (options.watch ?? watch)(directory, {
        recursive: options.recursive ?? true,
        persistent: false,
      }, (event, filename) => {
        if (!filename || String(filename).endsWith('.jsonl') || event === 'rename') notify()
      })
      watcher = opened
      // One trailing reconciliation closes the subscribe-to-watch gap without
      // turning the low-frequency identity probe into a polling catalog scan.
      notify()
      opened.on('error', () => {
        opened.close()
        if (watcher === opened) watcher = undefined
        notify()
      })
    } catch {
      // Existing roots with unsupported native watching still need a bounded
      // fallback refresh. Missing roots never reach this retry (stat fails).
      notify()
    }
  }

  const probe = async () => {
    if (closed || probing) return
    probing = true
    try {
      const info = await stat(directory)
      if (closed) return
      const nextIdentity = `${info.dev}:${info.ino}:${info.birthtimeMs}`
      if (identity !== undefined && nextIdentity !== identity) {
        watcher?.close()
        watcher = undefined
        notify()
      }
      identity = nextIdentity
      openWatcher()
    } catch {
      if (identity !== undefined) notify()
      identity = undefined
      watcher?.close()
      watcher = undefined
    } finally {
      probing = false
    }
  }

  // Existing roots attach synchronously, before subscribe() returns. The probe
  // then records identity and repairs replacement, disappearance, or failures.
  openWatcher()
  void probe()
  const retry = setInterval(() => { void probe() }, options.retryMs ?? 5_000)
  retry.unref?.()

  return () => {
    if (closed) return
    closed = true
    watcher?.close()
    if (notification) clearTimeout(notification)
    clearInterval(retry)
  }
}
