import { useEffect, useMemo, useRef } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import type { BrowserSessionService } from '../browser/service.ts'
import type { BrowserEngineKind, BrowserEngineStatus, BrowserNativeState } from '../browser/types.ts'
import { useBrowserSnapshot } from './browser-context.tsx'

interface BrowserRenderer {
  supportsNativeBrowser?(): boolean
  nativeBrowserEngine?(): string
  nativeBrowserProfileIsolation?(): string
  nativeBrowserError?(): string | null
}

interface BrowserEvent {
  value?: string | undefined
}

interface BrowserValueEvent {
  generation: number
  value: string
}

export function BrowserNativeHost({ service, suspended = false }: { service: BrowserSessionService; suspended?: boolean }) {
  const renderer = useGpuixRequired() as BrowserRenderer
  const snapshot = useBrowserSnapshot(service)
  const lastBounds = useRef(new Map<string, { x: number; y: number; width: number; height: number }>())
  const engine = useMemo(() => probeBrowserEngine(renderer), [renderer])

  useEffect(() => service.setEngine(engine), [engine, service])

  if (!engine.available) return null
  const placement = snapshot.placement

  return (
    <div testId="browser-native-host" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, pointerEvents: 'none' }}>
      {snapshot.tabs.map((tab) => {
        if (!tab.materialized || !tab.url) return null
        const profile = service.runtimeProfile(tab.profileId)
        if (!profile) return null
        const shown = !suspended && placement?.tabId === tab.id && placement.visible
        if (shown && placement) lastBounds.current.set(tab.id, placement.bounds)
        const bounds = shown && placement ? placement.bounds : lastBounds.current.get(tab.id) ?? { x: 0, y: 0, width: 1, height: 1 }
        return (
          <browser
            key={`${tab.id}:${tab.generation}`}
            testId={`native-browser-${tab.id}`}
            source={tab.url}
            generation={tab.generation}
            profileId={profile.id}
            profilePath={profile.path}
            incognito={profile.incognito}
            visible={Boolean(shown)}
            command={JSON.stringify(tab.commands)}
            style={{
              position: 'absolute',
              left: bounds.x,
              top: bounds.y,
              width: bounds.width,
              height: bounds.height,
              pointerEvents: 'none',
            }}
            onBrowserState={(event: BrowserEvent) => {
              const state = parseBrowserState(event.value)
              if (state) service.applyNativeState(tab.id, state)
            }}
            onBrowserOpen={(event: BrowserEvent) => {
              const opened = parseBrowserValue(event.value)
              if (opened) service.openRequested(tab.id, opened.generation, opened.value)
            }}
            onBrowserError={(event: BrowserEvent) => {
              const failure = parseBrowserValue(event.value)
              if (failure) service.applyNativeState(tab.id, { generation: failure.generation, loading: false, error: failure.value })
            }}
          />
        )
      })}
    </div>
  )
}

function probeBrowserEngine(renderer: BrowserRenderer): BrowserEngineStatus {
  try {
    if (renderer.supportsNativeBrowser?.() !== true) {
      return {
        kind: 'unavailable',
        available: false,
        message: renderer.nativeBrowserError?.() ?? 'This GPUix build does not include a native browser surface.',
        profileIsolation: 'limited',
      }
    }
    const rawKind = renderer.nativeBrowserEngine?.()
    const kind: BrowserEngineKind = rawKind === 'cef' || rawKind === 'chromium' ? 'cef' : rawKind === 'remote' ? 'remote' : 'system'
    const rawIsolation = renderer.nativeBrowserProfileIsolation?.()
    const profileIsolation = rawIsolation === 'full' || rawIsolation === 'remote' ? rawIsolation : 'limited'
    return {
      kind,
      available: true,
      message: kind === 'cef' ? 'Chromium Embedded Framework' : kind === 'remote' ? 'Remote browser bridge' : 'System WebView',
      profileIsolation,
    }
  } catch (error) {
    return {
      kind: 'unavailable',
      available: false,
      message: error instanceof Error ? error.message : 'Native browser initialization failed.',
      profileIsolation: 'limited',
    }
  }
}

function parseBrowserState(value: string | undefined): BrowserNativeState | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as BrowserNativeState
    return parsed && typeof parsed === 'object' && validGeneration(parsed.generation) ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseBrowserValue(value: string | undefined): BrowserValueEvent | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as BrowserValueEvent
    return parsed && typeof parsed === 'object' && validGeneration(parsed.generation) && typeof parsed.value === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
