export const LIVE_NOTIFY_INTERVAL_MS = 16
export const LIVE_STATE_KEYS = new Set(['liveAssistant', 'liveTools', 'activity'])

export function liveFieldsOnlyChanged(
  previous: object,
  next: object,
  liveKeys: ReadonlySet<string> = LIVE_STATE_KEYS,
): boolean {
  let sawLive = false
  const previousRecord = previous as Record<string, unknown>
  const nextRecord = next as Record<string, unknown>
  for (const key of new Set([...Object.keys(previousRecord), ...Object.keys(nextRecord)])) {
    if (previousRecord[key] === nextRecord[key]) continue
    if (!liveKeys.has(key)) return false
    sawLive = true
  }
  return sawLive
}

/** Trailing live-state batching adapted from 0xCUB3/heddlework 1e1239f. */
export class TrailingNotifier {
  #timer: ReturnType<typeof setTimeout> | undefined
  #pending = false
  #disposed = false

  constructor(
    private readonly emit: () => void,
    private readonly intervalMs = LIVE_NOTIFY_INTERVAL_MS,
  ) {}

  notify(immediate: boolean): void {
    if (this.#disposed) return
    if (immediate) {
      this.flush()
      return
    }
    this.#pending = true
    if (this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.flush()
    }, this.intervalMs)
    this.#timer.unref?.()
  }

  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (!this.#pending && this.#disposed) return
    this.#pending = false
    if (!this.#disposed) this.emit()
  }

  cancel(): void {
    this.#disposed = true
    this.#pending = false
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }
}
