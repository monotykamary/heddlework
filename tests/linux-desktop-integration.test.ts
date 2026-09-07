import { describe, expect, it } from 'bun:test'
import { LinuxDesktopIntegration } from '../src/linux/desktop-integration.ts'
import { runDesktopCommand } from '../src/linux/process.ts'

describe('native appearance ownership', () => {
  it('withdraws polling after none becomes explicit and preserves snapshot identity', async () => {
    let emit: ((event: import('../src/linux/native-appearance.ts').SystemAppearanceEvent) => void) | undefined
    let reads = 0
    let monitors = 0
    let disposals = 0
    const service = new LinuxDesktopIntegration({
      resolveAppearance: () => { reads++; return 'dark' },
      pollIntervalMs: 5,
      subscribeNativeAppearance: listener => { emit = listener; return { dispose() { disposals++ } } },
      spawnMonitor: () => { monitors++; throw new Error('no monitor') },
    })
    try {
      service.start()
      emit!({ status: 'available', preference: 'none' })
      expect(service.getSnapshot().appearanceBackend).toBe('poll')
      const fallback = service.getSnapshot()
      emit!({ status: 'available', preference: 'none' })
      expect(service.getSnapshot()).toBe(fallback)
      expect(monitors).toBe(1)
      expect(disposals).toBe(0)
      emit!({ status: 'available', preference: 'light' })
      const native = service.getSnapshot()
      const previousReads = reads
      emit!({ status: 'available', preference: 'light' })
      expect(service.getSnapshot()).toBe(native)
      expect(native.appearanceBackend).toBe('native')
      expect(native.degradations).toEqual([])
      await Bun.sleep(20)
      expect(reads).toBe(previousReads)
      emit!({ status: 'unavailable', reason: 'disconnected' })
      expect(service.getSnapshot().appearanceBackend).toBe('poll')
      expect(disposals).toBe(1)
      emit!({ status: 'available', preference: 'light' })
      expect(service.getSnapshot().appearanceBackend).toBe('poll')
    } finally { service.dispose() }
    expect(disposals).toBe(1)
  })

  it('retires a timed-out native subscription and ignores late preferences', async () => {
    let emit: ((event: { status: 'available'; preference: 'light' }) => void) | undefined
    let disposals = 0
    const service = new LinuxDesktopIntegration({
      resolveAppearance: () => 'dark',
      nativeSetupTimeoutMs: 1,
      pollIntervalMs: 1000,
      subscribeNativeAppearance: listener => { emit = listener; return { dispose() { disposals++ } } },
      spawnMonitor: () => { throw new Error('monitor unavailable') },
    })
    try {
      service.start()
      await Bun.sleep(20)
      expect(disposals).toBe(1)
      expect(service.getSnapshot().appearanceBackend).toBe('poll')
      emit?.({ status: 'available', preference: 'light' })
      expect(service.getSnapshot().appearance).toBe('dark')
    } finally { service.dispose() }
    expect(disposals).toBe(1)
  })

  it('uses an explicit native preference without starting a monitor or probing gsettings', () => {
    let reads = 0
    let disposed = 0
    let emit: ((event: { status: 'available'; preference: 'dark' | 'light' | 'none' }) => void) | undefined
    const service = new LinuxDesktopIntegration({
      resolveAppearance: () => { reads++; return 'dark' },
      subscribeNativeAppearance: listener => { emit = listener; return { dispose() { disposed++ } } },
      spawnMonitor: () => { throw new Error('native preference must not spawn a monitor') },
    })
    try {
      const initial = service.getSnapshot()
      expect(initial).toMatchObject({ appearance: 'dark', appearanceBackend: 'initializing' })
      expect(reads).toBe(0)
      service.start()
      expect(service.getSnapshot()).toBe(initial)
      emit?.({ status: 'available', preference: 'light' })
      expect(service.getSnapshot().appearance).toBe('light')
      expect(service.getSnapshot().appearanceBackend).toBe('native')
      expect(reads).toBe(0)
    } finally { service.dispose() }
    expect(disposed).toBe(1)
  })
})

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
