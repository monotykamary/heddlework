// Shared verification for the Heddlework native runtime contract in
// native-runtime.json: the pinned GPUIX patch, the installed platform addon,
// and the runtime capabilities the application depends on.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const repoRootDefault = resolve(import.meta.dir, '..', '..')

export interface NativeRuntimeCapability {
  id: string
  kind: 'native-export' | 'react-type'
  export?: string
  patterns?: string[]
  /** Restrict a react-type probe to the body of one interface, e.g. "MotionStyle". */
  scope?: string
  component: string
  required: boolean
  note?: string
}

export interface NativeRuntimeTarget {
  target: string
  package: string
  addon: string
}

export interface NativeRuntimeManifest {
  heddlework: { commit: string; patch: string; patchSha256: string }
  gpuix: {
    react: string
    native: string
    source: string
    sourceCommit?: string
    sourceTag?: string
    zedSubmodule?: { remote: string; branch: string; commit: string }
    patchSections?: string[]
  }
  toolchain?: { bun?: string; rust?: string }
  targets: NativeRuntimeTarget[]
  capabilities: NativeRuntimeCapability[]
}

export interface NativeRuntimeCheck {
  id: string
  ok: boolean
  required: boolean
  component: string
  detail: string
  remediation?: string
}

export interface NativeRuntimeReport {
  ok: boolean
  manifest?: NativeRuntimeManifest
  checks: NativeRuntimeCheck[]
}

export interface VerifyNativeRuntimeOptions {
  root?: string
  platform?: NodeJS.Platform
  arch?: string
}

export function platformTargetKey(platform: string, arch: string): string {
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu'
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  return `${platform}-${arch}`
}

export function loadNativeRuntimeManifest(root = repoRootDefault): NativeRuntimeManifest {
  return JSON.parse(readFileSync(join(root, 'native-runtime.json'), 'utf8')) as NativeRuntimeManifest
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function collectDtsFiles(directory: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 6 || !existsSync(directory)) return acc
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collectDtsFiles(path, depth + 1, acc)
    else if (entry.name.endsWith('.d.ts')) acc.push(path)
  }
  return acc
}

function interfaceBody(source: string, name: string): string {
  const start = source.indexOf(`interface ${name}`)
  if (start === -1) return ''
  const bodyStart = source.indexOf('{', start)
  if (bodyStart === -1) return ''
  const end = source.indexOf('\n}', bodyStart)
  return end === -1 ? source.slice(bodyStart) : source.slice(bodyStart, end)
}

function remediationFor(manifest: NativeRuntimeManifest, capability: NativeRuntimeCapability): string {
  const reason = capability.note ? `${capability.note} `: ''
  return `${reason}Build the patched runtime from a GPUIX checkout with ${manifest.heddlework.patch} applied, or upgrade to an upstream release that ships it.`
}

