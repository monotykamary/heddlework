import type { TerminalSessionService } from '../terminal/service.ts'
export const TERMINAL_COMMAND_TYPES = ['openTerminal', 'writeTerminal', 'resizeTerminal', 'closeTerminal'] as const
export const MAX_TERMINAL_WRITE_CHARS = 8_192
export const MIN_TERMINAL_COLS = 2
export const MAX_TERMINAL_COLS = 240
export const MIN_TERMINAL_ROWS = 1
export const MAX_TERMINAL_ROWS = 80
export type TerminalCommand = { type: 'openTerminal'; cols?: number; rows?: number } | { type: 'writeTerminal'; id: string; data: string } | { type: 'resizeTerminal'; id: string; cols: number; rows: number } | { type: 'closeTerminal'; id: string }
export interface RemoteTerminalSession { id: string; name: string; title: string; cwd: string; cols: number; rows: number; status: 'running' | 'exited'; exitCode?: number | null }
export interface RemoteTerminalSnapshot { sessions: RemoteTerminalSession[]; activeId?: string }
export interface RemoteTerminalFrame { id: string; cols: number; rows: number; cursorX: number; cursorY: number; cursorVisible: boolean; applicationCursor: boolean; bracketedPaste: boolean; title: string; lines: string[] }
export function isTerminalCommand(value: unknown): value is TerminalCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as Record<string, unknown>; const id = typeof command.id === 'string' && command.id.length > 0 && command.id.length <= 128
  if (command.type === 'openTerminal') return optionalDimension(command.cols) && optionalDimension(command.rows)
  if (command.type === 'writeTerminal') return id && typeof command.data === 'string' && command.data.length > 0 && command.data.length <= MAX_TERMINAL_WRITE_CHARS
  if (command.type === 'resizeTerminal') return id && validDimension(command.cols) && validDimension(command.rows)
  return command.type === 'closeTerminal' && id
}
export async function applyTerminalCommand(terminals: TerminalSessionService, command: TerminalCommand): Promise<unknown> {
  if (command.type === 'openTerminal') return terminals.spawn({ cols: clamp(command.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS, 80), rows: clamp(command.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS, 24) })
  if (!terminals.getStateSnapshot().sessions.some((session) => session.id === command.id)) throw new Error('Unknown terminal')
  if (command.type === 'writeTerminal') { terminals.write(command.id, command.data); return }
  if (command.type === 'resizeTerminal') { terminals.resize(command.id, clamp(command.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS, 80), clamp(command.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS, 24)); return }
  return terminals.close(command.id)
}
function validDimension(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value) }
function optionalDimension(value: unknown): boolean { return value === undefined || validDimension(value) }
function clamp(value: unknown, min: number, max: number, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback }
