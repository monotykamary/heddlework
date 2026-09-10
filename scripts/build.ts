import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { readCefArtifactInventory, verifyCefArtifactInventory } from './cef-artifacts.ts'

const root = resolve(import.meta.dir, '..')
const appVersion = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
const dist = resolve(root, 'dist')
const nativeDirectory = resolveNativeDirectory()
const withoutChromium = process.env.HEDDLEWORK_WITHOUT_CEF === '1'
const cefDirectory = nativeDirectory && !withoutChromium ? resolve(nativeDirectory, 'cef') : undefined
const bundleChromium = process.platform === 'darwin' && cefDirectory != null && existsSync(cefDirectory)
let cefStagingRoot: string | undefined
let cefPackagingDirectory: string | undefined
let nativePackagingDirectory: string | undefined
if (process.platform === 'darwin' && !withoutChromium) {
  if (!nativeDirectory || !cefDirectory || !bundleChromium) {
    throw new Error('A macOS production build requires a CEF-enabled @gpuix/native package; set HEDDLEWORK_WITHOUT_CEF=1 only for an explicit browser-free build')
  }
  const staged = stageCefArtifacts(nativeDirectory, cefDirectory)
  cefStagingRoot = staged.root
  cefPackagingDirectory = staged.cef
  nativePackagingDirectory = staged.native
}
const appBundle = resolve(dist, 'Heddlework.app')
const output = bundleChromium
  ? resolve(appBundle, 'Contents', 'MacOS', 'Heddlework')
  : resolve(dist, process.platform === 'win32' ? 'heddlework.exe' : 'heddlework')

try {
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dirname(output), { recursive: true })
  await import('./build-web.ts')

  const compile: { outfile: string; target?: Bun.Build.CompileTarget } = { outfile: output }
  if (process.env.COMPILE_TARGET) compile.target = process.env.COMPILE_TARGET as Bun.Build.CompileTarget

  const result = await Bun.build({
    entrypoints: [resolve(root, 'src/main.tsx')],
    compile,
    minify: true,
    sourcemap: 'external',
    ...(nativePackagingDirectory ? { plugins: [verifiedNativePlugin(nativePackagingDirectory)] } : {}),
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('Failed to compile Heddlework')
  }

  if (process.platform !== 'win32') chmodSync(output, 0o755)
  if (bundleChromium) {
    // Bun versions use either the output name or the entrypoint for external maps.
    // Debug data cannot remain in Contents/MacOS, where codesign expects code.
    for (const sourceMap of [`${output}.map`, resolve(dirname(output), 'main.js.map')]) {
      if (existsSync(sourceMap)) renameSync(sourceMap, resolve(dist, 'Heddlework.js.map'))
    }
  }
  if (bundleChromium && cefPackagingDirectory && nativePackagingDirectory) {
    validateCefArtifacts(nativePackagingDirectory, cefPackagingDirectory)
    packageMacApp(appBundle, cefPackagingDirectory, output)
  }
  console.log(`Built ${bundleChromium ? appBundle : output}`)
} finally {
  if (cefStagingRoot) rmSync(cefStagingRoot, { recursive: true, force: true })
}

function stageCefArtifacts(nativeRoot: string, cefSource: string): { root: string; cef: string; native: string } {
  const stagingRoot = mkdtempSync(join(tmpdir(), 'heddlework-cef-stage-'))
  const stagedNative = join(stagingRoot, 'native')
  const stagedCef = join(stagedNative, 'cef')
  const nativeName = `gpuix-native.darwin-${process.arch}.node`
  try {
    mkdirSync(stagedNative)
    cpSync(resolve(nativeRoot, 'index.js'), resolve(stagedNative, 'index.js'))
    cpSync(resolveNativeAddon(nativeRoot, nativeName), resolve(stagedNative, nativeName))
    cpSync(cefSource, stagedCef, { recursive: true, verbatimSymlinks: true })
    validateCefArtifacts(stagedNative, stagedCef)
    return { root: stagingRoot, cef: stagedCef, native: stagedNative }
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true })
    throw error
  }
}

function verifiedNativePlugin(stagedNative: string): Bun.BunPlugin {
  return {
    name: 'verified-native-package',
    setup(build) {
      build.onResolve({ filter: /^@gpuix\/native$/u }, () => ({
        path: resolve(stagedNative, 'index.js'),
      }))
    },
  }
}

