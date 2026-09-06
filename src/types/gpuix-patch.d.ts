// Type bridge for GPUIX APIs added by patches/gpuix-0.7.0-heddlework.patch that
// the published @gpuix/*@0.7.0 packages do not declare yet. The native-runtime
// verification (scripts/verify-native-runtime.ts) reports whether the installed
// runtime actually implements each surface. Remove entries as upstream ships them.
import type { EventPayload, StyleDesc } from '@gpuix/react'

declare module '@gpuix/native' {
  interface WindowOptions {
    /** Parent directory for persistent Chromium profiles; consumed before the first <browser> mounts. */
    browserRootCachePath?: string
    /** Opt out of native browser initialization before the renderer starts. */
    nativeBrowserEnabled?: boolean
  }

  interface GpuixRenderer {
    supportsNativeTerminal(): boolean
    supportsNativeBrowser(): boolean
    nativeBrowserEngine(): string
    nativeBrowserProfileIsolation(): string
    nativeBrowserError(): string | null
    setTerminalFrame?(elementId: number, metadata: string, cells: Buffer): void
  }
}

declare module '@gpuix/react' {
  interface MotionStyle {
    paddingLeft?: number
    paddingRight?: number
    paddingTop?: number
    paddingBottom?: number
    flexGrow?: number
  }

  interface RenderOptions {
    /** Runs after the frame loop observes the last native window closing. */
    onTerminated?: () => void
  }
}

interface BrowserElementProps {
  key?: string | number
  testId?: string
  source?: string
  generation: number
  profileId?: string
  profilePath?: string
  incognito?: boolean
  visible?: boolean
  command?: string
  style?: StyleDesc
  onBrowserState?: (event: EventPayload) => void
  onBrowserOpen?: (event: EventPayload) => void
  onBrowserError?: (event: EventPayload) => void
}

declare module '@gpuix/react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      browser: BrowserElementProps
    }
  }
}

declare module '@gpuix/react/jsx-dev-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      browser: BrowserElementProps
    }
  }
}
