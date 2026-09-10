import { afterEach, describe, expect, it } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { getPiSessionDirectory, PiSessionCatalog } from '../src/pi/session-catalog.ts'
import { watchPiSessions } from '../src/pi/session-watch.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'heddlework-session-performance-'))
  roots.push(root)
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const directory = getPiSessionDirectory(cwd, agentDir)
  await mkdir(directory, { recursive: true })
  return { root, agentDir, cwd, directory }
}

function header(id: string, cwd: string): string {
  return `${JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: '2026-09-01T00:00:00Z' })}\n`
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected condition did not settle')
    await Bun.sleep(10)
  }
}

describe('session catalog performance', () => {
  it('shares overlapping scans, reuses rows, and skips unchanged persistence writes', async () => {
    const { root, agentDir, cwd, directory } = await fixture()
    await Promise.all(Array.from({ length: 8 }, (_, index) => (
      writeFile(join(directory, `${index}.jsonl`), header(String(index), cwd))
    )))
    let scans = 0
    const cachePath = join(root, 'sessions.json')
    const catalog = new PiSessionCatalog({
      agentDir,
      cachePath,
      diagnostics: { scanStarted: () => { scans += 1 } },
    })

    const [small, large] = await Promise.all([catalog.list(cwd, 2), catalog.list(cwd, 5)])
    expect(scans).toBe(1)
    expect(small).toHaveLength(2)
    expect(large).toHaveLength(5)
    expect(small[0]).toBe(large[0])
    expect(catalog.cached(cwd)).toHaveLength(8)

    const before = await stat(cachePath)
    await Bun.sleep(25)
    const again = await catalog.list(cwd, 2)
    expect(scans).toBe(2)
    expect(again[0]).toBe(small[0])
    expect((await stat(cachePath)).mtimeMs).toBe(before.mtimeMs)
  })

  it('keeps other cwd caches and serialized persistence intact across concurrent scoped scans', async () => {
    const { root, agentDir, cwd: firstCwd, directory: firstDirectory } = await fixture()
    const secondCwd = join(root, 'other-project')
    const secondDirectory = getPiSessionDirectory(secondCwd, agentDir)
    await mkdir(secondDirectory, { recursive: true })
    await Promise.all([
      writeFile(join(firstDirectory, 'first.jsonl'), header('first', firstCwd)),
      writeFile(join(secondDirectory, 'second.jsonl'), header('second', secondCwd)),
    ])
    const cachePath = join(root, 'sessions.json')
    const catalog = new PiSessionCatalog({ agentDir, cachePath, scope: 'cwd' })

    await Promise.all([catalog.list(firstCwd), catalog.list(secondCwd)])
    const secondBefore = catalog.cached(secondCwd)[0]
    expect(catalog.cached(firstCwd).map((session) => session.id)).toEqual(['first'])
    expect(catalog.cached(secondCwd).map((session) => session.id)).toEqual(['second'])
    expect(new Set(JSON.parse(await readFile(cachePath, 'utf8')).sessions.map((session: { id: string }) => session.id))).toEqual(new Set(['first', 'second']))

    await appendFile(join(firstDirectory, 'first.jsonl'), `${JSON.stringify({ type: 'session_info', name: 'First renamed' })}\n`)
    await catalog.list(firstCwd)
    expect(catalog.cached(firstCwd)[0]?.name).toBe('First renamed')
    expect(catalog.cached(secondCwd)[0]).toBe(secondBefore)
    expect(new Set(JSON.parse(await readFile(cachePath, 'utf8')).sessions.map((session: { id: string }) => session.id))).toEqual(new Set(['first', 'second']))
  })

  it('prunes a persisted path whose rewritten header moved into the scanned scope', async () => {
    const { root, agentDir, cwd, directory } = await fixture()
    const path = join(directory, 'rewritten.jsonl')
    await writeFile(path, header('rewritten', cwd))
    const cachePath = join(root, 'sessions.json')
    await writeFile(cachePath, `${JSON.stringify({
      version: 1,
      sessions: [{
        id: 'rewritten',
        path,
        cwd: join(root, 'stale-project'),
        title: 'Stale location',
        firstMessage: '',
        messageCount: 0,
        createdAt: 1,
        modifiedAt: 1,
      }],
    })}\n`)
    const catalog = new PiSessionCatalog({ agentDir, cachePath, scope: 'cwd' })

    await catalog.list(cwd)

    const persisted = JSON.parse(await readFile(cachePath, 'utf8')).sessions as Array<{ path: string; cwd: string }>
    expect(persisted.filter((session) => session.path === path)).toEqual([
      expect.objectContaining({ cwd }),
    ])
  })

  it('reconciles once when a write races initial watcher attachment', async () => {
    const { agentDir, cwd, directory } = await fixture()
    const catalog = new PiSessionCatalog({ agentDir, cachePath: false, scope: 'cwd' })
    let changes = 0
    const unsubscribe = catalog.subscribe(cwd, () => { changes += 1 })
    try {
      await writeFile(join(directory, 'immediate.jsonl'), header('immediate', cwd))
      await waitFor(() => changes > 0)
      await Bun.sleep(200)
      expect(changes).toBe(1)
      expect((await catalog.list(cwd)).map((session) => session.id)).toContain('immediate')
    } finally {
      unsubscribe()
    }
  })

  it('does not turn failed watch retries into perpetual catalog scans', async () => {
    const { root } = await fixture()
    let changes = 0
    const close = watchPiSessions(join(root, 'missing'), () => { changes += 1 }, {
      recursive: false,
      debounceMs: 5,
      retryMs: 15,
    })
    try {
      await Bun.sleep(80)
      expect(changes).toBe(1)
    } finally {
      close()
    }
  })

  it('shares one watcher lifecycle and stops every callback after the last unsubscribe', async () => {
    const { agentDir, cwd, directory } = await fixture()
    const catalog = new PiSessionCatalog({ agentDir, cachePath: false, scope: 'cwd' })
    let first = 0
    let second = 0
    const unsubscribeFirst = catalog.subscribe(cwd, () => { first += 1 })
    const unsubscribeSecond = catalog.subscribe(cwd, () => { second += 1 })

    await Bun.sleep(30)
    expect([first, second]).toEqual([0, 0])
    await writeFile(join(directory, 'initial.jsonl'), header('initial', cwd))
    await waitFor(() => first > 0 && second > 0)
    const firstBaseline = first
    const secondBaseline = second
    unsubscribeFirst()
    await writeFile(join(directory, 'one.jsonl'), header('one', cwd))
    await waitFor(() => second > secondBaseline)
    expect(first).toBe(firstBaseline)

    const stoppedAt = second
    unsubscribeSecond()
    await appendFile(join(directory, 'one.jsonl'), '\n')
    await Bun.sleep(250)
    expect(second).toBe(stoppedAt)
  })

  it('releases its catalog subscription and ignores late invalidations on dispose', async () => {
    const { cwd } = await fixture()
    let invalidate: () => void = () => undefined
    let unsubscribes = 0
    let scans = 0
    const sessionCatalog = {
      subscribe: (_cwd: string, listener: () => void) => {
        invalidate = listener
        return () => { unsubscribes += 1 }
      },
      createWorkspaceSession: async () => { throw new Error('unused') },
      list: async () => { scans += 1; return [] },
    }
    const controller = new WorkbenchController(new DemoTransport(), cwd, {
      sessionCatalog,
      workspaceDiff: { load: async () => ({ status: 'ready', branch: '', files: [], additions: 0, deletions: 0 }) },
    })
    await controller.start()
    await waitFor(() => scans === 1 && !controller.getSnapshot().sessionsLoading)
    const loading: boolean[] = []
    const unsubscribeState = controller.subscribe(() => { loading.push(controller.getSnapshot().sessionsLoading) })
    invalidate()
    await waitFor(() => scans === 2)
    await Bun.sleep(0)
    expect(loading).not.toContain(true)
    unsubscribeState()

    await controller.dispose()
    const disposedAt = scans
    invalidate()
    await Bun.sleep(25)
    expect(unsubscribes).toBe(1)
    expect(scans).toBe(disposedAt)
  })

  it('replays a watcher invalidation that arrives during a controller scan', async () => {
    const { cwd } = await fixture()
    let invalidate!: () => void
    let release!: () => void
    let calls = 0
    const gate = new Promise<void>((resolve) => { release = resolve })
    const sessionCatalog = {
      subscribe: (_cwd: string, listener: () => void) => { invalidate = listener; return () => undefined },
      createWorkspaceSession: async () => { throw new Error('unused') },
      list: async () => {
        calls += 1
        if (calls === 1) await gate
        return []
      },
    }
    const controller = new WorkbenchController(new DemoTransport(), cwd, {
      sessionCatalog,
      workspaceDiff: { load: async () => ({ status: 'ready', branch: '', files: [], additions: 0, deletions: 0 }) },
    })
    const starting = controller.start()
    try {
      invalidate()
      release()
      await starting
      await waitFor(() => calls === 2)
      expect(calls).toBe(2)
    } finally {
      release()
      await starting
      await controller.dispose()
    }
  })
})
