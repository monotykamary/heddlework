import { join } from 'node:path'
import type { WorkspaceDiff, WorkspaceDiffFile } from '../workbench/state.ts'

const MAX_PATCH_BYTES = 1_500_000
const MAX_UNTRACKED_FILES = 24
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

export async function loadWorkspaceDiff(cwd: string): Promise<WorkspaceDiff> {
  try {
    const branch = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    // Pin the classic a/ and b/ prefixes: git 2.55+ may default to c/ and w/.
    const trackedPatch = await runGit(cwd, ['diff', '--src-prefix=a/', '--dst-prefix=b/', '--no-ext-diff', '--unified=3', 'HEAD', '--'])
    const numstat = await runGit(cwd, ['diff', '--numstat', 'HEAD', '--'])
    const untracked = (await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '--']))
      .split('\n')
      .map((path) => path.trim())
      .filter(Boolean)
      .slice(0, MAX_UNTRACKED_FILES)

    const untrackedPatches = await Promise.all(untracked.map(async (path) => {
      const result = await runGit(cwd, ['diff', '--no-index', '--src-prefix=a/', '--dst-prefix=b/', '--no-ext-diff', '--unified=3', '--', NULL_DEVICE, path], [0, 1])
      return normalizeNoIndexPatch(result, cwd, path)
    }))
    const patch = [trackedPatch, ...untrackedPatches].filter(Boolean).join('\n')
    if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
      return {
        status: 'error',
        branch,
        files: [],
        additions: 0,
        deletions: 0,
        error: 'Working tree diff is too large to render.',
      }
    }

    const stats = parseNumstat(numstat)
    for (const path of untracked) {
      const text = await Bun.file(join(cwd, path)).text().catch(() => '')
      stats.set(path, { additions: text ? text.split('\n').length : 0, deletions: 0 })
    }
    const files = parsePatchFiles(patch, stats)
    return {
      status: 'ready',
      branch,
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    }
  } catch (error) {
    return {
      status: 'error',
      branch: '',
      files: [],
      additions: 0,
      deletions: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runGit(cwd: string, args: string[], allowedExitCodes = [0]): Promise<string> {
  const process = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (!allowedExitCodes.includes(exitCode)) {
    throw new Error(stderr.trim() || `git ${args[0] ?? ''} exited with ${exitCode}`)
  }
  return stdout
}

function parseNumstat(value: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>()
  for (const line of value.split('\n')) {
    const [added, deleted, path] = line.split('\t')
    if (!path) continue
    stats.set(path, {
      additions: Number.isFinite(Number(added)) ? Number(added) : 0,
      deletions: Number.isFinite(Number(deleted)) ? Number(deleted) : 0,
    })
  }
  return stats
}

function parsePatchFiles(
  patch: string,
  stats: Map<string, { additions: number; deletions: number }>,
): WorkspaceDiffFile[] {
  return patch
    .split(/(?=^diff --git )/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const path = patchPath(chunk)
      const stat = stats.get(path) ?? lineStats(chunk)
      return { path, patch: `${chunk}\n`, ...stat }
    })
}

function patchPath(patch: string): string {
  const destination = patch.match(/^\+\+\+ b\/(.+)$/m)?.[1]
  if (destination) return unquotePath(destination)
  const header = patch.match(/^diff --git a\/(.+) b\/(.+)$/m)?.[2]
  return unquotePath(header ?? 'changed file')
}

function unquotePath(value: string): string {
  return value.replace(/^"|"$/g, '')
}

function lineStats(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

function normalizeNoIndexPatch(patch: string, cwd: string, path: string): string {
  const escapedCwd = cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return patch
    .replace(new RegExp(`a/${escapedCwd}/?`, 'g'), 'a/')
    .replace(new RegExp(`b/${escapedCwd}/?`, 'g'), 'b/')
    .replace(/^diff --git a\/dev\/null b\/.+$/m, `diff --git a/${path} b/${path}`)
}
