#!/usr/bin/env bun
// Reports whether the installed native runtime satisfies the contract in
// native-runtime.json. Exits nonzero only when a required check fails;
// optional-but-missing capabilities are reported as degraded.
import { verifyNativeRuntime } from '../src/core/native-runtime.ts'

const report = verifyNativeRuntime()

console.log('Heddlework native runtime verification')
for (const check of report.checks) {
  const state = check.ok ? 'ok' : check.required ? 'FAILED' : 'degraded'
  console.log(`  [${state}] ${check.id}: ${check.detail}`)
  if (!check.ok && check.remediation) console.log(`    → ${check.remediation}`)
}
const failed = report.checks.filter((check) => check.required && !check.ok).length
const degraded = report.checks.filter((check) => !check.required && !check.ok).length
const passed = report.checks.filter((check) => check.ok).length
console.log(`summary: ${passed} ok, ${degraded} degraded, ${failed} failed`)
if (failed > 0) process.exit(1)
