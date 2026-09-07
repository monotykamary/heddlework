import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { PortalPickResult } from './portal-file-chooser.ts'
import { runDesktopCommand } from '../linux/process.ts'

export async function runDirectoryPicker(picker: DirectoryPickerCommand, signal?: AbortSignal): Promise<PortalPickResult> {
  const result = await runDesktopCommand(picker.command, picker.args, { signal })
  if (!result) return { status: 'unavailable' }
  if (result.code === 1 && (picker.command === 'zenity' || picker.command === 'kdialog')) return { status: 'cancelled' }
  if (result.code !== 0) return { status: 'unavailable' }
  return result.stdout.trim() ? { status: 'selected', path: resolve(result.stdout.trim()) } : { status: 'cancelled' }
}

export interface DirectoryPickerCommand {
  command: string
  args: string[]
}

export function openExternal(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
  openSystemTarget(parsed.href)
}

export function openPath(path: string): void {
  openSystemTarget(resolve(path))
}

export function directoryPickerCommand(platform: NodeJS.Platform = process.platform): DirectoryPickerCommand | undefined {
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/osascript',
      args: ['-e', 'try\nPOSIX path of (choose folder with prompt "Open project in Heddlework")\non error message number code\nif code is -128 then\nreturn ""\nelse\nerror message number code\nend if\nend try'],
    }
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Open project in Heddlework"',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath } else { exit 0 }',
    ].join('; ')
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
  }
  return { command: 'zenity', args: ['--file-selection', '--directory', '--title=Open project in Heddlework'] }
}

export interface WorkspaceDirectoryPick {
  path?: string
  error?: string
}

export function directoryPickerCommands(platform: NodeJS.Platform = process.platform): DirectoryPickerCommand[] {
  const primary = directoryPickerCommand(platform)
  if (!primary) return []
  if (platform === 'darwin' || platform === 'win32') return [primary]
  const fallbacks = [
    {
      command: 'kdialog',
      args: ['--getexistingdirectory', homedir(), '--title', 'Open project in Heddlework'],
    },
  ]
  return [primary, ...fallbacks]
}

export async function pickWorkspaceDirectory(signal?: AbortSignal): Promise<WorkspaceDirectoryPick> {
  if (process.platform === 'linux') return { error: 'Linux desktop integration is not configured' }
  for (const picker of directoryPickerCommands()) {
    const result = await runDirectoryPicker(picker, signal)
    if (result.status !== 'unavailable') return result.path ? { path: result.path } : {}
  }
  return { error: 'No folder picker is available on this system' }
}

export function systemTargetCommand(target: string, platform: NodeJS.Platform = process.platform): DirectoryPickerCommand {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [target] }
  if (platform === 'win32') return { command: 'explorer.exe', args: [target] }
  return { command: 'xdg-open', args: [target] }
}

function openSystemTarget(target: string): void {
  const launch = systemTargetCommand(target)
  try {
    const child = spawn(launch.command, launch.args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // External launch failures are non-fatal and leave the current surface open.
  }
}