function packageMacApp(bundle: string, cefSource: string, executable: string): void {
  const contents = resolve(bundle, 'Contents')
  const frameworks = resolve(contents, 'Frameworks')
  const resources = resolve(contents, 'Resources')
  mkdirSync(frameworks, { recursive: true })
  mkdirSync(resources, { recursive: true })
  const chromiumFramework = resolve(frameworks, 'Chromium Embedded Framework.framework')
  cpSync(
    resolve(cefSource, 'Chromium Embedded Framework.framework'),
    chromiumFramework,
    { recursive: true, verbatimSymlinks: true },
  )
  readCefArtifactInventory(chromiumFramework)
  signBundle(chromiumFramework)
  copyChromiumHelpers(cefSource, frameworks)
  if (existsSync(resolve(cefSource, 'CREDITS.html'))) {
    cpSync(resolve(cefSource, 'CREDITS.html'), resolve(resources, 'Chromium-CREDITS.html'))
  }
  cpSync(resolve(dist, 'web'), resolve(resources, 'web'), { recursive: true })
  writeFileSync(resolve(contents, 'Info.plist'), appInfoPlist())

  const launcher = resolve(dist, 'heddlework')
  symlinkSync(relative(dist, executable), launcher)
  signBundle(bundle)
  verifyBundle(bundle)
}

function copyChromiumHelpers(cefSource: string, frameworks: string): void {
  const variants = [
    { nameSuffix: '', identifierSuffix: '' },
    { nameSuffix: ' (Alerts)', identifierSuffix: '.alerts' },
    { nameSuffix: ' (GPU)', identifierSuffix: '.gpu' },
    { nameSuffix: ' (Plugin)', identifierSuffix: '.plugin' },
    { nameSuffix: ' (Renderer)', identifierSuffix: '.renderer' },
  ]
  for (const variant of variants) {
    const sourceName = `GPUix Chromium Helper${variant.nameSuffix}`
    const helperName = `Heddlework Helper${variant.nameSuffix}`
    const source = resolve(cefSource, `${sourceName}.app`)
    if (!existsSync(source)) throw new Error(`Missing required Chromium helper bundle: ${source}`)

    const destination = resolve(frameworks, `${helperName}.app`)
    cpSync(source, destination, { recursive: true, verbatimSymlinks: true })
    const contents = resolve(destination, 'Contents')
    renameSync(resolve(contents, 'MacOS', sourceName), resolve(contents, 'MacOS', helperName))
    writeFileSync(resolve(contents, 'Info.plist'), helperInfoPlist(helperName, variant.identifierSuffix))
    writeFileSync(resolve(contents, 'PkgInfo'), 'APPL????')
    signBundle(destination)
  }
}

