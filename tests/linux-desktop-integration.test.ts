import { describe, expect, it } from 'bun:test'
import { LinuxDesktopIntegration } from '../src/linux/desktop-integration.ts'
import { runDesktopCommand } from '../src/linux/process.ts'

describe('Linux desktop picker ownership', () => {
  it('stops after cancellation and retries portal on a later operation', async () => {
    let calls = 0
    const service = new LinuxDesktopIntegration({ resolveAppearance: () => 'dark', portal: async () => { calls++; return { status: 'cancelled' } }, dialog: async () => { throw new Error('must not fall through') } })
    try {
      expect((await service.pickDirectory()).status).toBe('cancelled')
      expect((await service.pickDirectory()).status).toBe('cancelled')
      expect(calls).toBe(2)
      expect(service.getSnapshot().pickerBackend).toBe('cli-portal')
    } finally { service.dispose() }
  })

  it('tries fallback dialogs only after unavailable results', async () => {
    const commands: string[] = []
    const service = new LinuxDesktopIntegration({ resolveAppearance: () => 'dark', portal: async () => ({ status: 'unavailable' }), dialog: async command => {
      commands.push(command.command)
      return command.command === 'zenity' ? { status: 'unavailable' } : { status: 'selected', path: '/fixture' }
    } })
    try {
      expect(await service.pickDirectory()).toEqual({ status: 'selected', path: '/fixture' })
      expect(commands).toEqual(['zenity', 'kdialog'])
    } finally { service.dispose() }
  })

  it('aborts pending operations on disposal without publishing late results', async () => {
    let release: ((value: { status: 'selected'; path: string }) => void) | undefined
    let signal: AbortSignal | undefined
    const service = new LinuxDesktopIntegration({ resolveAppearance: () => 'dark', portal: active => { signal = active; return new Promise(resolve => { release = resolve }) } })
    const snapshot = service.getSnapshot()
    const pending = service.pickDirectory()
    service.dispose()
    service.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal?.aborted).toBe(true)
    release?.({ status: 'selected', path: '/late' })
    await Promise.resolve()
    expect(service.getSnapshot()).toBe(snapshot)
    await expect(service.pickDirectory()).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('desktop child process ownership', () => {
  it('preserves UTF-8 split across stdout writes', async () => {
    const result = await runDesktopCommand(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 40)'])
    expect(result).toEqual({ code: 0, stdout: '€' })
  })

  it('supersedes a previous picker without sharing its selection', async () => {
    const signals: AbortSignal[] = []
    const service = new LinuxDesktopIntegration({ resolveAppearance: () => 'dark', portal: signal => {
      signals.push(signal)
      return signals.length === 1 ? new Promise(() => {}) : Promise.resolve({ status: 'selected', path: '/new' })
    } })
    try {
      const first = service.pickDirectory()
      const rejected = first.then(() => { throw new Error('Superseded picker unexpectedly resolved') }, error => error)
      expect(await service.pickDirectory()).toEqual({ status: 'selected', path: '/new' })
      expect(await rejected).toMatchObject({ name: 'AbortError' })
      expect(signals[0]?.aborted).toBe(true)
      expect(signals[1]?.aborted).toBe(false)
    } finally { service.dispose() }
  })

  it('terminates a real child after abort', async () => {
    const controller = new AbortController()
    let pid = 0
    const pending = runDesktopCommand(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], {
      signal: controller.signal,
      onOutput: output => { pid = Number(output.trim()); controller.abort(); return undefined },
    })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(pid).toBeGreaterThan(0)
    let alive = true
    const deadline = Date.now() + 2000
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0) } catch { alive = false }
      if (alive) await Bun.sleep(10)
    }
    expect(alive).toBe(false)
  })
})
