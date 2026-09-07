export type SystemAppearanceEvent =
  | { status: 'available'; preference: 'none' | 'light' | 'dark' }
  | { status: 'unavailable'; reason: string }

export interface SystemAppearanceSubscription {
  dispose(): void
}

export type SubscribeSystemAppearance = (
  listener: (event: SystemAppearanceEvent) => void,
) => SystemAppearanceSubscription

/** Feature detection is separate from portal availability, reported by events. */
export function nativeAppearanceAdapter(binding: {
  subscribeSystemAppearance?: SubscribeSystemAppearance
}): SubscribeSystemAppearance | undefined {
  const subscribe = binding.subscribeSystemAppearance
  if (typeof subscribe !== 'function') return undefined
  return listener => {
    let disposed = false
    const subscription = subscribe(event => {
      if (!disposed) listener(event)
    })
    return {
      dispose() {
        if (disposed) return
        disposed = true
        subscription.dispose()
      },
    }
  }
}
