export interface NativeWindowState {
  decorations: 'client' | 'server'
  maximized: boolean
  fullscreen: boolean
  resizable: boolean
  canMinimize: boolean
  canMaximize: boolean
}

export interface WindowControlRenderer {
  getWindowState?(): NativeWindowState
  minimizeWindow?(): void
  toggleMaximizeWindow?(): void
  closeWindow?(): void
}

export function readWindowState(renderer: WindowControlRenderer): NativeWindowState | undefined {
  try { return renderer.getWindowState?.() } catch {
    // Like GPUix's size/inset hooks, tolerate the window opening or closing.
    return undefined
  }
}

export const LINUX_TITLEBAR_HEIGHT = 36

export function usesClientWindowChrome(platform: string | undefined, browser: boolean, state: NativeWindowState | undefined): boolean {
  return platform === 'linux' && !browser && state?.decorations === 'client'
}

export function sameWindowState(left: NativeWindowState | undefined, right: NativeWindowState | undefined): boolean {
  if (!left || !right) return left === right
  return left.decorations === right.decorations && left.maximized === right.maximized
    && left.fullscreen === right.fullscreen && left.resizable === right.resizable
    && left.canMinimize === right.canMinimize && left.canMaximize === right.canMaximize
}

export function windowControlActions(renderer: WindowControlRenderer, state: NativeWindowState, onQuit?: () => void) {
  return {
    minimize: state.canMinimize && !state.fullscreen && renderer.minimizeWindow
      ? () => renderer.minimizeWindow?.() : undefined,
    maximize: (state.fullscreen || (state.canMaximize && state.resizable)) && renderer.toggleMaximizeWindow
      ? () => renderer.toggleMaximizeWindow?.() : undefined,
    close: onQuit ?? (renderer.closeWindow ? () => renderer.closeWindow?.() : undefined),
  }
}
