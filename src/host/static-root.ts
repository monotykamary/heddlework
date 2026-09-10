import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function resolveStaticRoot(
  environment: NodeJS.ProcessEnv = process.env,
  executablePath = process.execPath,
  sourceRoot = resolve(import.meta.dir, '..', '..'),
): string | undefined {
  if (environment.HEDDLEWORK_WEB_ROOT) return resolve(environment.HEDDLEWORK_WEB_ROOT)
  const executableDirectory = dirname(executablePath)
  const candidates = [
    resolve(executableDirectory, '..', 'Resources', 'web'),
    resolve(executableDirectory, 'web'),
    resolve(sourceRoot, 'dist', 'web'),
  ]
  return candidates.find((candidate) => existsSync(resolve(candidate, 'index.html')))
}
