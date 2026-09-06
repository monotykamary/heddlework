import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  loadNativeRuntimeManifest,
  platformTargetKey,
  sha256File,
  verifyNativeRuntime,
  type NativeRuntimeManifest,
} from '../src/core/native-runtime.ts'

const repoRoot = resolve(import.meta.dir, '..')
const fixtures: string[] = []

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'heddlework-native-runtime-'))
  fixtures.push(root)
  return root
}

function seedRuntimeFixture(
  root: string,
  options: { includeAddon?: boolean; browserTypes?: boolean } = {},
): NativeRuntimeManifest {
  const patchBody = 'diff --git a/example b/example\n'
  mkdirSync(join(root, 'patches'), { recursive: true })
  writeFileSync(join(root, 'patches', 'gpuix-0.7.0-heddlework.patch'), patchBody)

  const manifest: NativeRuntimeManifest = {
    heddlework: {
      commit: 'test0000',
      patch: 'patches/gpuix-0.7.0-heddlework.patch',
      patchSha256: createHash('sha256').update(patchBody).digest('hex'),
    },
    gpuix: { react: '0.7.0', native: '0.7.0', source: 'https://example.test/gpuix' },
    targets: [
      {
        target: platformTargetKey(process.platform, process.arch),
        package: '@gpuix/native-fake-platform',
        addon: 'gpuix-native.fake.node',
      },
    ],
    capabilities: [
      {
        id: 'native.test-renderer',
        kind: 'native-export',
        export: 'hasTestGpuixRenderer',
        component: 'core',
        required: true,
      },
      {
        id: 'render.browser-options',
        kind: 'react-type',
        patterns: ['browserRootCachePath'],
        component: 'browser',
        required: false,
      },
    ],
  }
  writeFileSync(join(root, 'native-runtime.json'), JSON.stringify(manifest))

  mkdirSync(join(root, 'node_modules/@gpuix/native'), { recursive: true })
  writeFileSync(join(root, 'node_modules/@gpuix/native/index.d.ts'), 'export declare function hasTestGpuixRenderer(): boolean\n')
  writeFileSync(join(root, 'node_modules/@gpuix/native/package.json'), JSON.stringify({ version: '0.7.0' }))
  mkdirSync(join(root, 'node_modules/@gpuix/react/dist'), { recursive: true })
  writeFileSync(join(root, 'node_modules/@gpuix/react/package.json'), JSON.stringify({ version: '0.7.0' }))
  writeFileSync(
    join(root, 'node_modules/@gpuix/react/dist/index.d.ts'),
    options.browserTypes ? 'export interface RenderOptions { browserRootCachePath?: string }\n' : 'export interface RenderOptions {}\n',
  )
  if (options.includeAddon !== false) {
    mkdirSync(join(root, 'node_modules/@gpuix/native-fake-platform'), { recursive: true })
    writeFileSync(join(root, 'node_modules/@gpuix/native-fake-platform/gpuix-native.fake.node'), '')
  }
  return manifest
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('native-runtime manifest', () => {
  it('loads from the repository and matches the checked-in patch', () => {
    const manifest = loadNativeRuntimeManifest(repoRoot)
    expect(manifest.gpuix.react).toBe('0.7.0')
    expect(sha256File(join(repoRoot, manifest.heddlework.patch))).toBe(manifest.heddlework.patchSha256)
  })

  it('declares a native target for the running platform', () => {
    const manifest = loadNativeRuntimeManifest(repoRoot)
    expect(manifest.targets.map((target) => target.target)).toContain(platformTargetKey(process.platform, process.arch))
  })
})

describe('verifyNativeRuntime', () => {
  it('passes on this checkout with the required capabilities satisfied', () => {
    const report = verifyNativeRuntime({ root: repoRoot })
    const failed = report.checks.filter((check) => !check.ok && check.required)
    expect(failed).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('degrades optional capabilities that the published runtime lacks', () => {
    const root = makeFixtureRoot()
    seedRuntimeFixture(root)
    const report = verifyNativeRuntime({ root })

    expect(report.ok).toBe(true)
    const browser = report.checks.find((check) => check.id === 'capability.render.browser-options')
    expect(browser?.ok).toBe(false)
    expect(browser?.required).toBe(false)
    const renderer = report.checks.find((check) => check.id === 'capability.native.test-renderer')
    expect(renderer?.ok).toBe(true)
  })

  it('reports missing appId declarations and recognizes the patched native window option', () => {
    const root = makeFixtureRoot()
    const manifest = seedRuntimeFixture(root)
    const appId = loadNativeRuntimeManifest(repoRoot).capabilities.find((entry) => entry.id === 'native.window-app-id')
    expect(appId).toBeDefined()
    manifest.capabilities.push(appId!)
    writeFileSync(join(root, 'native-runtime.json'), JSON.stringify(manifest))
    const missing = verifyNativeRuntime({ root })
    expect(missing.ok).toBe(true)
    expect(missing.checks.find((check) => check.id === 'capability.native.window-app-id')).toMatchObject({
      ok: false, required: false, component: 'desktop',
    })
    writeFileSync(join(root, 'node_modules/@gpuix/native/index.d.ts'),
      'export declare function hasTestGpuixRenderer(): boolean\nexport interface WindowOptions { appId?: string }\n')
    const patched = verifyNativeRuntime({ root })
    expect(patched.checks.find((check) => check.id === 'capability.native.window-app-id')?.ok).toBe(true)
  })

  it('fails when the required platform addon is missing', () => {
    const root = makeFixtureRoot()
    seedRuntimeFixture(root, { includeAddon: false })
    const report = verifyNativeRuntime({ root })

    expect(report.ok).toBe(false)
    const addon = report.checks.find((check) => check.id === 'native.addon')
    expect(addon?.ok).toBe(false)
    expect(addon?.required).toBe(true)
  })

  it('reports capabilities as satisfied once the runtime declares them', () => {
    const root = makeFixtureRoot()
    seedRuntimeFixture(root, { browserTypes: true })
    const report = verifyNativeRuntime({ root })

    const browser = report.checks.find((check) => check.id === 'capability.render.browser-options')
    expect(browser?.ok).toBe(true)
  })

  it('fails when the patch does not match its recorded checksum', () => {
    const root = makeFixtureRoot()
    const manifest = seedRuntimeFixture(root)
    writeFileSync(join(root, 'patches', 'gpuix-0.7.0-heddlework.patch'), 'tampered\n')
    const report = verifyNativeRuntime({ root })

    expect(report.ok).toBe(false)
    const patch = report.checks.find((check) => check.id === 'patch.checksum')
    expect(patch?.ok).toBe(false)
    expect(patch?.detail).toContain(manifest.heddlework.patchSha256)
  })

  it('rejects a malformed manifest instead of trusting the shape', () => {
    const root = makeFixtureRoot()
    seedRuntimeFixture(root)
    // Corrupt a capability after seeding: drop the export name from a native-export.
    const manifestPath = join(root, 'native-runtime.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.capabilities = manifest.capabilities.filter((cap: { kind: string }) => cap.kind !== 'native-export')
    manifest.capabilities.push({ id: 'native.empty', kind: 'native-export', export: '', component: 'core', required: true })
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const report = verifyNativeRuntime({ root })
    expect(report.ok).toBe(false)
    const load = report.checks.find((check) => check.id === 'manifest.load')
    expect(load?.ok).toBe(false)
  })

  it('fails a required check when @gpuix/native does not match the manifest pin', () => {
    const root = makeFixtureRoot()
    const manifest = seedRuntimeFixture(root)
    writeFileSync(join(root, 'node_modules/@gpuix/native/package.json'), JSON.stringify({ version: '0.6.9' }))
    expect(manifest).toBeDefined()
    const report = verifyNativeRuntime({ root })

    expect(report.ok).toBe(false)
    const check = report.checks.find((c) => c.id === 'gpuix.native.version')
    expect(check?.ok).toBe(false)
    expect(check?.required).toBe(true)
  })

  it('does not treat a class method mentioned in index.d.ts as a module export', () => {
    const root = makeFixtureRoot()
    const manifest = seedRuntimeFixture(root)
    // native-export name that only exists as a class method, not a module function.
    manifest.capabilities = [
      ...manifest.capabilities,
      { id: 'native.terminal-frame', kind: 'native-export', export: 'setTerminalFrame', component: 'terminal', required: false },
    ]
    writeFileSync(join(root, 'native-runtime.json'), JSON.stringify(manifest))
    writeFileSync(join(root, 'node_modules/@gpuix/native/index.d.ts'), 'export declare class GpuixRenderer { setTerminalFrame(id: number): void }\n')

    const report = verifyNativeRuntime({ root })
    const check = report.checks.find((c) => c.id === 'capability.native.terminal-frame')
    expect(check?.ok).toBe(false)
    expect(check?.required).toBe(false)
  })
});
