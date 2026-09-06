import React from 'react'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  createRenderer,
  createRoot,
  flushSync,
  startFrameLoop,
  useWindowSize,
  type DebugFrameOverlayMode,
  type DebugFrameOverlayStats,
  type Root,
} from '@gpuix/react'
import { BunPtyBackend, type TerminalBackend, type TerminalOutputMetadata, type TerminalProcess } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import type { TerminalProcessStatus, TerminalSessionId, TerminalSpawnRequest } from '../src/terminal/types.ts'
import { terminalGridSize } from '../src/ui/terminal-metrics.ts'
import { TerminalView } from '../src/ui/terminal-view.tsx'
import { createWindowOptions } from '../src/window-options.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const FIXTURE_PATH = resolve(import.meta.dir, 'terminal-gpuix-fixture.ts')
const DISCOVERED_OPENTUI = resolve(REPO_ROOT, '../opentui-examples')
const MEBIBYTE = 1024 * 1024

interface HarnessConfig {
  readonly workload: 'opentui-golden-star' | 'fixture' | 'custom'
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly selection: string | undefined
  readonly fixtureFps: number
  readonly width: number
  readonly height: number
  readonly fullscreen: boolean
  readonly background: boolean
  readonly durationSeconds: number
  readonly warmupSeconds: number
  readonly frameMs: number
  readonly overlay: DebugFrameOverlayMode
  readonly reportPath: string | undefined
}

interface TelemetryCounts {
  ptyCallbacks: number
  ptyBytes: number
  synchronizedPtyCallbacks: number
  resizes: number
  serviceFrames: number
  nativeStages: number
  nativeCellBytes: number
  nativeMetadataBytes: number
  reactCommits: number
  reactMutationBytes: number
  ticks: number
  stagesCoalescedBeforeTick: number
  ptyHandlerWallMs: number
  nativeStageWallMs: number
  reactCommitWallMs: number
  tickWallMs: number
}

interface Distribution {
  readonly count: number
  readonly p50Ms: number
  readonly p90Ms: number
  readonly p99Ms: number
  readonly maxMs: number
}

class Samples {
  readonly #values: number[] = []

  add(value: number): void {
    if (Number.isFinite(value) && value >= 0) this.#values.push(value)
  }

  clear(): void {
    this.#values.length = 0
  }