export function verifyNativeRuntime(options: VerifyNativeRuntimeOptions = {}): NativeRuntimeReport {
  const root = resolve(options.root ?? repoRootDefault)
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const checks: NativeRuntimeCheck[] = []

  let manifest: NativeRuntimeManifest
  try {
    manifest = loadNativeRuntimeManifest(root)
    checks.push({
      id: 'manifest.load',
      ok: true,
      required: true,
      component: 'core',
      detail: `native-runtime.json (heddlework ${manifest.heddlework.commit}, gpuix ${manifest.gpuix.native})`,
    })
  } catch (error) {
    checks.push({
      id: 'manifest.load',
      ok: false,
      required: true,
      component: 'core',
      detail: `could not load native-runtime.json: ${error instanceof Error ? error.message : String(error)}`,
      remediation: 'Run from a repository checkout that contains native-runtime.json.',
    })
    return { ok: false, checks }
  }

  const patchPath = join(root, manifest.heddlework.patch)
  if (existsSync(patchPath)) {
    const actual = sha256File(patchPath)
    const ok = actual === manifest.heddlework.patchSha256
    checks.push({
      id: 'patch.checksum',
      ok,
      required: true,
      component: 'core',
      detail: ok ? `${manifest.heddlework.patch} sha256 verified` : `${manifest.heddlework.patch} sha256 mismatch: expected ${manifest.heddlework.patchSha256}, found ${actual}`,
      ...(ok ? {} : { remediation: 'The patch file changed without updating native-runtime.json; regenerate patchSha256 over the new patch.' }),
    })
  } else {
    checks.push({
      id: 'patch.checksum',
      ok: false,
      required: true,
      component: 'core',
      detail: `${manifest.heddlework.patch} is missing`,
      remediation: 'Restore the patch file or update native-runtime.json to point at the current one.',
    })
  }

  const reactPackagePath = join(root, 'node_modules/@gpuix/react/package.json')
  if (existsSync(reactPackagePath)) {
    const installed = (JSON.parse(readFileSync(reactPackagePath, 'utf8')) as { version?: string }).version
    const ok = installed === manifest.gpuix.react
    checks.push({
      id: 'gpuix.version',
      ok,
      required: true,
      component: 'core',
      detail: ok ? `installed @gpuix/react@${installed} matches the manifest` : `installed @gpuix/react@${installed} does not match manifest ${manifest.gpuix.react}`,
      ...(ok ? {} : { remediation: 'Update native-runtime.json and bun.lock together so the manifest and lockfile agree.' }),
    })
  } else {
    checks.push({
      id: 'gpuix.version',
      ok: false,
      required: true,
      component: 'core',
      detail: 'node_modules/@gpuix/react is not installed',
      remediation: 'Run bun install --frozen-lockfile before verifying the native runtime.',
    })
  }

  const target = manifest.targets.find((entry) => entry.target === platformTargetKey(platform, arch))
  if (!target) {
    checks.push({
      id: 'native.addon',
      ok: false,
      required: true,
      component: 'core',
      detail: `no native target declared for ${platformTargetKey(platform, arch)}`,
      remediation: `native-runtime.json declares: ${manifest.targets.map((entry) => entry.target).join(', ')}`,
    })
  } else {
    const addonPath = join(root, 'node_modules', target.package, target.addon)
    const ok = existsSync(addonPath)
    checks.push({
      id: 'native.addon',
      ok,
      required: true,
      component: 'core',
      detail: ok ? `${target.package} present (${target.addon})` : `${relative(root, addonPath)} is missing`,
      ...(ok ? {} : { remediation: 'Run bun install --frozen-lockfile so the platform-specific @gpuix/native package is available.' }),
    })
  }

  const reactDts = collectDtsFiles(join(root, 'node_modules/@gpuix/react'))
  const nativeDtsPath = join(root, 'node_modules/@gpuix/native/index.d.ts')
  for (const capability of manifest.capabilities) {
    let ok = false
    let detail: string
    if (capability.kind === 'native-export') {
      const declared = existsSync(nativeDtsPath) && readFileSync(nativeDtsPath, 'utf8').includes(capability.export ?? '')
      ok = declared
      detail = declared
        ? `installed @gpuix/native declares ${capability.export}`
        : `installed @gpuix/native does not declare ${capability.export}`
    } else {
      const patterns = capability.patterns ?? []
      const haystack = reactDts.map((path) => readFileSync(path, 'utf8')).join('\n')
      const window = capability.scope ? interfaceBody(haystack, capability.scope) : haystack
      const missing = patterns.filter((pattern) => !window.includes(pattern))
      ok = patterns.length > 0 && missing.length === 0
      const where = capability.scope ? `${capability.scope} in installed @gpuix/react types` : 'installed @gpuix/react types'
      detail = ok
        ? `${where} declare ${patterns.join(', ')}`
        : `${where} lack ${missing.join(', ')}`
    }
    if (!ok) detail = `${detail} (${capability.component}, ${capability.required ? 'required' : 'optional'})`
    checks.push({
      id: `capability.${capability.id}`,
      ok,
      required: capability.required,
      component: capability.component,
      detail,
      ...(ok ? {} : { remediation: remediationFor(manifest, capability) }),
    })
  }

  return { ok: checks.every((check) => !check.required || check.ok), manifest, checks }
}
