export const REQUIRED_NATIVE_METHODS = ['setTerminalFrame', 'getWindowState', 'minimizeWindow', 'toggleMaximizeWindow', 'closeWindow'] as const

export function assertNativeRuntime(prototype: object): void {
  const methods = prototype as Record<string, unknown>
  const missing = REQUIRED_NATIVE_METHODS.filter((name) => typeof methods[name] !== 'function')
  if (missing.length > 0) {
    throw new Error(`The installed GPUix runtime is missing ${missing.join(', ')}. Run bun run setup:native to install Heddlework's pinned runtime after bun install.`)
  }
}
