import { describe, expect, it } from 'bun:test'
import { extractPortalResponseSignal, requestPortalDirectory } from '../src/ui/portal-file-chooser.ts'
import type { PortalPickerProbe } from '../src/ui/portal-file-chooser.ts'

function handleFor(token: string): string {
  return '/org/freedesktop/portal/desktop/request/1_555/' + token
}

// The portal module drives gdbus/dbus-monitor subprocesses. These tests inject
// a deterministic runner so the status/URI mapping is verified without a live
// desktop session or a real tool dialog.
function portalProbe(response: string | undefined): PortalPickerProbe {
  return {
    run: async (_command, args) => {
      const token = args.at(-1)?.match(/'handle_token': '([^']+)'/u)?.[1]
      return token ? "(objectpath '" + handleFor(token) + "',)" : undefined
    },
    monitor: async () => response,
  }
}

describe('portal response framing', () => {
  const token = 'heddlework_test'
  const header = (value: string) => `signal time=1 sender=:1.2 -> destination=:1.3 serial=4 path=/org/freedesktop/portal/desktop/request/1_3/${value}; interface=org.freedesktop.portal.Request; member=Response`

  it('accepts an unquoted path only after the selected response is complete', () => {
    const partial = `${header(token)}\n   uint32 0\n   array [`
    expect(extractPortalResponseSignal(partial, token)).toBeUndefined()

    const complete = `${partial}\n      string "file:///home/user/project"\n   ]`
    expect(extractPortalResponseSignal(complete, token)).toBe(complete)
  })

  it('does not combine fields from an unrelated preceding response', () => {
    const unrelated = `${header('other')}\n   uint32 0\n   string "file:///wrong"\n`
    const selected = `${header(token)}\n   uint32 1`
    expect(extractPortalResponseSignal(unrelated + selected, token)).toBe(selected)
  })
})

describe('requestPortalDirectory', () => {
  it('rejects a pre-aborted request without starting any transport', async () => {
    const abort = new AbortController()
    abort.abort()
    const commands: string[] = []
    const probe: PortalPickerProbe = {
      run: async (command) => { commands.push(command); return undefined },
      monitor: async (command) => { commands.push(command); return undefined },
    }
    await expect(requestPortalDirectory(probe, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(commands).toEqual([])
  })

  it('returns a resolved path for a successful selection', async () => {
    const result = await requestPortalDirectory(portalProbe("uint32 0\n  string 'file:///home/user/project'"))
    expect(result.status).toBe('selected')
    expect(result.path).toBe('/home/user/project')
  })

  it('reports a cancellation without a path', async () => {
    const result = await requestPortalDirectory(portalProbe('uint32 1'))
    expect(result.status).toBe('cancelled')
    expect(result.path).toBeUndefined()
  })

  it('treats a missing handle as unavailable', async () => {
    const result = await requestPortalDirectory({ run: async () => undefined, monitor: async () => undefined })
    expect(result.status).toBe('unavailable')
  })

  it('treats a timed-out or empty response as unavailable', async () => {
    const result = await requestPortalDirectory(portalProbe(undefined))
    expect(result.status).toBe('unavailable')
  })

  it('arms the response monitor before opening the portal', async () => {
    const commands: string[] = []
    let releaseOpen: (() => void) | undefined
    let token = ''
    const run: NonNullable<PortalPickerProbe['run']> = async (command, args) => {
      commands.push(command)
      if (command !== 'gdbus') return undefined
      token = args.at(-1)?.match(/'handle_token': '([^']+)'/u)?.[1] ?? ''
      return await new Promise<string>((resolve) => { releaseOpen = () => resolve("(objectpath '" + handleFor(token) + "',)") })
    }
    const monitor: NonNullable<PortalPickerProbe['monitor']> = async (command) => {
      commands.push(command)
      return "uint32 0\n  string 'file:///home/user/project'"
    }

    const pending = requestPortalDirectory({ run, monitor })
    await Bun.sleep(0)
    const commandsBeforeOpenReturns = [...commands]
    releaseOpen?.()
    const result = await pending

    expect(commandsBeforeOpenReturns).toEqual(['dbus-monitor', 'gdbus'])
    expect(result.status).toBe('selected')
  })
})
