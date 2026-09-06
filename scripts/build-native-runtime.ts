#!/usr/bin/env bun
// Reproducible patched-GPUIX source build.
//
//   bun scripts/build-native-runtime.ts           verify the pinned commits and that both patch sections apply cleanly
//   bun scripts/build-native-runtime.ts --apply   additionally apply the patch sections to the checkouts
//   bun scripts/build-native-runtime.ts --build   additionally build the patched native addon and react package
//
// The checkout lives in $HEDDLEWORK_GPUIX_DIR or external/gpuix. Commits come
// from native-runtime.json; the patch file and its checksum are verified first.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadNativeRuntimeManifest, sha256File } from '../src/core/native-runtime.ts'

const mode = process.argv[2] === '--build' ? 'build' : process.argv[2] === '--apply' ? 'apply' : 'verify'
const repoRoot = resolve(import.meta.dir, '..')
const manifest = loadNativeRuntimeManifest(repoRoot)
const gpuixSourceCommit = manifest.gpuix.sourceCommit
const zedSubmodule = manifest.gpuix.zedSubmodule
if (!gpuixSourceCommit || !zedSubmodule) {
  console.error('native-runtime.json lacks gpuix.sourceCommit or gpuix.zedSubmodule; the source build pins are not recorded')
  process.exit(1)
}
const gpuixDir = resolve(process.env.HEDDLEWORK_GPUIX_DIR ?? join(repoRoot, 'external', 'gpuix'))
const zedDir = join(gpuixDir, 'zed')
const patchPath = join(repoRoot, manifest.heddlework.patch)

function runQuiet(command: string[], cwd: string): string {
  // Non-throwing variant: returns stdout (plus stderr) whatever the exit code.
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode === 0) return new TextDecoder().decode(result.stdout)
  return new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const stderr = new TextDecoder().decode(result.stderr).trim()
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed in ${cwd}${stderr ? `: ${stderr}` : ''}`)
  return new TextDecoder().decode(result.stdout)
}

function git(args: string[], cwd: string): string {
  return run(['git', ...args], cwd)
}

function ensureCheckout(dir: string, remote: string, commit: string, label: string): void {
  if (!existsSync(join(dir, '.git'))) {
    console.log(`  ${label}: fetching ${remote} at ${commit.slice(0, 12)} into ${dir}`)
    mkdirSync(dir, { recursive: true })
    run(['git', 'init', '-q', dir], dir)
    git(['remote', 'add', 'origin', remote], dir)
  } else {
    const head = git(['rev-parse', 'HEAD'], dir).trim()
    if (head === commit) {
      console.log(`  ${label}: already at ${commit.slice(0, 12)}`)
      return
    }
    const dirty = runQuiet(['git', 'status', '--porcelain'], dir).trim()
    if (dirty) {
      throw new Error(`${label} checkout would discard uncommitted changes in ${dir}: ${dirty.split('\n')[0]}. Commit, stash, or use a separate HEDDLEWORK_GPUIX_DIR.`)
    }
    console.log(`  ${label}: moving ${head.slice(0, 12)} to ${commit.slice(0, 12)}`)
  }
  git(['fetch', '-q', '--depth', '1', 'origin', commit], dir)
  git(['checkout', '-q', '-f', 'FETCH_HEAD'], dir)
  const head = git(['rev-parse', 'HEAD'], dir).trim()
  if (head !== commit) throw new Error(`${label} checkout resolved to ${head}, expected ${commit}`)
}

function splitPatch(patch: string): { gpuixSection: string; zedSection: string } {
  // Byte-exact split: slices preserve the newlines the patch format depends on.
  const boundary = patch.search(/^diff --git a\/crates\//m)
  if (boundary === -1) throw new Error('patch has no zed submodule section (no diff --git a/crates/ boundary)')
  return { gpuixSection: patch.slice(0, boundary), zedSection: patch.slice(boundary) }
}

const actual = sha256File(patchPath)
if (actual !== manifest.heddlework.patchSha256) {
  console.error(`${manifest.heddlework.patch} sha256 mismatch: expected ${manifest.heddlework.patchSha256}, found ${actual}`)
  process.exit(1)
}
console.log(`Heddlework native runtime source build (${mode} mode)`)
console.log(`  patch: ${manifest.heddlework.patch} sha256 verified`)
ensureCheckout(gpuixDir, manifest.gpuix.source, gpuixSourceCommit, 'gpuix')
ensureCheckout(zedDir, zedSubmodule.remote, zedSubmodule.commit, 'zed')

const { gpuixSection, zedSection } = splitPatch(readFileSync(patchPath, 'utf8'))
const staging = mkdtempSync(join(tmpdir(), 'heddlework-native-runtime-'))
try {
  const sections = [
    { label: 'gpuix', cwd: gpuixDir, body: gpuixSection },
    { label: 'zed', cwd: zedDir, body: zedSection },
] as const
  for (const section of sections) {
    const sectionPath = join(staging, `${section.label}-section.patch`)
    writeFileSync(sectionPath, section.body)
    if (mode === 'verify') {
      git(['apply', '--check', sectionPath], section.cwd)
      console.log(`  ${section.label}: patch section applies cleanly`)
    } else {
      // Idempotent: a section that is already applied reverses cleanly, so a
      // second --apply / --build run skips it instead of erroring on git apply.
      const reverse = Bun.spawnSync(['git', 'apply', '--reverse', '--check', sectionPath], { cwd: section.cwd, stdout: 'pipe', stderr: 'pipe' })
      if (reverse.exitCode === 0) {
        console.log(`  ${section.label}: patch section already applied`)
      } else {
        git(['apply', sectionPath], section.cwd)
        console.log(`  ${section.label}: patch section applied`)
      }
    }
  }
} finally {
  rmSync(staging, { recursive: true, force: true })
}

if (mode === 'build') {
  console.log('  installing GPUIX workspace dependencies')
  run(['bun', 'install'], gpuixDir)
  console.log('  building @gpuix/native (napi release with test-support)')
  run(['bun', 'run', 'build'], join(gpuixDir, 'packages', 'native'))
  console.log('  building @gpuix/react (tsc)')
  run(['bun', 'run', 'build'], join(gpuixDir, 'packages', 'react'))
  console.log('  consuming the patched runtime locally:')
  console.log(`    bun install --force @gpuix/react@file:${join(gpuixDir, 'packages', 'react')} @gpuix/native@file:${join(gpuixDir, 'packages', 'native')}`)
  console.log('  record the switch in native-runtime.json when it becomes the committed runtime')
}
