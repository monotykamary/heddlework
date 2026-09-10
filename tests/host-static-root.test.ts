import { afterEach, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolveStaticRoot } from '../src/host/static-root.ts'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), 'heddlework-web-packaging-'))
  directories.push(path)
  return path
}
function shell(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(join(path, 'index.html'), '<h1>packaged shell</h1>')
}

it('discovers macOS bundle resources, adjacent Linux assets, and source builds', () => {
  const root = fixture()
  const source = join(root, 'source')
  const executable = join(root, 'Heddlework.app/Contents/MacOS/Heddlework')
  const resources = join(root, 'Heddlework.app/Contents/Resources/web')
  const adjacent = join(dirname(executable), 'web')
  const development = join(source, 'dist/web')
  expect(resolveStaticRoot({}, executable, source)).toBeUndefined()
  for (const path of [development, adjacent, resources]) {
    mkdirSync(path, { recursive: true })
    shell(path)
    expect(resolveStaticRoot({}, executable, source)).toBe(path)
  }
  expect(resolveStaticRoot({ HEDDLEWORK_WEB_ROOT: root }, executable, source)).toBe(root)
})

it('installs the companion web shell beside the Linux executable', async () => {
  const root = fixture()
  const binary = join(root, 'dist/heddlework')
  const pi = join(root, 'pi')
  mkdirSync(dirname(binary), { recursive: true })
  for (const path of [binary, pi]) {
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    chmodSync(path, 0o755)
  }
  const web = join(dirname(binary), 'web')
  mkdirSync(web)
  shell(web)
  writeFileSync(join(web, 'main.js'), 'console.log("packaged")')
  const app = join(root, 'installed')
  const child = Bun.spawn(['sh', resolve(import.meta.dir, '../packaging/linux/install-user.sh')], {
    env: {
      ...process.env,
      HEDDLEWORK_BUILD: binary,
      HEDDLEWORK_PI: pi,
      HEDDLEWORK_APP_DIR: app,
      HEDDLEWORK_BIN_DIR: join(root, 'bin'),
      XDG_DATA_HOME: join(root, 'data'),
    },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe('')
  expect(exit).toBe(0)
  expect(readFileSync(join(app, 'web/main.js'), 'utf8')).toBe('console.log("packaged")')
  expect(resolveStaticRoot({}, join(app, 'heddlework'), join(root, 'no-source'))).toBe(join(app, 'web'))
})
