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
  /** The package whose declarations a react-type probe searches; defaults to "react". */
  package?: 'react' | 'native'
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

function assertManifestShape(value: unknown, root: string): void {
  const invalid = (reason: string): Error => new Error(`native-runtime.json is malformed: ${reason}`)
  const target = value as NativeRuntimeManifest
  if (!target || typeof target !== 'object')
    throw invalid('expected an object')
  if (!Array.isArray(target.targets) || target.targets.some((entry) => !entry || !entry.target || !entry.package || !entry.addon))
    throw invalid('targets must be an array of { target, package, addon } objects')
  if (!Array.isArray(target.capabilities))
    throw invalid('capabilities must be an array')
  for (const capability of target.capabilities) {
    if (!capability || !capability.id || !capability.component || typeof capability.required !== 'boolean')
      throw invalid(`capability ${capability?.id ?? '(unnamed)'} lacks id, component, or required`)
    if (capability.kind === 'native-export' && !capability.export?.trim())
      throw invalid(`native-export capability ${capability.id} must declare a non-empty export name`)
    if (capability.kind === 'react-type' && (!capability.patterns || capability.patterns.length === 0))
      throw invalid(`react-type capability ${capability.id} must list at least one pattern`)
    if (capability.kind && capability.kind !== 'native-export' && capability.kind !== 'react-type')
      throw invalid(`capability ${capability.id} has unknown kind ${String(capability.kind)}`)
  }
}

export function loadNativeRuntimeManifest(root = repoRootDefault): NativeRuntimeManifest {
  const parsed = JSON.parse(readFileSync(join(root, 'native-runtime.json'), 'utf8')) as unknown
  assertManifestShape(parsed, root)
  return parsed as NativeRuntimeManifest
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

function declaresModuleExport(dts: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('export\\s+(?:declare\\s+)?(?:function|const|class|interface|type|var|let|enum)\\s+' + escaped + '\\b').test(dts)
}

function satisfiesVersion(installed: string, constraint: string): boolean {
  const parse = (part: string): number[] => part.split('.').map((n) => parseInt(n, 10) || 0)
  const cmp = (a: number[], b: number[]): number => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }
  const constraints = constraint.split(/\s*[&|]{1,2}\s*/)
  return constraints.every((single) => {
    single = single.trim()
    if (single === '*') return true
    const m = single.match(/^(>=|<=|>|<|=|^)?v?(.+)$/)
    if (!m) return false
    const op = m[1] ?? '='
    const targetText = m[2] ?? ''
    const target = parse(targetText)
    const current = parse(installed)
    const result = cmp(current, target)
    if (op === '>=') return result >= 0
    if (op === '>') return result > 0
    if (op === '<=') return result <= 0
    if (op === '<') return result < 0
    if (op === '^') return (current[0] ?? 0) >= (target[0] ?? 0) && result >= 0
    if (op === '~') return (current[0] ?? 0) === (target[0] ?? 0) && (current[1] ?? 0) === (target[1] ?? 0) && result >= 0
    return result === 0
  })
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

  const packageVersionCheck = (id: string, packageRel: string, pinned: string, label: string): void => {
    const pkgPath = join(root, 'node_modules', packageRel, 'package.json')
    if (!existsSync(pkgPath)) {
      checks.push({ id, ok: false, required: true, component: 'core', detail: `${label} is not installed`, remediation: 'Run bun install --frozen-lockfile before verifying the native runtime.' })
      return
    }
    const installed = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version
    const ok = installed === pinned
    checks.push({
      id, ok, required: true, component: 'core',
      detail: ok ? `installed ${label}@${installed} matches the manifest` : `installed ${label}@${installed} does not match manifest ${pinned}`,
      ...(ok ? {} : { remediation: 'Update native-runtime.json and bun.lock together so the manifest and lockfile agree.' }),
    })
  }
  packageVersionCheck('gpuix.react.version', '@gpuix/react', manifest.gpuix.react, '@gpuix/react')
  packageVersionCheck('gpuix.native.version', '@gpuix/native', manifest.gpuix.native, '@gpuix/native')

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

  if (manifest.toolchain?.bun) {
    const ok = satisfiesVersion(String(Bun.version ?? ''), manifest.toolchain.bun)
    checks.push({
      id: 'toolchain.bun', ok, required: true, component: 'core',
      detail: ok ? `Bun ${Bun.version} satisfies ${manifest.toolchain.bun}` : `Bun ${Bun.version} does not satisfy ${manifest.toolchain.bun}`,
      ...(ok ? {} : { remediation: `Install a Bun matching ${manifest.toolchain.bun} and re-run bun install --frozen-lockfile.` }),
    })
  }

    const reactDts = collectDtsFiles(join(root, 'node_modules/@gpuix/react'))
  const nativeDtsPath = join(root, 'node_modules/@gpuix/native/index.d.ts')
  const nativeDts = existsSync(nativeDtsPath) ? readFileSync(nativeDtsPath, 'utf8') : ''
  for (const capability of manifest.capabilities) {
    let ok = false
    let detail: string
    if (capability.kind === 'native-export') {
      const declared = capability.export ? declaresModuleExport(nativeDts, capability.export) : false
      ok = declared
      detail = declared
        ? `installed @gpuix/native declares ${capability.export}`
        : `installed @gpuix/native does not export ${capability.export}`
    } else {
      const patterns = capability.patterns ?? []
      const haystack = capability.package === 'native'
        ? nativeDts
        : reactDts.map((path) => readFileSync(path, 'utf8')).join('\n')
      const window = capability.scope ? interfaceBody(haystack, capability.scope) : haystack
      const missing = patterns.filter((pattern) => !window.includes(pattern))
      ok = patterns.length > 0 && missing.length === 0
      const wherePkg = capability.package === 'native' ? '@gpuix/native' : '@gpuix/react'
      const where = capability.scope ? `${capability.scope} in installed ${wherePkg} types` : `installed ${wherePkg} types`
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