function signBundle(path: string): void {
  const signed = Bun.spawnSync(
    ['codesign', '--force', '--sign', '-', '--timestamp=none', path],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  if (signed.exitCode !== 0) throw new Error(`Failed to ad-hoc sign ${path}`)
}

function verifyBundle(bundle: string): void {
  const verified = Bun.spawnSync(
    ['codesign', '--verify', '--deep', '--strict', '--verbose=2', bundle],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  if (verified.exitCode !== 0) throw new Error(`Failed to verify ${bundle}`)

  const executables = [
    resolve(bundle, 'Contents', 'MacOS', 'Heddlework'),
    resolve(bundle, 'Contents', 'Frameworks', 'Chromium Embedded Framework.framework', 'Chromium Embedded Framework'),
    ...['', ' (Alerts)', ' (GPU)', ' (Plugin)', ' (Renderer)'].map((suffix) =>
      resolve(bundle, 'Contents', 'Frameworks', `Heddlework Helper${suffix}.app`, 'Contents', 'MacOS', `Heddlework Helper${suffix}`),
    ),
  ]
  for (const executable of executables) assertMachOMinimum(executable, '13.0')
}

interface CefArtifactManifest {
  schemaVersion: number
  cefVersion: string
  cefApiVersion: number
  platform: string
  arch: string
  minMacOS: string
  nativeAddon: { path: string; sha256: string }
  artifacts: unknown
}

function validateCefArtifacts(nativeRoot: string, cefRoot: string): void {
  const manifestPath = resolve(cefRoot, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`CEF artifact manifest is missing: ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CefArtifactManifest
  if (manifest.schemaVersion !== 2 || manifest.platform !== 'darwin' || manifest.arch !== process.arch || manifest.minMacOS !== '13.0' || !Number.isSafeInteger(manifest.cefApiVersion)) {
    throw new Error('CEF artifact manifest is incompatible with this Heddlework build')
  }
  const nativeName = `gpuix-native.darwin-${process.arch}.node`
  verifyArtifact(resolveNativeAddon(nativeRoot, nativeName), manifest.nativeAddon, nativeName)
  verifyCefArtifactInventory(cefRoot, manifest.artifacts)
  const requiredExecutables = [
    'Chromium Embedded Framework.framework/Chromium Embedded Framework',
    ...['', ' (Alerts)', ' (GPU)', ' (Plugin)', ' (Renderer)'].map((suffix) => {
      const name = `GPUix Chromium Helper${suffix}`
      return `${name}.app/Contents/MacOS/${name}`
    }),
  ]
  for (const path of requiredExecutables) {
    const entry = manifest.artifacts && typeof manifest.artifacts === 'object'
      ? (manifest.artifacts as Record<string, { type?: string }>)[path]
      : undefined
    if (entry?.type !== 'file') throw new Error(`CEF artifact manifest omits ${path}`)
  }
}

function verifyArtifact(path: string, entry: { path: string; sha256: string }, expectedPath: string): void {
  if (entry.path !== expectedPath || !/^[a-f0-9]{64}$/u.test(entry.sha256) || sha256(path) !== entry.sha256) {
    throw new Error(`CEF artifact does not match its manifest: ${expectedPath}`)
  }
}

function sha256(path: string): string {
  const result = Bun.spawnSync(['/usr/bin/shasum', '-a', '256', path])
  if (result.exitCode !== 0) throw new Error(`Could not hash ${path}`)
  return new TextDecoder().decode(result.stdout).trim().split(/\s+/u)[0] ?? ''
}

function assertMachOMinimum(path: string, declaredMinimum: string): void {
  const result = Bun.spawnSync(['/usr/bin/vtool', '-show-build', path])
  const output = new TextDecoder().decode(result.stdout)
  const actual = output.match(/^\s*minos\s+(\d+(?:\.\d+)*)$/mu)?.[1]
  if (result.exitCode !== 0 || !actual || compareVersions(actual, declaredMinimum) > 0) {
    throw new Error(`${path} requires macOS ${actual ?? 'unknown'}, beyond the declared ${declaredMinimum}`)
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function resolveNativeAddon(nativeRoot: string, nativeName: string): string {
  const colocated = resolve(nativeRoot, nativeName)
  if (existsSync(colocated)) return colocated

  const require = createRequire(import.meta.url)
  try {
    const installed = require.resolve(`@gpuix/native-darwin-${process.arch}`)
    if (existsSync(installed)) return installed
  } catch {
    // Report the unified artifact error below.
  }
  throw new Error(`CEF native addon is missing: expected ${nativeName} beside @gpuix/native or in its Darwin platform package`)
}

function resolveNativeDirectory(): string | undefined {
  const require = createRequire(import.meta.url)
  try {
    return dirname(require.resolve('@gpuix/native/package.json'))
  } catch {
    try {
      const reactDirectory = dirname(require.resolve('@gpuix/react/package.json'))
      const sibling = resolve(reactDirectory, '..', 'native')
      return existsSync(sibling) ? sibling : undefined
    } catch {
      return undefined
    }
  }
}

function appInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Heddlework</string>
  <key>CFBundleExecutable</key><string>Heddlework</string>
  <key>CFBundleIdentifier</key><string>works.heddlework.app</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Heddlework</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${appVersion}</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleVersion</key><string>${appVersion}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
`
}

function helperInfoPlist(executable: string, identifierSuffix: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${executable}</string>
  <key>CFBundleExecutable</key><string>${executable}</string>
  <key>CFBundleIdentifier</key><string>works.heddlework.app.helper${identifierSuffix}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${executable}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${appVersion}</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleVersion</key><string>${appVersion}</string>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
  <key>LSFileQuarantineEnabled</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
`
}
