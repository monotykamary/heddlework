// Browser replacements for src/ui/open-external.ts. Links open in a tab; paths and folder pickers are host-only.

export interface DirectoryPickerCommand { command: string; args: string[] }
export interface WorkspaceDirectoryPick { path?: string; error?: string }

export function openExternal(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
  window.open(parsed.href, '_blank', 'noopener,noreferrer')
}

export function openPath(_path: string): void {}

export function directoryPickerCommand(): DirectoryPickerCommand | undefined { return undefined }
export function directoryPickerCommands(): DirectoryPickerCommand[] { return [] }
export async function pickWorkspaceDirectory(): Promise<WorkspaceDirectoryPick> {
  return { error: 'Folder picking is available on the desktop app' }
}
export function systemTargetCommand(target: string): DirectoryPickerCommand { return { command: 'open', args: [target] } }
