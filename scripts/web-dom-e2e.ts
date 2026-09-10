import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '..')
for (const command of [['bun', 'scripts/build-web.ts'], ['bun', 'scripts/web-dom-probe.ts']] as const) {
  const child = Bun.spawn([...command], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(child.stdout).text(); const error = await new Response(child.stderr).text(); const code = await child.exited
  if (code !== 0) throw new Error(error || output || `${command.join(' ')} exited ${code}`)
  process.stdout.write(output)
}
