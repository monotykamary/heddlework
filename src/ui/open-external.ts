import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { requestPortalDirectory } from './portal-file-chooser.ts'

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
      args: ['-e', 'POSIX path of (choose folder with prompt "Open project in Heddlework")'],
    }
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Open project in Heddlework"',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath } else { exit 1 }',
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

export async function pickWorkspaceDirectory(): Promise<WorkspaceDirectoryPick> {
  if (process.platform === 'linux') {
    const portal = await requestPortalDirectory()
    if (portal.status === 'cancelled' || portal.status === 'selected') {
      // A portal dismissal is a deliberate cancel and never pops a second
      // fallback dialog; only an unavailable warn degrades onward.
      return portal.path ? { path: portal.path } : {}
    }
    // Portal was unavailable or unresponsive; degrade through zenity/kdialog.
  }
  const pickers = directoryPickerCommands()
  if (pickers.length === 0) return { error: 'No folder picker is available on this system' }
  const failures: string[] = []
  for (const picker of pickers) {
    const selected = await captureProcessOutput(picker.command, picker.args)
    if (selected !== undefined) {
      // Empty (but clean) output means the user dismissed the dialog; treat it
      // as an intentional cancel rather than cascading to the next picker.
      return selected.trim() ? { path: resolve(selected.trim()) } : {}
    }
    failures.push(picker.command)
  }
  return { error: 'Could not open a folder picker (' + failures.join(', ') + ' unavailable)' }
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

function captureProcessOutput(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolveOutput) => {
    let settled = false
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      resolveOutput(value)
    }
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      finish()
      return
    }
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    child.on('error', () => finish())
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined))
  })
}
