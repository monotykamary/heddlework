import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { DEFAULT_REMOTE_PORT, pairingUrl, parseArguments, parseToken, remoteCommandArguments, remotePath, shellQuote, stableLocalPort, startScript, TOKEN_PATTERN, TOKEN_SCRIPT, tunnelArguments, type SshTunnelOptions } from '../scripts/heddlework-ssh.ts'

function options(argv: string[]): SshTunnelOptions {
  const parsed = parseArguments(argv)
  if (parsed.help) throw new Error('unexpected help')
  return parsed.options
}

describe('heddlework-ssh arguments', () => {
  it('parses a bare target with defaults', () => {
    expect(options(['dev@studio'])).toEqual({ target: 'dev@studio', remotePort: DEFAULT_REMOTE_PORT, start: false, bun: 'bun', sshOptions: [] })
  })
  it('parses start, ports, and ssh passthrough options', () => {
    expect(options(['--start', '--remote-dir', '~/src/heddlework', '--workspace', '/srv/repo', '--remote-port', '4900', '--local-port', '24000', '--bun', '/opt/bun/bun', '-o', 'Port=2222', '-F', 'cfg', '--', 'studio'])).toEqual({ target: 'studio', remotePort: 4900, localPort: 24000, start: true, remoteDir: '~/src/heddlework', workspace: '/srv/repo', bun: '/opt/bun/bun', sshOptions: ['Port=2222'], configFile: 'cfg' })
  })
  it('returns help', () => {
    expect(parseArguments(['--help'])).toEqual({ help: true })
    expect(parseArguments(['studio', '-h'])).toEqual({ help: true })
  })
  it('rejects targets that ssh would read as options', () => {
    expect(() => parseArguments(['--', '-oProxyCommand=touch /tmp/pwned'])).toThrow('must not start with "-"')
    expect(() => parseArguments(['-oProxyCommand=x'])).toThrow('Unknown option')
    expect(() => parseArguments(['studio host'])).toThrow('whitespace')
    expect(() => parseArguments(['studio\nx'])).toThrow('control')
  })
  it('rejects malformed input', () => {
    expect(() => parseArguments([])).toThrow('Missing')
    expect(() => parseArguments(['a', 'b'])).toThrow('Unexpected argument')
    expect(() => parseArguments(['--remote-port', '0', 'a'])).toThrow('between 1 and 65535')
    expect(() => parseArguments(['--local-port', '12ab', 'a'])).toThrow('port number')
    expect(() => parseArguments(['--remote-port'])).toThrow('needs a value')
    expect(() => parseArguments(['-o', 'Port 22', 'a'])).toThrow('KEY=VALUE')
    expect(() => parseArguments(['--start', 'a'])).toThrow('--start needs --remote-dir')
    expect(() => parseArguments(['--remote-dir', 'x', 'a'])).toThrow('only apply with --start')
  })
})

