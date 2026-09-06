import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWorkspaceDiff } from '../src/workspace/git-diff.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('loadWorkspaceDiff', () => {
  it('loads tracked and untracked working tree patches without a shell', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'heddlework-diff-'))
    directories.push(directory)
    await seedFixture(directory)

    const diff = await loadWorkspaceDiff(directory)

    expect(diff.status).toBe('ready')
    expect(diff.branch).toBe('main')
    expect(diff.files.map((file) => file.path).sort()).toEqual(['README.md', 'src/new.ts'])
    expect(diff.additions).toBeGreaterThanOrEqual(3)
    expect(diff.deletions).toBe(0)
    expect(diff.files.find((file) => file.path === 'src/new.ts')?.patch).toContain('export const ready')
  })

  it('parses worktree diffs when the repository overrides git diff prefixes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'heddlework-diff-'))
    directories.push(directory)
    await seedFixture(directory)
    // git 2.55+ can default to c/ and w/ prefixes; loadWorkspaceDiff pins a/ and b/.
    await run(directory, ['git', 'config', 'diff.srcPrefix', 'c/'])
    await run(directory, ['git', 'config', 'diff.dstPrefix', 'w/'])

    const diff = await loadWorkspaceDiff(directory)

    expect(diff.status).toBe('ready')
    expect(diff.files.map((file) => file.path).sort()).toEqual(['README.md', 'src/new.ts'])
    expect(diff.files.find((file) => file.path === 'src/new.ts')?.patch).toContain('export const ready')
  })
})

async function seedFixture(directory: string): Promise<void> {
  mkdirSync(join(directory, 'src'))
  writeFileSync(join(directory, 'README.md'), '# Fixture\n')
  await run(directory, ['git', 'init', '-q'])
  await run(directory, ['git', 'add', '.'])
  await run(directory, ['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'test: seed fixture'])
  await run(directory, ['git', 'branch', '-M', 'main'])
  writeFileSync(join(directory, 'README.md'), '# Fixture\n\nUpdated.\n')
  writeFileSync(join(directory, 'src', 'new.ts'), 'export const ready = true\n')
}

async function run(cwd: string, command: string[]): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited])
  if (exitCode !== 0) throw new Error(stderr)
}