  summary(): Distribution | null {
    if (this.#values.length === 0) return null
    const sorted = [...this.#values].sort((left, right) => left - right)
    return {
      count: sorted.length,
      p50Ms: round(percentile(sorted, 0.5)),
      p90Ms: round(percentile(sorted, 0.9)),
      p99Ms: round(percentile(sorted, 0.99)),
      maxMs: round(sorted[sorted.length - 1]!),
    }
  }
}

class TerminalPipelineTelemetry {
  #counts = emptyCounts()
  readonly #ptyHandlerMs = new Samples()
  readonly #serviceFrameIntervalMs = new Samples()
  readonly #serviceToStageStartMs = new Samples()
  readonly #serviceToStageEndMs = new Samples()
  readonly #stageCallMs = new Samples()
  readonly #stageIntervalMs = new Samples()
  readonly #stageToTickMs = new Samples()
  readonly #tickMs = new Samples()
  readonly #tickIntervalMs = new Samples()
  readonly #reactCommitMs = new Samples()
  #lastServiceFrameAt: number | undefined
  #pendingServiceFrameAt: number | undefined
  #lastStageAt: number | undefined
  #lastTickAt: number | undefined
  #stageSequence = 0
  #tickStageSequence = 0
  #startedAt = performance.now()
  #cpuStartedAt = process.cpuUsage()

  reset(): void {
    this.#counts = emptyCounts()
    for (const samples of [
      this.#ptyHandlerMs,
      this.#serviceFrameIntervalMs,
      this.#serviceToStageStartMs,
      this.#serviceToStageEndMs,
      this.#stageCallMs,
      this.#stageIntervalMs,
      this.#stageToTickMs,
      this.#tickMs,
      this.#tickIntervalMs,
      this.#reactCommitMs,
    ]) samples.clear()
    this.#lastServiceFrameAt = undefined
    this.#pendingServiceFrameAt = undefined
    this.#lastStageAt = undefined
    this.#lastTickAt = undefined
    this.#stageSequence = 0
    this.#tickStageSequence = 0
    this.#startedAt = performance.now()
    this.#cpuStartedAt = process.cpuUsage()
  }

  recordPty(chunkBytes: number, synchronized: boolean, handlerMs: number): void {
    this.#counts.ptyCallbacks += 1
    this.#counts.ptyBytes += chunkBytes
    this.#counts.ptyHandlerWallMs += handlerMs
    if (synchronized) this.#counts.synchronizedPtyCallbacks += 1
    this.#ptyHandlerMs.add(handlerMs)
  }

  recordResize(): void {
    this.#counts.resizes += 1
  }

  recordServiceFrame(): void {
    const now = performance.now()
    this.#counts.serviceFrames += 1
    if (this.#lastServiceFrameAt !== undefined) this.#serviceFrameIntervalMs.add(now - this.#lastServiceFrameAt)
    this.#lastServiceFrameAt = now
    this.#pendingServiceFrameAt = now
  }

  recordStage(startedAt: number, endedAt: number, metadataBytes: number, cellBytes: number): void {
    this.#counts.nativeStages += 1
    this.#counts.nativeMetadataBytes += metadataBytes
    this.#counts.nativeCellBytes += cellBytes
    this.#counts.nativeStageWallMs += endedAt - startedAt
    this.#stageCallMs.add(endedAt - startedAt)
    if (this.#lastStageAt !== undefined) this.#stageIntervalMs.add(startedAt - this.#lastStageAt)
    if (this.#pendingServiceFrameAt !== undefined) {
      this.#serviceToStageStartMs.add(startedAt - this.#pendingServiceFrameAt)
      this.#serviceToStageEndMs.add(endedAt - this.#pendingServiceFrameAt)
      this.#pendingServiceFrameAt = undefined
    }
    this.#lastStageAt = endedAt
    this.#stageSequence += 1
  }

  recordReactCommit(durationMs: number, mutationBytes: number): void {
    this.#counts.reactCommits += 1
    this.#counts.reactMutationBytes += mutationBytes
    this.#counts.reactCommitWallMs += durationMs
    this.#reactCommitMs.add(durationMs)
  }

  recordTick(startedAt: number, endedAt: number): void {
    this.#counts.ticks += 1
    this.#counts.tickWallMs += endedAt - startedAt
    this.#tickMs.add(endedAt - startedAt)
    if (this.#lastTickAt !== undefined) this.#tickIntervalMs.add(startedAt - this.#lastTickAt)
    this.#lastTickAt = startedAt
    if (this.#stageSequence > this.#tickStageSequence && this.#lastStageAt !== undefined) {
      const arrivals = this.#stageSequence - this.#tickStageSequence
      this.#counts.stagesCoalescedBeforeTick += Math.max(0, arrivals - 1)
      this.#stageToTickMs.add(Math.max(0, startedAt - this.#lastStageAt))
      this.#tickStageSequence = this.#stageSequence
    }
  }

  counts(): Readonly<TelemetryCounts> {
    return { ...this.#counts }
  }

  distributions(): Record<string, Distribution | null> {
    return {
      ptyHandlerMs: this.#ptyHandlerMs.summary(),
      serviceFrameIntervalMs: this.#serviceFrameIntervalMs.summary(),
      serviceToStageStartMs: this.#serviceToStageStartMs.summary(),
      serviceToStageEndMs: this.#serviceToStageEndMs.summary(),
      nativeStageCallMs: this.#stageCallMs.summary(),
      nativeStageIntervalMs: this.#stageIntervalMs.summary(),
      nativeStageToTickMs: this.#stageToTickMs.summary(),
      tickCallMs: this.#tickMs.summary(),
      tickIntervalMs: this.#tickIntervalMs.summary(),
      reactCommitMs: this.#reactCommitMs.summary(),
    }
  }

  elapsedMs(): number {
    return performance.now() - this.#startedAt
  }

  cpuUsage(): { userMs: number; systemMs: number; totalPercent: number } {
    const current = process.cpuUsage()
    const userMicros = current.user - this.#cpuStartedAt.user
    const systemMicros = current.system - this.#cpuStartedAt.system
    const elapsedMicros = Math.max(1, this.elapsedMs() * 1_000)
    return {
      userMs: round(userMicros / 1_000),
      systemMs: round(systemMicros / 1_000),
      totalPercent: round((userMicros + systemMicros) / elapsedMicros * 100),
    }
  }
}

class InstrumentedBackend implements TerminalBackend {
  readonly #inner: TerminalBackend
  readonly #telemetry: TerminalPipelineTelemetry

  constructor(inner: TerminalBackend, telemetry: TerminalPipelineTelemetry) {
    this.#inner = inner
    this.#telemetry = telemetry
  }

  async spawn(request: TerminalSpawnRequest & { cols: number; rows: number; cwd: string }): Promise<TerminalProcess> {
    const processHandle = await this.#inner.spawn(request)
    const telemetry = this.#telemetry
    return {
      ...(processHandle.pid === undefined ? {} : { pid: processHandle.pid }),
      write(data) { processHandle.write(data) },
      resize(cols, rows) {
        telemetry.recordResize()
        processHandle.resize(cols, rows)
      },
      kill() { processHandle.kill() },
      onData(listener) {
        return processHandle.onData((chunk, metadata) => {
          const startedAt = performance.now()
          try {
            listener(chunk, metadata)
          } finally {
            telemetry.recordPty(chunk.byteLength, metadata?.synchronizedFrame === true, performance.now() - startedAt)
          }
        })
      },
      onExit(listener: (status: TerminalProcessStatus) => void) { return processHandle.onExit(listener) },
    }
  }
}

function HarnessTerminal({ service, sessionId }: { service: TerminalSessionService; sessionId: TerminalSessionId }) {
  const size = useWindowSize()
  return (
    <TerminalView
      service={service}
      sessionId={sessionId}
      placement="bottom"
      width={size.width}
      height={size.height}
      appearance="dark"
    />
  )
}

function emptyCounts(): TelemetryCounts {
  return {
    ptyCallbacks: 0,
    ptyBytes: 0,
    synchronizedPtyCallbacks: 0,
    resizes: 0,
    serviceFrames: 0,
    nativeStages: 0,
    nativeCellBytes: 0,
    nativeMetadataBytes: 0,
    reactCommits: 0,
    reactMutationBytes: 0,
    ticks: 0,
    stagesCoalescedBeforeTick: 0,
    ptyHandlerWallMs: 0,
    nativeStageWallMs: 0,
    reactCommitWallMs: 0,
    tickWallMs: 0,
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!
}

function round(value: number, places = 3): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

function finiteNumber(value: string, option: string, minimum: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum) throw new Error(`${option} must be at least ${minimum}`)
  return parsed
}

function parseArgs(args: readonly string[]): { config: HarnessConfig; help: boolean } {
  let mode: 'default' | 'fixture' | 'custom' = 'default'
  let commandOverride: string | undefined
  const commandArgs: string[] = []
  let cwdOverride: string | undefined
  let selectionOverride: string | null | undefined
  let fixtureFps = 60
  let width = 1240
  let height = 820
  let fullscreen = false
  let background = false
  let durationSeconds = 0
  let warmupSeconds = 1.5
  let frameMs = 8
  let overlay: DebugFrameOverlayMode = 'hidden'
  let reportPath: string | undefined
  let help = false

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!
    if (raw === '--') continue
    const separator = raw.indexOf('=')
    const option = separator === -1 ? raw : raw.slice(0, separator)
    const inline = separator === -1 ? undefined : raw.slice(separator + 1)
    const value = (): string => {
      if (inline !== undefined) return inline
      index += 1
      const next = args[index]
      if (next === undefined || next.startsWith('--')) throw new Error(`${option} requires a value`)
      return next
    }
    switch (option) {
      case '--help': case '-h': help = true; break
      case '--fixture': mode = 'fixture'; break
      case '--command': mode = 'custom'; commandOverride = resolve(value()); break
      case '--arg': commandArgs.push(value()); break
      case '--cwd': cwdOverride = resolve(value()); break
      case '--select': selectionOverride = value(); break
      case '--no-select': selectionOverride = null; break
      case '--fps': fixtureFps = finiteNumber(value(), option, 1); break
      case '--width': width = finiteNumber(value(), option, 320); break
      case '--height': height = finiteNumber(value(), option, 240); break
      case '--fullscreen': fullscreen = true; break
      case '--background': background = true; break
      case '--duration': durationSeconds = finiteNumber(value(), option, 0); break
      case '--warmup': warmupSeconds = finiteNumber(value(), option, 0); break
      case '--frame-ms': frameMs = finiteNumber(value(), option, 0); break
      case '--overlay': {
        const candidate = value()
        if (candidate !== 'hidden' && candidate !== 'minimal' && candidate !== 'full') {
          throw new Error('--overlay must be hidden, minimal, or full')
        }
        overlay = candidate
        break
      }
      case '--report': reportPath = resolve(value()); break
      default: throw new Error(`Unknown option: ${option}`)
    }
  }

  const discovered = existsSync(DISCOVERED_OPENTUI)
  const workload = mode === 'fixture' || (mode === 'default' && !discovered)
    ? 'fixture'
    : mode === 'custom'
      ? 'custom'
      : 'opentui-golden-star'
  const command = workload === 'fixture'
    ? (Bun.which('bun') ?? process.execPath)
    : workload === 'custom'
      ? commandOverride!
      : DISCOVERED_OPENTUI
  const resolvedArgs = workload === 'fixture' ? [FIXTURE_PATH] : commandArgs
  const selection = selectionOverride === null
    ? undefined
    : selectionOverride ?? (workload === 'opentui-golden-star' ? 'Golden Star Demo' : undefined)
  const cwd = cwdOverride ?? (workload === 'opentui-golden-star' ? dirname(command) : REPO_ROOT)

  return {
    help,
    config: {
      workload,
      command,
      args: resolvedArgs,
      cwd,
      selection,
      fixtureFps,
      width: Math.floor(width),
      height: Math.floor(height),
      fullscreen,
      background,
      durationSeconds,
      warmupSeconds,
      frameMs,
      overlay,
      reportPath,
    },
  }
}

function printUsage(): void {
  console.log(`Live GPUIX terminal harness

Usage:
  bun run benchmark:terminal:gpuix -- [options]

Workload:
  By default, ../opentui-examples is detected and "Golden Star Demo" is selected.
  If it is absent, a bundled 60 FPS DEC 2026 framebuffer fixture is used.

Options:
  --fullscreen              Open the real GPUIX window fullscreen
  --duration <seconds>      Stop and report after a fixed interval (default: until close)
  --warmup <seconds>        Ignore startup before measurement (default: 1.5)
  --frame-ms <ms>           macOS GPUIX pump budget (default: 8)
  --overlay <mode>          hidden, minimal, or full (default: hidden)
  --width/--height <px>     Initial logical window size (default: 1240x820)
  --background              Do not take application focus
  --report <path>           Also write the final JSON report to disk
  --fixture                 Force the bundled controlled framebuffer producer
  --fps <number>            Bundled fixture producer rate (default: 60)
  --command <path>          Run a custom PTY command instead
  --arg <value>             Append an argument to a custom command (repeatable)
  --cwd <path>              PTY working directory
  --select <text>           Type text and Enter after the terminal is ready
  --no-select               Disable automatic menu selection
  --help                    Show this message`)
}

function safeDebugStats(renderer: ReturnType<typeof createRenderer>, fallbackFrames = 0): DebugFrameOverlayStats {
  try {
    return renderer.getDebugFrameOverlayStats()
  } catch {
    return { frames: fallbackFrames, samples: 0 }
  }
}

function safeWindowSize(renderer: ReturnType<typeof createRenderer>, fallback: { width: number; height: number }): { width: number; height: number } {
  try {
    const size = renderer.getWindowSize()
    if (size.width > 0 && size.height > 0) return size
  } catch {
    // The window may already be closed.
  }
  return fallback
}

async function waitForTerminalReady(service: TerminalSessionService, sessionId: TerminalSessionId, timeoutMs: number): Promise<void> {
  const initialTitle = service.getStateSnapshot().sessions.find((session) => session.id === sessionId)?.title
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const session = service.getStateSnapshot().sessions.find((candidate) => candidate.id === sessionId)
    const hasText = service.grid(sessionId)?.viewport.some((row) => row.text.trim().length > 0) === true
    if (hasText || session?.title !== initialTitle) return
    await Bun.sleep(50)
  }
}

function instrumentRenderer(renderer: ReturnType<typeof createRenderer>, telemetry: TerminalPipelineTelemetry): void {
  const setTerminalFrame = renderer.setTerminalFrame!.bind(renderer)
  renderer.setTerminalFrame = (elementId, metadata, cells) => {
    const startedAt = performance.now()
    try {
      setTerminalFrame(elementId, metadata, cells)
    } finally {
      telemetry.recordStage(startedAt, performance.now(), metadata.length, cells.byteLength)
    }
  }

  const applyBatch = renderer.applyBatch.bind(renderer)
  renderer.applyBatch = (json) => {
    const startedAt = performance.now()
    try {
      return applyBatch(json)
    } finally {
      telemetry.recordReactCommit(performance.now() - startedAt, json.length)
    }
  }

  const tick = renderer.tick.bind(renderer)
  renderer.tick = () => {
    const startedAt = performance.now()
    try {
      return tick()
    } finally {
      telemetry.recordTick(startedAt, performance.now())
    }
  }
}

function startReporter(
  renderer: ReturnType<typeof createRenderer>,
  telemetry: TerminalPipelineTelemetry,
  drawFrameBaseline: number,
): ReturnType<typeof setInterval> {
  let previousAt = performance.now()
  let previous = telemetry.counts()
  let previousDrawFrames = drawFrameBaseline
  let previousCpu = process.cpuUsage()
  return setInterval(() => {
    const now = performance.now()
    const elapsedSeconds = Math.max(0.001, (now - previousAt) / 1_000)
    const current = telemetry.counts()
    const debug = safeDebugStats(renderer, previousDrawFrames)
    const cpu = process.cpuUsage()
    const cpuPercent = ((cpu.user - previousCpu.user) + (cpu.system - previousCpu.system)) / (elapsedSeconds * 1_000_000) * 100
    const ptyFps = (current.ptyCallbacks - previous.ptyCallbacks) / elapsedSeconds
    const ptyMbps = (current.ptyBytes - previous.ptyBytes) / MEBIBYTE / elapsedSeconds
    const serviceFps = (current.serviceFrames - previous.serviceFrames) / elapsedSeconds
    const stageFps = (current.nativeStages - previous.nativeStages) / elapsedSeconds
    const drawDelta = debug.frames - previousDrawFrames
    const stageDelta = current.nativeStages - previous.nativeStages
    const drawFps = drawDelta / elapsedSeconds
    const stableLayerPercent = stageDelta > 0 ? Math.max(0, 1 - drawDelta / stageDelta) * 100 : 0
    const tickFps = (current.ticks - previous.ticks) / elapsedSeconds
    const tickWallPercent = (current.tickWallMs - previous.tickWallMs) / (elapsedSeconds * 1_000) * 100
    const distributions = telemetry.distributions()
    console.log(
      `[gpuix-terminal] pty=${ptyFps.toFixed(1)}fps/${ptyMbps.toFixed(1)}MiB/s` +
      ` service=${serviceFps.toFixed(1)} stage=${stageFps.toFixed(1)} draw=${drawFps.toFixed(1)}fps` +
      ` stable-layer=${stableLayerPercent.toFixed(0)}% tick=${tickFps.toFixed(1)}Hz/${tickWallPercent.toFixed(1)}%-wall cpu=${cpuPercent.toFixed(1)}%` +
      ` project-p90=${(distributions.serviceToStageStartMs?.p90Ms ?? 0).toFixed(2)}ms` +
      ` napi-p90=${(distributions.nativeStageCallMs?.p90Ms ?? 0).toFixed(2)}ms` +
      ` gpui-p90=${(debug.p90Ms ?? 0).toFixed(2)}ms` +
      ` react=${current.reactCommits - previous.reactCommits}`,
    )
    previousAt = now
    previous = current
    previousDrawFrames = debug.frames
    previousCpu = cpu
  }, 1_000)
}

function createReport(
  config: HarnessConfig,
  renderer: ReturnType<typeof createRenderer>,
  telemetry: TerminalPipelineTelemetry,
  drawFrameBaseline: number,
  service: TerminalSessionService,
  sessionId: TerminalSessionId,
  reason: string,
): object {
  const elapsedMs = telemetry.elapsedMs()
  const seconds = Math.max(0.001, elapsedMs / 1_000)
  const counts = telemetry.counts()
  const debug = safeDebugStats(renderer, drawFrameBaseline)
  const drawFrames = Math.max(0, debug.frames - drawFrameBaseline)
  const gpuiDrawsPerNativeStage = drawFrames / Math.max(1, counts.nativeStages)
  const stableLayerDrawAvoidance = counts.nativeStages > 0 ? Math.max(0, 1 - gpuiDrawsPerNativeStage) : 0
  const window = safeWindowSize(renderer, { width: config.width, height: config.height })
  const session = service.getStateSnapshot().sessions.find((candidate) => candidate.id === sessionId)
  const finalGrid = service.grid(sessionId)
  const screenPreview = finalGrid?.viewport
    .map((row) => row.text.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((row) => row.slice(0, 120)) ?? []
  const memory = process.memoryUsage()
  return {
    schemaVersion: 1,
    reason,
    environment: {
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      requiresTick: renderer.requiresTick(),
      nativeTerminal: renderer.supportsNativeTerminal(),
      directTerminalFrame: typeof renderer.setTerminalFrame === 'function',
    },
    config: {
      workload: config.workload,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      selection: config.selection ?? null,
      fixtureFps: config.workload === 'fixture' ? config.fixtureFps : null,
      fullscreen: config.fullscreen,
      frameMs: config.frameMs,
      overlay: config.overlay,
      warmupSeconds: config.warmupSeconds,
      requestedDurationSeconds: config.durationSeconds,
    },
    dimensions: {
      logicalWindow: window,
      terminalGrid: session ? { cols: session.cols, rows: session.rows } : null,
    },
    terminal: {
      title: session?.title ?? null,
      status: session?.status ?? null,
      screenPreview,
    },
    elapsedMs: round(elapsedMs),
    rates: {
      ptyCallbacksPerSecond: round(counts.ptyCallbacks / seconds),
      ptyMiBPerSecond: round(counts.ptyBytes / MEBIBYTE / seconds),
      serviceFramesPerSecond: round(counts.serviceFrames / seconds),
      nativeStagesPerSecond: round(counts.nativeStages / seconds),
      nativeCellMiBPerSecond: round(counts.nativeCellBytes / MEBIBYTE / seconds),
      gpuiDrawsPerSecond: round(drawFrames / seconds),
      ticksPerSecond: round(counts.ticks / seconds),
      tickWallPercent: round(counts.tickWallMs / elapsedMs * 100),
      ptyHandlerWallPercent: round(counts.ptyHandlerWallMs / elapsedMs * 100),
      nativeStageWallPercent: round(counts.nativeStageWallMs / elapsedMs * 100),
      reactCommitWallPercent: round(counts.reactCommitWallMs / elapsedMs * 100),
    },
    counts: {
      ...counts,
      ptyHandlerWallMs: round(counts.ptyHandlerWallMs),
      nativeStageWallMs: round(counts.nativeStageWallMs),
      reactCommitWallMs: round(counts.reactCommitWallMs),
      tickWallMs: round(counts.tickWallMs),
      gpuiDrawFrames: drawFrames,
      gpuiDrawSamples: debug.samples,
    },
    ratios: {
      serviceFramesPerPtyCallback: round(counts.serviceFrames / Math.max(1, counts.ptyCallbacks)),
      nativeStagesPerServiceFrame: round(counts.nativeStages / Math.max(1, counts.serviceFrames)),
      gpuiDrawsPerNativeStage: round(gpuiDrawsPerNativeStage),
      stableLayerDrawAvoidance: round(stableLayerDrawAvoidance),
    },
    diagnostics: {
      serviceToNativeOneToOne: counts.serviceFrames === counts.nativeStages,
      nativeToGpuiOneToOne: counts.nativeStages === drawFrames,
      stableLayerActive: counts.nativeStages > 0 && stableLayerDrawAvoidance > 0,
      animationDetachedFromReact: counts.reactCommits === 0,
      macTickWallStarved: renderer.requiresTick() && counts.tickWallMs / elapsedMs >= 0.5,
      gpuiDrawP90Within16_7Ms: (debug.p90Ms ?? 0) <= 16.7,
    },
    latency: telemetry.distributions(),
    nativeDraw: {
      currentMs: debug.currentMs === undefined ? null : round(debug.currentMs),
      p90Ms: debug.p90Ms === undefined ? null : round(debug.p90Ms),
      p99Ms: debug.p99Ms === undefined ? null : round(debug.p99Ms),
      maxMs: debug.maxMs === undefined ? null : round(debug.maxMs),
    },
    process: {
      cpu: telemetry.cpuUsage(),
      rssMiB: round(memory.rss / MEBIBYTE),
      heapUsedMiB: round(memory.heapUsed / MEBIBYTE),
    },
  }
}

async function run(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    printUsage()
    return
  }
  const config = parsed.config
  if (!existsSync(config.command)) throw new Error(`Terminal workload command does not exist: ${config.command}`)
  if (config.workload === 'fixture' && !existsSync(FIXTURE_PATH)) throw new Error(`Fixture does not exist: ${FIXTURE_PATH}`)

  const telemetry = new TerminalPipelineTelemetry()
  const service = new TerminalSessionService({
    cwd: config.cwd,
    backend: new InstrumentedBackend(new BunPtyBackend(), telemetry),
    appearancePath: false,
  })
  const renderer = createRenderer()
  let root: Root | undefined
  let frameLoop: ReturnType<typeof startFrameLoop> | undefined
  let frameSubscription: (() => void) | undefined
  let reporter: ReturnType<typeof setInterval> | undefined
  let durationTimer: ReturnType<typeof setTimeout> | undefined
  let drawFrameBaseline = 0
  let sessionId: TerminalSessionId | undefined
  let finishing = false

  const finish = async (reason: string, exitCode = 0): Promise<void> => {
    if (finishing) return
    finishing = true
    if (reporter) clearInterval(reporter)
    if (durationTimer) clearTimeout(durationTimer)
    frameLoop?.stop()
    const report = sessionId
      ? createReport(config, renderer, telemetry, drawFrameBaseline, service, sessionId, reason)
      : { schemaVersion: 1, reason, error: 'session did not start' }
    frameSubscription?.()
    try { root?.unmount() } catch { /* Window may already be closed. */ }
    await service.dispose()
    if (config.reportPath) {
      mkdirSync(dirname(config.reportPath), { recursive: true })
      await Bun.write(config.reportPath, JSON.stringify(report, null, 2) + '\n')
      console.log(`[gpuix-terminal] report=${config.reportPath}`)
    }
    console.log(`TERMINAL_GPUIX_REPORT ${JSON.stringify(report)}`)
    await Bun.sleep(0)
    process.exit(exitCode)
  }

  const onSigint = () => { void finish('signal', 130) }
  const onSigterm = () => { void finish('signal', 143) }
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  try {
    const productionOptions = createWindowOptions(process.platform, config.overlay)
    const { debugFrameOverlay: _debugFrameOverlay, ...windowOptions } = productionOptions
    renderer.init({
      ...windowOptions,
      title: 'Heddlework Terminal GPUIX Harness',
      width: config.width,
      height: config.height,
      fullscreen: config.fullscreen,
      focus: !config.background,
      show: true,
    })
    renderer.setDebugFrameOverlay(config.overlay)
    if (!renderer.supportsNativeTerminal() || typeof renderer.setTerminalFrame !== 'function') {
      throw new Error('The patched GPUIX direct native terminal renderer is required')
    }
    instrumentRenderer(renderer, telemetry)

    let measuredSessionId: TerminalSessionId | undefined
    frameSubscription = service.subscribeFrames((changedId) => {
      if (changedId === measuredSessionId) telemetry.recordServiceFrame()
    })
    const initialGrid = terminalGridSize(config.width, config.height)
    sessionId = await service.spawn({
      name: config.workload === 'fixture' ? 'Controlled framebuffer' : 'Golden Star Demo',
      shell: config.command,
      args: config.args,
      cwd: config.cwd,
      cols: initialGrid.cols,
      rows: initialGrid.rows,
      ...(config.workload === 'fixture'
        ? { env: { HEDDLEWORK_TERMINAL_FIXTURE_FPS: String(config.fixtureFps) } }
        : {}),
    })
    measuredSessionId = sessionId

    root = createRoot(renderer)
    flushSync(() => {
      root!.render(<HarnessTerminal service={service} sessionId={sessionId!} />)
    })
    frameLoop = startFrameLoop(renderer, {
      frameMs: config.frameMs,
      onTerminated: () => { void finish('window-closed') },
    })

    const actualWindow = safeWindowSize(renderer, { width: config.width, height: config.height })
    console.log(
      `[gpuix-terminal] workload=${config.workload} window=${actualWindow.width}x${actualWindow.height}` +
      ` fullscreen=${config.fullscreen} frame-ms=${config.frameMs} overlay=${config.overlay}`,
    )
    if (config.selection) {
      await waitForTerminalReady(service, sessionId, 2_000)
      service.write(sessionId, config.selection)
      await Bun.sleep(80)
      service.write(sessionId, '\r')
    }

    if (config.warmupSeconds > 0) await Bun.sleep(config.warmupSeconds * 1_000)
    renderer.resetDebugFrameOverlayStats()
    telemetry.reset()
    drawFrameBaseline = safeDebugStats(renderer).frames
    reporter = startReporter(renderer, telemetry, drawFrameBaseline)
    console.log(`[gpuix-terminal] measuring${config.durationSeconds > 0 ? ` for ${config.durationSeconds}s` : ' until the window closes'}`)
    if (config.durationSeconds > 0) {
      durationTimer = setTimeout(() => { void finish('duration') }, config.durationSeconds * 1_000)
    }
  } catch (error) {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    frameLoop?.stop()
    frameSubscription?.()
    try { root?.unmount() } catch { /* Ignore secondary teardown errors. */ }
    await service.dispose()
    throw error
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
