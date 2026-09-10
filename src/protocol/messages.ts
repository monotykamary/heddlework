import type { FlowRuntimeSnapshot } from '../flows/types.ts'
import { isWorkbenchCommand, type WorkbenchCommand } from './commands.ts'
import type { SnapshotPatch, WorkbenchSnapshot } from './snapshot.ts'
import type { RemoteTerminalFrame, RemoteTerminalSnapshot } from './terminal.ts'

export type ClientMessage =
  | { kind: 'hello'; protocol: number; clientId: string }
  | { kind: 'command'; id: string; command: WorkbenchCommand }
  | { kind: 'ping' }

export type ServerMessage =
  | { kind: 'welcome'; protocol: number; workspacePath: string; snapshot: WorkbenchSnapshot; flows: FlowRuntimeSnapshot; terminal?: RemoteTerminalSnapshot }
  | { kind: 'patch'; patch: SnapshotPatch }
  | { kind: 'flows'; snapshot: FlowRuntimeSnapshot }
  | { kind: 'terminal'; snapshot: RemoteTerminalSnapshot }
  | { kind: 'terminalFrame'; frame: RemoteTerminalFrame }
  | { kind: 'result'; id: string; ok: true; value?: unknown }
  | { kind: 'result'; id: string; ok: false; error: string }
  | { kind: 'error'; message: string }
  | { kind: 'pong' }

export function parseClientMessage(raw: unknown): ClientMessage | undefined {
  const value = parse(raw)
  if (!value) return undefined
  if (value.kind === 'hello' && Number.isSafeInteger(value.protocol) && boundedString(value.clientId, 128)) return { kind: 'hello', protocol: value.protocol as number, clientId: value.clientId }
  if (value.kind === 'command' && boundedString(value.id, 128) && isWorkbenchCommand(value.command)) return { kind: 'command', id: value.id, command: value.command }
  if (value.kind === 'ping' && Object.keys(value).length === 1) return { kind: 'ping' }
  return undefined
}

export function parseServerMessage(raw: unknown): ServerMessage | undefined {
  const value = parse(raw)
  if (!value) return undefined
  const kind = value.kind
  if (kind === 'welcome' || kind === 'patch' || kind === 'flows' || kind === 'terminal' || kind === 'terminalFrame' || kind === 'pong') return value as ServerMessage
  if (kind === 'error' && boundedString(value.message, 8_192)) return value as ServerMessage
  if (kind === 'result' && boundedString(value.id, 128) && typeof value.ok === 'boolean') return value as ServerMessage
  return undefined
}

function parse(raw: unknown): Record<string, unknown> | undefined {
  let value = raw
  if (typeof raw === 'string') { try { value = JSON.parse(raw) } catch { return undefined } }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function boundedString(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
