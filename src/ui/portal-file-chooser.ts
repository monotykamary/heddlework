import { randomBytes } from 'node:crypto'
import { abortable, runDesktopCommand, throwIfAborted } from '../linux/process.ts'
import { resolve } from 'node:path'

export type PortalPickStatus = 'selected' | 'cancelled' | 'unavailable'

export interface PortalPickResult {
  status: PortalPickStatus
  path?: string
  error?: string
}

export interface PortalPickerProbe {
  // Runs a bounded query and returns its output (undefined on timeout/failure).
  run?(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string | undefined>
  // Listens for a portal Response signal. A listener that starts before the
  // OpenFile call is armed is passed the handle_token so it can discriminate
  // this request (the portal echoes the token in the request object path).
  monitor?(command: string, args: string[], timeoutMs: number, token: string, signal: AbortSignal): Promise<string | undefined>
  parseHandle?(output: string): string | undefined
  parseCode?(signal: string): number | undefined
  parseUris?(signal: string): string[]
}

const PORTAL_BUS = 'org.freedesktop.portal.Desktop'
const PORTAL_OBJECT = '/org/freedesktop/portal/desktop'
const PORTAL_METHOD = 'org.freedesktop.portal.FileChooser.OpenFile'
// gdbus parses trailing args as GVariant text literals, so the title must be
// a quoted string literal (spaces otherwise break argument parsing).
const TITLE = "'Open project in Heddlework'"
const IPC_TIMEOUT_MS = 6_000
// The folder dialog stays open for human navigation and can take minutes;
// only the D-Bus call that opens it is bounded by the short IPC timeout.
const SESSION_TIMEOUT_MS = 5 * 60_000

function quoteVariant(value: string): string {
  return String.fromCharCode(0x27) + value + String.fromCharCode(0x27)
}

// XDG Desktop Portal FileChooser is asynchronous: OpenFile returns a request
// object path, and the selection arrives later as a Response signal on that
// object. The Response is one-shot, so the dbus-monitor listener MUST be
// established BEFORE invoking OpenFile: a response emitted between the call
// and listener startup (a fast cancel, a portal denial) would otherwise be
// lost and the pick would fall through after the full session timeout.
// We generate a unique handle_token, subscribe to Request Response signals
// keyed by that token, then call OpenFile with the same token, which the
// portal echoes back in the request object path.
export async function requestPortalDirectory(probe: PortalPickerProbe = {}, signal?: AbortSignal): Promise<PortalPickResult> {
  throwIfAborted(signal)
  const run = probe.run ?? runCommand
  const monitor: NonNullable<PortalPickerProbe['monitor']> = probe.monitor ?? (probe.run
    ? (command, args, timeoutMs, _token, signal) => probe.run!(command, args, timeoutMs, signal)
    : runPortalMonitor)
  const parseHandle = probe.parseHandle ?? extractOpenFilePath
  const parseCode = probe.parseCode ?? extractResponseCode
  const parseUris = probe.parseUris ?? extractUris
  const token = 'heddlework_' + randomBytes(9).toString('hex')
  const operation = new AbortController()
  const abort = () => operation.abort()
  signal?.addEventListener('abort', abort, { once: true })
  let handle: string | undefined
  let completed = false
  try {
    throwIfAborted(signal)
    const signalPromise = Promise.resolve().then(() => monitor('dbus-monitor', ['--session', "type='signal',interface='org.freedesktop.portal.Request',member='Response'"], SESSION_TIMEOUT_MS, token, operation.signal))
    // Observe early monitor rejection even while the setup call is still pending.
    void signalPromise.catch(() => {})
    await Promise.resolve()
    const openArgs = [
      'call', '--session', '--dest', PORTAL_BUS, '--object-path', PORTAL_OBJECT,
      '--method', PORTAL_METHOD, "''", TITLE,
      '{' + quoteVariant('directory') + ': <true>, ' + quoteVariant('modal') + ': <true>, ' + quoteVariant('handle_token') + ': ' + quoteVariant(token) + '}',
    ]
    const handleOutput = await abortable(run('gdbus', openArgs, IPC_TIMEOUT_MS, operation.signal), signal)
    if (handleOutput === undefined) return { status: 'unavailable', error: 'File dialog portal is not reachable' }
    handle = parseHandle(handleOutput)
    if (!handle || !handle.endsWith('/' + token)) {
      handle = undefined
      return { status: 'unavailable', error: 'File dialog portal did not open' }
    }
    const output = await abortable(signalPromise, signal)
    throwIfAborted(signal)
    if (output === undefined) return { status: 'unavailable', error: 'File dialog portal timed out' }
    const code = parseCode(output)
    if (code === undefined) return { status: 'unavailable', error: 'File dialog portal returned an unknown response' }
    completed = true
    if (code === 1) return { status: 'cancelled' }
    if (code !== 0) return { status: 'unavailable', error: 'File dialog portal failed' }
    const uri = parseUris(output)[0]
    if (!uri) return { status: 'unavailable', error: 'File dialog portal returned no selection' }
    return { status: 'selected', path: resolve(toFilePath(uri)) }
  } finally {
    signal?.removeEventListener('abort', abort)
    operation.abort()
    if (handle && !completed) {
      // Closing the server-side dialog is best effort and bounded independently of caller abort.
      void Promise.resolve().then(() => run('gdbus', ['call', '--session', '--dest', PORTAL_BUS, '--object-path', handle!, '--method', 'org.freedesktop.portal.Request.Close'], IPC_TIMEOUT_MS)).catch(() => {})
    }
  }
}

export function extractPortalResponseSignal(output: string, token: string): string | undefined {
  const headerPattern = /^signal\b.*$/gmu
  for (let match = headerPattern.exec(output); match; match = headerPattern.exec(output)) {
    const header = match[0]
    const path = header.match(/\bpath=(?:'([^']+)'|([^;\s]+));?/u)?.slice(1).find(Boolean)
    if (!path?.endsWith('/' + token) || !/\binterface=org\.freedesktop\.portal\.Request;/u.test(header) || !/\bmember=Response\b/u.test(header)) continue

    const start = match.index
    const remainder = output.slice(start + header.length)
    const nextHeader = remainder.search(/^\s*(?:signal|method call|method return|error)\b/mu)
    const response = output.slice(start, nextHeader < 0 ? undefined : start + header.length + nextHeader)
    const code = extractResponseCode(response)
    if (code === undefined) return undefined
    if (code !== 0 || /\bstring\s+["']file:[^"'\r\n]+["']/u.test(response)) return response
    return undefined
  }
  return undefined
}

async function runCommand(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  const result = await runDesktopCommand(command, args, { timeoutMs, signal })
  return result?.code === 0 && result.stdout.trim() ? result.stdout : undefined
}

async function runPortalMonitor(command: string, args: string[], timeoutMs: number, token: string, signal: AbortSignal): Promise<string | undefined> {
  const result = await runDesktopCommand(command, args, { timeoutMs, signal, onOutput: output => extractPortalResponseSignal(output, token) })
  return result?.code === 0 ? extractPortalResponseSignal(result.stdout, token) : undefined
}

function extractOpenFilePath(stdout: string): string | undefined {
  const match = stdout.match(/\/org\/freedesktop\/portal\/desktop\/request\/[^'\s)]+/u)
  return match?.[0]
}

function extractResponseCode(signal: string): number | undefined {
  const match = signal.match(/\buint32\s+(\d+)\b/u)
  const value = match?.[1]
  return value === undefined ? undefined : Number(value)
}

function extractUris(signal: string): string[] {
  const uris: string[] = []
  const re = /file:(?:\/\/|\/)[^\s'"]+/gu
  let found
  while ((found = re.exec(signal)) !== null) uris.push(found[0])
  return uris
}

function toFilePath(uri: string): string {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:') return uri
    return decodeURIComponent(url.pathname)
  } catch {
    return uri
  }
}
