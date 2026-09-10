import type { AgentTransport } from '../pi/transport.ts'

// Feature flags a harness adapter declares so surfaces can hide controls the harness cannot honor.
export interface HarnessCapabilities {
  sessions: boolean
  sessionTree: boolean
  queueMirror: boolean
  models: boolean
  thinking: boolean
  compaction: boolean
  extensionUi: boolean
  fork: boolean
  export: boolean
}

// The application-facing harness contract. AgentTransport carries execution; the extra fields describe identity and reach.
export interface HarnessAdapter extends AgentTransport {
  readonly id: string
  readonly displayName: string
  readonly capabilities: HarnessCapabilities
}

export function describePiAdapter(): HarnessCapabilities {
  return {
    sessions: true,
    sessionTree: true,
    queueMirror: true,
    models: true,
    thinking: true,
    compaction: true,
    extensionUi: true,
    fork: true,
    export: true,
  }
}

export function isHarnessAdapter(value: unknown): value is HarnessAdapter {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<HarnessAdapter>
  return typeof candidate.id === 'string'
    && typeof candidate.displayName === 'string'
    && typeof candidate.capabilities === 'object'
    && candidate.capabilities !== null
    && typeof candidate.start === 'function'
    && typeof candidate.stop === 'function'
    && typeof candidate.request === 'function'
    && typeof candidate.send === 'function'
    && typeof candidate.onEvent === 'function'
    && typeof candidate.onStatus === 'function'
}
