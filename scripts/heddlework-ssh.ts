#!/usr/bin/env bun
// Reaches a Heddlework host on another machine through an SSH local forward.
// The remote host keeps its loopback bind; the browser talks to 127.0.0.1:<local> and the
// host's loopback origin check accepts it because the Host and Origin ports match.
import { createHash } from 'node:crypto'
import { FrameAssembler, parseServerMessage, PROTOCOL_VERSION } from '../src/protocol/index.ts'

export const DEFAULT_REMOTE_PORT = 4817
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/
const LOCAL_PORT_BASE = 20_000
const LOCAL_PORT_SPAN = 10_000
const SSH_OPTION_PATTERN = /^[A-Za-z][A-Za-z0-9]*=\S.*$/

export const USAGE = `Usage: bun run ssh -- [options] [user@]host

Opens an SSH tunnel to a Heddlework host on a remote machine and prints a
loopback pairing link for this machine's browser.

Options:
  --remote-port N     Port the remote host listens on (default ${DEFAULT_REMOTE_PORT})
  --local-port N      Local port to forward from (default: stable per target)
  --start             Start the remote host if it is not already running
  --remote-dir DIR    Remote Heddlework checkout used by --start; relative
                      paths and '~/...' (quoted) resolve from the remote home
  --workspace DIR     Remote workspace for --start (default: --remote-dir)
  --bun PATH          Remote bun executable for --start (default: bun)
  -o KEY=VALUE        Extra ssh option, repeatable (for example -o Port=2222)
  -F FILE             ssh config file
  -h, --help          Show this help

The remote host must bind loopback (the default). The link contains the host
token; treat it like a password.`

export interface SshTunnelOptions {
  target: string
  remotePort: number
  localPort?: number
  start: boolean
  remoteDir?: string
  workspace?: string
  bun: string
  sshOptions: string[]
  configFile?: string
}

export type ParsedArguments = { help: true } | { help: false; options: SshTunnelOptions }

export function parseArguments(argv: readonly string[]): ParsedArguments {
  let target: string | undefined
  let remotePort = DEFAULT_REMOTE_PORT
  let localPort: number | undefined
  let start = false
  let remoteDir: string | undefined
  let workspace: string | undefined
  let bun = 'bun'
  let configFile: string | undefined
  const sshOptions: string[] = []
  let positionalOnly = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    const value = (): string => { const next = argv[index + 1]; if (next === undefined) throw new Error(`${argument} needs a value`); index += 1; return next }
    if (!positionalOnly && argument === '--') { positionalOnly = true; continue }
    if (!positionalOnly && argument.startsWith('-')) {
      switch (argument) {
        case '-h': case '--help': return { help: true }
        case '--remote-port': remotePort = parsePort(value(), argument); break
        case '--local-port': localPort = parsePort(value(), argument); break
        case '--start': start = true; break
        case '--remote-dir': remoteDir = nonEmpty(value(), argument); break
        case '--workspace': workspace = nonEmpty(value(), argument); break
        case '--bun': bun = nonEmpty(value(), argument); break
        case '-F': configFile = nonEmpty(value(), argument); break
        case '-o': { const option = value(); if (!SSH_OPTION_PATTERN.test(option)) throw new Error(`-o expects KEY=VALUE, got ${JSON.stringify(option)}`); sshOptions.push(option); break }
        default: throw new Error(`Unknown option ${argument}`)
      }
      continue
    }
    if (target !== undefined) throw new Error(`Unexpected argument ${JSON.stringify(argument)}`)
    target = validateTarget(argument)
  }
  if (target === undefined) throw new Error('Missing [user@]host target')
  if (start && remoteDir === undefined) throw new Error('--start needs --remote-dir')
  if (!start && (remoteDir !== undefined || workspace !== undefined)) throw new Error('--remote-dir and --workspace only apply with --start')
  return { help: false, options: { target, remotePort, start, bun, sshOptions, ...(localPort === undefined ? {} : { localPort }), ...(remoteDir === undefined ? {} : { remoteDir }), ...(workspace === undefined ? {} : { workspace }), ...(configFile === undefined ? {} : { configFile }) } }
}

