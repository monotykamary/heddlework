import type { BrowserSurfaceBounds } from '../browser/types.ts'

export const BROWSER_PLACEMENT_ACTIVE_POLL_MS = 16
// Idle polling may notice renewed movement up to ~4 frames later; once movement is seen, return to frame-rate polling.
export const BROWSER_PLACEMENT_IDLE_POLL_MS = 64

export interface BrowserPlacementSample {
  bounds: BrowserSurfaceBounds
  visible: boolean
}

export function sampleBrowserPlacement(
  raw: readonly number[] | undefined,
  visible: boolean,
  previous: BrowserPlacementSample | undefined,
): { sample: BrowserPlacementSample | undefined; changed: boolean; nextDelayMs: number } {
  if (!raw || raw.length < 4) return { sample: previous, changed: false, nextDelayMs: BROWSER_PLACEMENT_IDLE_POLL_MS }
  const sample: BrowserPlacementSample = {
    bounds: {
      x: normalizeCoordinate(raw[0] ?? 0),
      y: normalizeCoordinate(raw[1] ?? 0),
      width: Math.max(1, normalizeCoordinate(raw[2] ?? 1)),
      height: Math.max(1, normalizeCoordinate(raw[3] ?? 1)),
    },
    visible,
  }
  const changed = !previous || previous.visible !== sample.visible || !boundsEqual(previous.bounds, sample.bounds)
  return {
    sample: changed ? sample : previous,
    changed,
    nextDelayMs: changed ? BROWSER_PLACEMENT_ACTIVE_POLL_MS : BROWSER_PLACEMENT_IDLE_POLL_MS,
  }
}

function normalizeCoordinate(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 2) / 2 : 0
}

function boundsEqual(a: BrowserSurfaceBounds, b: BrowserSurfaceBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
