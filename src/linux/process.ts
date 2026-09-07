import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export function abortError(): DOMException { return new DOMException('Operation aborted', 'AbortError') }
export function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw abortError() }

// Also fences injected/native operations that cannot themselves be interrupted.
export function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError()) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(value => { cleanup(); if (signal.aborted) reject(abortError()); else resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
}

export interface CommandResult { code: number | null; stdout: string }
export interface CommandOptions {
  signal?: AbortSignal | undefined
  timeoutMs?: number
  onOutput?: (output: string) => string | undefined
}

// One cleanup path for dialogs, bounded setup calls, and response monitors.
export function runDesktopCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult | undefined> {
  throwIfAborted(options.signal)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const decoder = new StringDecoder('utf8')
    let output = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 250)
      killTimer.unref?.()
    }
    const finish = (result?: CommandResult, error?: unknown, stop = false) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      child.stdout.off('data', data)
      if (stop) terminate()
      if (error) reject(error); else resolve(result)
    }
    const abort = () => finish(undefined, abortError(), true)
    const data = (chunk: Buffer) => {
      output += decoder.write(chunk)
      // Bound accidental/malicious output from an otherwise long-lived monitor.
      if (output.length > 4 * 1024 * 1024) { finish(undefined, undefined, true); return }
      try {
        const selected = options.onOutput?.(output)
        if (selected !== undefined) finish({ code: 0, stdout: selected }, undefined, true)
      } catch (error) { finish(undefined, error, true) }
    }
    child.stdout.on('data', data)
    child.on('error', () => finish())
    child.on('close', code => { output += decoder.end(); if (killTimer) clearTimeout(killTimer); finish({ code, stdout: output }) })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.timeoutMs !== undefined) timer = setTimeout(() => finish(undefined, undefined, true), options.timeoutMs)
    if (options.signal?.aborted) abort()
  })
}