// A leading dash would let a target smuggle ssh flags such as -oProxyCommand.
export function validateTarget(target: string): string {
  if (!target) throw new Error('Missing [user@]host target')
  if (target.startsWith('-')) throw new Error(`Target must not start with "-": ${JSON.stringify(target)}`)
  if (/[\s\u0000-\u001f\u007f]/.test(target)) throw new Error(`Target must not contain whitespace or control characters: ${JSON.stringify(target)}`)
  return target
}

function parsePort(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} expects a port number`)
  const port = Number(value)
  if (port < 1 || port > 65_535) throw new Error(`${flag} must be between 1 and 65535`)
  return port
}
function nonEmpty(value: string, flag: string): string { if (!value.trim()) throw new Error(`${flag} must not be empty`); return value }

// Browser storage, saved hosts, and the service worker are per origin, so each target keeps one port across runs.
export function stableLocalPort(target: string, remotePort: number): number {
  const digest = createHash('sha256').update(`${target}\n${remotePort}`).digest()
  return LOCAL_PORT_BASE + (digest.readUInt32BE(0) % LOCAL_PORT_SPAN)
}

export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'` }
// Quoting stops the remote shell from expanding ~, so a quoted ~/ prefix is rewritten to the remote $HOME.
export function remotePath(value: string): string {
  if (value === '~') return '"$HOME"'
  if (value.startsWith('~/')) return `"$HOME"/${shellQuote(value.slice(2))}`
  return shellQuote(value)
}

// Remote scripts run under sh so the user's login shell (fish, nushell, ...) does not change their meaning.
function remoteShell(script: string): string { return `exec sh -c ${shellQuote(script)}` }

function sshBaseArguments(options: SshTunnelOptions): string[] {
  return ['-o', 'BatchMode=yes', ...(options.configFile === undefined ? [] : ['-F', options.configFile]), ...options.sshOptions.flatMap((option) => ['-o', option])]
}

export function tunnelArguments(options: SshTunnelOptions, localPort: number): string[] {
  return [...sshBaseArguments(options), '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${localPort}:127.0.0.1:${options.remotePort}`, '--', options.target]
}

export function remoteCommandArguments(options: SshTunnelOptions, script: string): string[] {
  return [...sshBaseArguments(options), '-T', '--', options.target, remoteShell(script)]
}

export const TOKEN_SCRIPT = 'if [ "$(uname -s)" = Darwin ]; then f="$HOME/Library/Application Support/Heddlework/host-token"; else f="${XDG_STATE_HOME:-$HOME/.local/state}/heddlework/host-token"; fi; cat -- "$f"'

// cd must fail closed, and the detached child must not hold the ssh channel open: no inherited stdio, own session where setsid exists.
export function startScript(options: SshTunnelOptions): string {
  if (options.remoteDir === undefined) throw new Error('--start needs --remote-dir')
  return [
    `cd -- ${remotePath(options.remoteDir)} || exit 1`,
    'log="${XDG_STATE_HOME:-$HOME/.local/state}/heddlework"; mkdir -p "$log"; log="$log/ssh-host.log"',
    'if command -v setsid >/dev/null 2>&1; then detach=setsid; else detach=; fi',
    `HEDDLEWORK_HOST_BIND=127.0.0.1 HEDDLEWORK_HOST_PORT=${options.remotePort} $detach nohup ${remotePath(options.bun)} src/host/main.ts ${remotePath(options.workspace ?? '.')} > "$log" 2>&1 < /dev/null &`,
    'echo "started $! $log"',
  ].join('\n')
}

export function pairingUrl(localPort: number, token: string): string {
  const origin = `http://127.0.0.1:${localPort}`
  return `${origin}/#${new URLSearchParams({ host: origin, token }).toString()}`
}

export function parseToken(output: string): string {
  const token = output.trim()
  if (!TOKEN_PATTERN.test(token)) throw new Error('Remote host token is missing or malformed')
  return token
}

async function runSsh(options: SshTunnelOptions, script: string): Promise<string> {
  const child = Bun.spawn(['ssh', ...remoteCommandArguments(options, script)], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`ssh ${options.target} exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
  return stdout
}

async function portAcceptsConnections(port: number): Promise<boolean> {
  const connect = Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } }).then((socket) => { socket.end(); return true }, () => false)
  return await Promise.race([connect, Bun.sleep(2_000).then(() => false)])
}

async function assertPortFree(port: number): Promise<void> {
  try {
    const listener = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })
    listener.stop(true)
  } catch {
    throw new Error(`Local port ${port} is already in use; pass --local-port`)
  }
}

async function fetchStatus(url: string, init: RequestInit = {}): Promise<Response | undefined> {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) }) } catch { return undefined }
}

async function hostHealthy(localPort: number): Promise<boolean> {
  const response = await fetchStatus(`http://127.0.0.1:${localPort}/health`)
  if (!response?.ok) return false
  const body = await response.json().catch(() => undefined) as { ok?: unknown } | undefined
  return body?.ok === true
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, abort?: () => string | undefined): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const reason = abort?.()
    if (reason) throw new Error(reason)
    if (await check()) return true
    await Bun.sleep(250)
  }
  return false
}