describe('heddlework-ssh commands', () => {
  const base = options(['-o', 'Port=2222', 'dev@studio'])
  it('forwards loopback to loopback and ends options before the target', () => {
    const args = tunnelArguments(base, 24_000)
    expect(args.slice(0, 2)).toEqual(['-o', 'BatchMode=yes'])
    expect(args).toContain('ExitOnForwardFailure=yes')
    expect(args).toContain('ServerAliveInterval=15')
    expect(args).toContain('ServerAliveCountMax=3')
    expect(args[args.indexOf('-L') + 1]).toBe('127.0.0.1:24000:127.0.0.1:4817')
    expect(args.slice(-2)).toEqual(['--', 'dev@studio'])
    expect(args.indexOf('BatchMode=yes')).toBeLessThan(args.indexOf('Port=2222'))
  })
  it('runs remote scripts under sh after the target', () => {
    const args = remoteCommandArguments(base, TOKEN_SCRIPT)
    expect(args.slice(-3, -1)).toEqual(['--', 'dev@studio'])
    expect(args.at(-1)).toBe(`exec sh -c ${shellQuote(TOKEN_SCRIPT)}`)
  })
  it('reads the token from the same paths as the host', () => {
    expect(TOKEN_SCRIPT).toContain('${XDG_STATE_HOME:-$HOME/.local/state}/heddlework/host-token')
    expect(TOKEN_SCRIPT).toContain('Library/Application Support/Heddlework/host-token')
  })
  it('quotes remote strings and detaches the started host', () => {
    const script = startScript(options(['--start', '--remote-dir', "/srv/it's here", '--workspace', '$(reboot)', '--bun', '/opt/b un', 'studio']))
    expect(script).toContain(`cd -- '/srv/it'\\''s here' || exit 1`)
    expect(script).toContain(`nohup '/opt/b un' src/host/main.ts '$(reboot)' > "$log" 2>&1 < /dev/null &`)
    expect(script).toContain('HEDDLEWORK_HOST_BIND=127.0.0.1 HEDDLEWORK_HOST_PORT=4817')
    expect(script).toContain('command -v setsid')
  })
  it('expands a leading ~ on the remote side only', () => {
    expect(remotePath('~')).toBe('"$HOME"')
    expect(remotePath("~/src/it's")).toBe(`"$HOME"/'src/it'\\''s'`)
    expect(remotePath('~other/x')).toBe(`'~other/x'`)
    const output = Bun.spawnSync(['sh', '-c', `printf %s ${remotePath('~/a b')}`], { env: { HOME: '/home/r' } }).stdout.toString()
    expect(output).toBe('/home/r/a b')
  })
  it('shell quotes round-trip through sh', () => {
    for (const value of ["it's", '$(id)', '`id`', 'a b', "'", '']) {
      const output = Bun.spawnSync(['sh', '-c', `printf %s ${shellQuote(value)}`]).stdout.toString()
      expect(output).toBe(value)
    }
  })
})

describe('heddlework-ssh pairing', () => {
  it('accepts only host-shaped tokens', () => {
    const token = 'A'.repeat(20) + '_-' + 'z9'.repeat(6)
    expect(parseToken(`${token}\n`)).toBe(token)
    expect(TOKEN_PATTERN.test('short')).toBe(false)
    expect(() => parseToken('')).toThrow('missing or malformed')
    expect(() => parseToken(`${token} extra`)).toThrow('missing or malformed')
    expect(() => parseToken(`${token}\x1b[2J`)).toThrow('missing or malformed')
  })
  it('keeps one local port per target', () => {
    const port = stableLocalPort('dev@studio', 4817)
    expect(stableLocalPort('dev@studio', 4817)).toBe(port)
    expect(port).toBeGreaterThanOrEqual(20_000)
    expect(port).toBeLessThan(30_000)
    expect(stableLocalPort('dev@other', 4817)).not.toBe(port)
  })
  it('builds a loopback fragment link the web client reads', () => {
    const url = new URL(pairingUrl(24_000, 'tok_en'))
    expect(url.origin).toBe('http://127.0.0.1:24000')
    const fragment = new URLSearchParams(url.hash.slice(1))
    expect(fragment.get('host')).toBe('http://127.0.0.1:24000')
    expect(fragment.get('token')).toBe('tok_en')
    expect(url.search).toBe('')
  })
})

// Opt-in: runs the real helper against an SSH target, e.g.
// HEDDLEWORK_SSH_TEST_ARGS='--start --remote-dir ~/src/heddlework dev@studio' bun test tests/heddlework-ssh.test.ts
const integrationArgs = process.env.HEDDLEWORK_SSH_TEST_ARGS?.trim()
describe.skipIf(!integrationArgs)('heddlework-ssh against a real host', () => {
  it('opens a tunnel, verifies the host, and prints a working link', async () => {
    const child = Bun.spawn(['bun', resolve(import.meta.dir, '../scripts/heddlework-ssh.ts'), ...integrationArgs!.split(/\s+/)], { stdout: 'pipe', stderr: 'inherit' })
    try {
      let output = ''
      const decoder = new TextDecoder()
      for await (const chunk of child.stdout) { output += decoder.decode(chunk); if (/open\s+\S+/.test(output)) break }
      const link = /open\s+(\S+)/.exec(output)?.[1]
      expect(link).toBeDefined()
      const url = new URL(link!)
      expect(url.hostname).toBe('127.0.0.1')
      expect(await (await fetch(`${url.origin}/health`)).json()).toMatchObject({ ok: true })
      expect((await fetch(`${url.origin}/`)).status).toBe(200)
    } finally {
      child.kill('SIGINT')
      await child.exited
    }
  }, 120_000)
})
