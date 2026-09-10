// Builds gpuix EventPayload objects from DOM events so src/ui handlers read the same fields on both hosts.

import type { EventPayload } from '@gpuix/react'

// Optional payload fields may be absent but never explicitly undefined under exactOptionalPropertyTypes.
export type PayloadExtra = { [K in keyof EventPayload]?: EventPayload[K] | undefined }

export function compactPayload(base: Pick<EventPayload, 'elementId' | 'eventType'>, extra: PayloadExtra): EventPayload {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) out[key] = value
  return out as unknown as EventPayload
}

export function modifiers(event: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): EventPayload['modifiers'] {
  return { shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, cmd: event.metaKey }
}

const KEY_NAMES: Record<string, string> = {
  ArrowDown: 'down', ArrowUp: 'up', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', Escape: 'escape',
  Backspace: 'backspace', Delete: 'delete', Tab: 'tab', ' ': 'space', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
}

export function keyName(event: KeyboardEvent | React.KeyboardEvent): string {
  const key = event.key
  return KEY_NAMES[key] ?? (key.length === 1 ? key.toLowerCase() : key.toLowerCase())
}

export function mousePayload(elementId: number, eventType: string, event: MouseEvent | React.MouseEvent, extra: PayloadExtra = {}): EventPayload {
  return compactPayload({ elementId, eventType }, {
    x: event.clientX,
    y: event.clientY,
    button: event.button,
    clickCount: 'detail' in event && typeof event.detail === 'number' ? Math.max(1, event.detail) : 1,
    isRightClick: event.button === 2,
    modifiers: modifiers(event),
    ...extra,
  })
}

export function keyPayload(elementId: number, eventType: string, event: KeyboardEvent | React.KeyboardEvent): EventPayload {
  const name = keyName(event)
  return compactPayload({ elementId, eventType }, {
    key: name,
    keyChar: event.key.length === 1 ? event.key : name === 'tab' ? '\t' : name === 'enter' ? '\n' : undefined,
    isHeld: event.repeat,
    modifiers: modifiers(event),
  })
}

export function plainPayload(elementId: number, eventType: string, extra: PayloadExtra = {}): EventPayload {
  return compactPayload({ elementId, eventType }, extra)
}