// /health alone passes against the wrong host, token, or a host without dist/web, so check the page and a real hello/welcome.
async function verifyHost(localPort: number, token: string): Promise<{ workspacePath: string }> {
  const origin = `http://127.0.0.1:${localPort}`
  const page = await fetchStatus(`${origin}/`)
  if (page?.status !== 200 || !(page.headers.get('content-type') ?? '').includes('text/html')) throw new Error(`Remote host does not serve the web client (GET / returned ${page?.status ?? 'no response'}); run bun run build:web in its checkout`)
  // A plain GET runs the host's origin and token checks before the upgrade, so it tells a rejected origin (403) from a bad token (401).
  const preflight = await fetchStatus(`${origin}/ws`, { headers: { origin, 'sec-websocket-protocol': `heddlework-v2, auth.${token}` } })
  if (preflight?.status === 403) throw new Error('Remote host rejected the loopback origin; it must bind loopback, or list this origin in HEDDLEWORK_HOST_ORIGINS')
  if (preflight?.status === 401) throw new Error('Remote host rejected the token; the token file does not belong to the host on this port')
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${localPort}/ws`, ['heddlework-v2', `auth.${token}`])
    const assembler = new FrameAssembler()
    const timer = setTimeout(() => { socket.close(); reject(new Error('Timed out waiting for the host welcome')) }, 15_000)
    const finish = (error: Error | undefined, workspacePath = ''): void => { clearTimeout(timer); socket.close(); if (error) reject(error); else resolve({ workspacePath }) }
    socket.addEventListener('open', () => socket.send(JSON.stringify({ kind: 'hello', protocol: PROTOCOL_VERSION, clientId: `ssh-${crypto.randomUUID()}` })))
    socket.addEventListener('message', (event) => {
      const assembled = assembler.push(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8'))
      if (assembled === undefined) return
      const message = parseServerMessage(assembled)
      if (message?.kind === 'welcome') finish(undefined, message.workspacePath)
      else if (message?.kind === 'error') finish(new Error(`Remote host refused the handshake: ${message.message}`))
    })
    socket.addEventListener('close', (event) => finish(new Error(`WebSocket closed before welcome (${event.code}${event.reason ? ` ${event.reason}` : ''})`)))
  })
}

class Tunnel {
  #child: ReturnType<typeof Bun.spawn> | undefined
  #stderr = ''
  #exitCode: number | undefined
  #stopped = false
  constructor(readonly options: SshTunnelOptions, readonly localPort: number) {}
  get exitReason(): string | undefined { return this.#exitCode === undefined ? undefined : `ssh tunnel exited with ${this.#exitCode}${this.#stderr.trim() ? `: ${this.#stderr.trim()}` : ''}` }
  start(): Promise<number> {
    this.#stderr = ''
    this.#exitCode = undefined
    const child = Bun.spawn(['ssh', ...tunnelArguments(this.options, this.localPort)], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
    this.#child = child
    // Refused forwards (remote host not up yet) are expected while probing and would bury the real exit reason.
    void (async () => { for await (const chunk of child.stderr) this.#stderr = (this.#stderr + new TextDecoder().decode(chunk)).split('\n').filter((line) => !/^channel \d+: open failed/.test(line)).join('\n').slice(-2_000) })()
    return child.exited.then((code) => { this.#exitCode = code; return code })
  }
  async ready(timeoutMs = 30_000): Promise<void> {
    if (!await waitFor(() => portAcceptsConnections(this.localPort), timeoutMs, () => this.exitReason)) throw new Error(`ssh tunnel did not open 127.0.0.1:${this.localPort} within ${timeoutMs / 1000}s${this.#stderr.trim() ? `: ${this.#stderr.trim()}` : ''}`)
  }
  stop(): void { this.#stopped = true; this.#child?.kill() }
  get stopped(): boolean { return this.#stopped }
}

async function supervise(tunnel: Tunnel, exited: Promise<number>, log: (message: string) => void): Promise<void> {
  let delay = 1_000
  for (;;) {
    const startedAt = Date.now()
    await exited
    if (tunnel.stopped) return
    if (Date.now() - startedAt > 60_000) delay = 1_000
    log(`${tunnel.exitReason ?? 'ssh tunnel exited'}; reconnecting in ${delay / 1000}s`)
    await Bun.sleep(delay)
    if (tunnel.stopped) return
    delay = Math.min(delay * 2, 30_000)
    exited = tunnel.start()
    try {
      await tunnel.ready()
      log(`reconnected${await hostHealthy(tunnel.localPort) ? '' : ' (remote host is not answering yet)'}`)
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    }
  }
}

export interface SshTunnelConnection {
  localPort: number
  url: string
  token: string
  workspacePath: string
  /** Settles after close(); until then the tunnel reconnects with backoff when ssh exits. */
  closed: Promise<void>
  close(): void
}

// Opens, verifies, and supervises the tunnel. Shared by the CLI and the desktop remote mode.
export async function connectSshTunnel(options: SshTunnelOptions, log: (message: string) => void = (message) => console.error(`[heddlework-ssh] ${message}`), signal?: AbortSignal): Promise<SshTunnelConnection> {
  const localPort = options.localPort ?? stableLocalPort(options.target, options.remotePort)
  await assertPortFree(localPort)
  const tunnel = new Tunnel(options, localPort)
  const close = (): void => tunnel.stop()
  signal?.addEventListener('abort', close, { once: true })
  const exited = tunnel.start()
  try {
    await tunnel.ready()
    if (!await hostHealthy(localPort)) {
      if (!options.start) throw new Error(`No Heddlework host answers on ${options.target} port ${options.remotePort}; start one there or pass --start --remote-dir DIR`)
      log((await runSsh(options, startScript(options))).trim())
      if (!await waitFor(() => hostHealthy(localPort), 60_000, () => tunnel.exitReason)) throw new Error('Remote host did not become healthy within 60s; check the remote log')
    }
    const token = parseToken(await runSsh(options, TOKEN_SCRIPT))
    const { workspacePath } = await verifyHost(localPort, token)
    return { localPort, url: `http://127.0.0.1:${localPort}`, token, workspacePath, closed: supervise(tunnel, exited, log), close }
  } catch (error) {
    close()
    throw error
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArguments(argv)
  if (parsed.help) { console.log(USAGE); return }
  const { options } = parsed
  const abort = new AbortController()
  process.once('SIGINT', () => abort.abort())
  process.once('SIGTERM', () => abort.abort())
  const connection = await connectSshTunnel(options, undefined, abort.signal)
  console.log(`Heddlework over SSH: ${options.target} -> 127.0.0.1:${connection.localPort}`)
  if (connection.workspacePath) console.log(`  workspace  ${connection.workspacePath}`)
  console.log(`  open       ${pairingUrl(connection.localPort, connection.token)}`)
  console.log('Keep this running; Ctrl-C closes the tunnel. The link contains the host token.')
  await connection.closed
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
    console.error(`[heddlework-ssh] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
