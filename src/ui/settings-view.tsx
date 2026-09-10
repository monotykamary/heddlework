import { hasNativeTrafficLights } from './window-chrome.ts'
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import type { TerminalSessionService } from '../terminal/service.ts'
import type { BrowserSessionService } from '../browser/service.ts'
import { resolvePiExecutable } from '../pi/rpc-transport.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { Button } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'
import type { ThemeMode, ThemeSnapshot } from './theme-manager.ts'
import { useResponsiveLayout } from './responsive.tsx'
import { LAYOUT_MOTION_TRANSITION, MotionDiv } from './motion.ts'

export function SettingsView({
  state,
  controller,
  theme,
  titlebarInset,
  onThemeModeChange,
  terminals,
  browsers,
  onClose,
}: {
  state: WorkbenchState
  controller: WorkbenchController
  theme: ThemeSnapshot
  titlebarInset?: number | undefined
  onThemeModeChange(mode: ThemeMode): void
  terminals?: TerminalSessionService | undefined
  browsers?: BrowserSessionService | undefined
  onClose(): void
}) {
  const { mobile, compact, contentGutter } = useResponsiveLayout()
  const resolvedTitlebarInset = titlebarInset ?? (compact ? (hasNativeTrafficLights() ? 132 : 54) : 18)
  return (
    <div testId="settings-view" style={{ height: '100%', minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', backgroundColor: colors.background }}>
      <MotionDiv initial={false} animate={{ paddingLeft: resolvedTitlebarInset }} transition={LAYOUT_MOTION_TRANSITION} style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: resolvedTitlebarInset, paddingRight: 16, borderWidth: 1, borderColor: colors.border }}>
        <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>Settings</text>
        <div style={{ flexGrow: 1 }} />
        <Button label="Done" compact onClick={onClose} />
      </MotionDiv>
      <div testId="settings-scroll" style={{ height: 0, flexGrow: 1, minHeight: 0, overflow: 'scroll', display: 'flex', flexDirection: 'row', justifyContent: 'center', paddingTop: mobile ? 18 : 28, paddingBottom: 52, paddingLeft: mobile ? contentGutter : 28, paddingRight: mobile ? contentGutter : 28 }}>
        <div testId="settings-global" style={{ width: '100%', maxWidth: 720, minHeight: mobile ? 0 : 620, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: mobile ? 20 : 24 }}>
          <SettingsSection title="Runtime" description="Global Pi connection settings for this application.">
            <SettingsRow icon="terminal" label="Pi executable" value={resolvePiExecutable()} />
            <SettingsRow icon="circle" label="Status" value={state.connectionMessage} tone={state.connection === 'connected' ? 'success' : 'normal'} />
            <SettingsActions>
              <Button label="Reconnect" compact icon="refresh" onClick={() => void controller.reconnect()} />
            </SettingsActions>
          </SettingsSection>

          <SettingsSection title="Interface" description="Application-wide presentation and navigation defaults.">
            <SettingsControlRow label="Appearance">
              <ThemeModePicker theme={theme} onChange={onThemeModeChange} />
            </SettingsControlRow>
            <SettingsRow icon="terminal" label="Code font" value={nativeTheme.fontMono} />
            <SettingsRow icon="bell" label="Notifications" value="Interleaved with work traces" />
            <SettingsRow icon="list" label="History loading" value="Seamless infinite scroll" />
          </SettingsSection>

          {terminals ? <TerminalSettings service={terminals} /> : null}
          {browsers ? <BrowserSettings service={browsers} /> : null}

          <SettingsSection title="About" description="A native GPUix control surface for Pi, visually adapted from the MIT-licensed T3 Code project.">
            <SettingsRow testId="settings-alpha" icon="panel" label="Pi Code" value="Alpha" />
          </SettingsSection>
          <div testId="settings-bottom-spacer" style={{ height: 52, flexShrink: 0 }} />
        </div>
      </div>
    </div>
  )
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <text style={{ color: colors.text, fontSize: 14, fontWeight: 650 }}>{title}</text>
      <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 17 }}>{description}</text>
      <div style={{ marginTop: 3, display: 'flex', flexDirection: 'column', borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

function SettingsRow({ icon, label, value, tone = 'normal', testId }: { icon: Parameters<typeof Icon>[0]['name']; label: string; value: string; tone?: 'normal' | 'success'; testId?: string }) {
  const { mobile } = useResponsiveLayout()
  const labelContent = (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Icon name={icon} size={15} color={tone === 'success' ? colors.success : colors.textFaint} />
      <text style={{ color: colors.text, fontSize: 12, fontWeight: 550 }}>{label}</text>
    </div>
  )
  return (
    <div {...(testId ? { testId } : {})} style={{ minHeight: 46, display: 'flex', flexDirection: mobile ? 'column' : 'row', alignItems: mobile ? 'stretch' : 'center', gap: mobile ? 7 : 10, paddingTop: mobile ? 11 : 0, paddingBottom: mobile ? 11 : 0, paddingLeft: 13, paddingRight: 13, borderWidth: 1, borderColor: colors.border }}>
      {labelContent}
      {!mobile && <div style={{ flexGrow: 1 }} />}
      <text style={{ width: mobile ? '100%' : 'auto', color: tone === 'success' ? colors.success : colors.textMuted, fontSize: 11, maxWidth: mobile ? '100%' : 390, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{value}</text>
    </div>
  )
}

function SettingsControlRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  const { mobile } = useResponsiveLayout()
  return (
    <div style={{ minHeight: 54, display: 'flex', flexDirection: mobile ? 'column' : 'row', alignItems: mobile ? 'stretch' : 'center', gap: 12, paddingTop: mobile ? 10 : 0, paddingBottom: mobile ? 10 : 0, paddingLeft: 13, paddingRight: 10, borderWidth: 1, borderColor: colors.border }}>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <text style={{ color: colors.text, fontSize: 12, fontWeight: 550 }}>{label}</text>
        {description ? <text style={{ color: colors.textFaint, fontSize: 9, lineHeight: 13 }}>{description}</text> : null}
      </div>
      {!mobile && <div style={{ flexGrow: 1 }} />}
      {children}
    </div>
  )
}

function BrowserSettings({ service }: { service: BrowserSessionService }) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
  return (
    <SettingsSection title="Browser" description="App-owned profiles keep browser identities separate. Personal profiles are never exposed to agents; workspace profiles require the policy shown below.">
      <SettingsRow icon="globe" label="Native engine" value={snapshot.engine.available ? snapshot.engine.message : 'Unavailable'} tone={snapshot.engine.available ? 'success' : 'normal'} />
      {snapshot.profiles.map((profile) => (
        <SettingsControlRow key={profile.id} label={profile.name} description={`${profile.persistent ? 'Persistent' : 'Ephemeral'} · Agent access ${profile.agentAccess}`}>
          {profile.id === snapshot.defaultProfileId
            ? <text style={{ color: colors.success, fontSize: 10, fontWeight: 650 }}>Default</text>
            : profile.persistent
              ? <Button label="Make default" compact onClick={() => service.setDefaultProfile(profile.id)} />
              : <text style={{ color: colors.textFaint, fontSize: 10 }}>Private</text>}
        </SettingsControlRow>
      ))}
    </SettingsSection>
  )
}

function TerminalSettings({ service }: { service: TerminalSessionService }) {
  const appearance = useSyncExternalStore(service.subscribe, service.getSnapshot).appearance
  return (
    <SettingsSection title="Terminal" description="Native GPUI text shaping and renderer controls. Font changes apply to every live terminal without restarting its PTY.">
      <SettingsControlRow label="Primary font" description="Use the exact family name of an installed monospaced font.">
        <TerminalFontControl value={appearance.fontFamily} testId="terminal-font-family" onApply={(fontFamily) => service.setAppearance({ fontFamily })} />
      </SettingsControlRow>
      <SettingsControlRow label="Programming ligatures" description="Shape same-style cells together with the selected font's native OpenType features.">
        <SettingsToggle testId="terminal-ligatures" enabled={appearance.ligaturesEnabled} onChange={(ligaturesEnabled) => service.setAppearance({ ligaturesEnabled })} />
      </SettingsControlRow>
      <SettingsControlRow label="Nerd Font symbols" description="Route powerline and private-use glyphs through a separately installed symbol font.">
        <SettingsToggle testId="terminal-nerd-font" enabled={appearance.nerdFontEnabled} onChange={(nerdFontEnabled) => service.setAppearance({ nerdFontEnabled })} />
      </SettingsControlRow>
      <SettingsControlRow label="Nerd Font family" description="Usually Symbols Nerd Font Mono, or the family name supplied by your Nerd Font package.">
        <TerminalFontControl value={appearance.nerdFontFamily} testId="terminal-nerd-font-family" onApply={(nerdFontFamily) => service.setAppearance({ nerdFontFamily })} />
      </SettingsControlRow>
      <SettingsControlRow label="Muted emoji" description="Prefer monochrome text-presentation glyphs so emoji follows terminal foreground colors.">
        <SettingsToggle testId="terminal-muted-emoji" enabled={appearance.muteEmojiColors} onChange={(muteEmojiColors) => service.setAppearance({ muteEmojiColors })} />
      </SettingsControlRow>
      <SettingsActions>
        <Button label="Reset terminal appearance" compact onClick={() => service.resetAppearance()} />
      </SettingsActions>
    </SettingsSection>
  )
}

function TerminalFontControl({ value, testId, onApply }: { value: string; testId: string; onApply(value: string): void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const next = draft.trim()
  return (
    <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 0, minWidth: 0, height: 32, flexGrow: 1, display: 'flex', alignItems: 'center', paddingLeft: 9, paddingRight: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input }}>
        <input testId={testId} value={draft} theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }} style={{ width: 0, minWidth: 0, height: 28, flexGrow: 1, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 10, fontFamily: draft || nativeTheme.fontMono }} onChange={(event) => setDraft(String(event.value ?? ''))} onKeyDown={(event) => { if (event.key === 'enter' && next) onApply(next) }} />
      </div>
      <Button testId={`${testId}-apply`} label="Apply" compact disabled={!next || next === value} onClick={() => onApply(next)} />
    </div>
  )
}

function SettingsToggle({ enabled, testId, onChange }: { enabled: boolean; testId: string; onChange(enabled: boolean): void }) {
  return (
    <div testId={testId} style={{ display: 'flex', flexDirection: 'row', gap: 3, padding: 3, borderRadius: 9, backgroundColor: colors.raised }}>
      {[false, true].map((value) => {
        const active = enabled === value
        return (
          <div key={String(value)} testId={`${testId}-${value ? 'on' : 'off'}`} tabIndex={0} style={{ minHeight: 26, minWidth: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 7, borderWidth: 1, borderColor: active ? colors.borderStrong : colors.transparent, backgroundColor: active ? colors.card : colors.transparent, cursor: 'pointer', userSelect: 'none', hover: { backgroundColor: active ? colors.card : colors.hover } }} onClick={() => onChange(value)} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onChange(value) }}>
            <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 10, fontWeight: active ? 650 : 500 }}>{value ? 'On' : 'Off'}</text>
          </div>
        )
      })}
    </div>
  )
}

function ThemeModePicker({ theme, onChange }: { theme: ThemeSnapshot; onChange(mode: ThemeMode): void }) {
  const options: Array<{ mode: ThemeMode; label: string }> = [
    { mode: 'system', label: `System (${theme.resolved === 'light' ? 'Light' : 'Dark'})` },
    { mode: 'light', label: 'Light' },
    { mode: 'dark', label: 'Dark' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 3, padding: 3, borderRadius: 9, backgroundColor: colors.raised }}>
      {options.map(({ mode, label }) => {
        const active = theme.mode === mode
        return (
          <div
            key={mode}
            testId={`theme-mode-${mode}`}
            tabIndex={0}
            style={{ minHeight: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 9, paddingRight: 9, borderRadius: 7, backgroundColor: active ? colors.card : colors.transparent, borderWidth: 1, borderColor: active ? colors.borderStrong : colors.transparent, cursor: 'pointer', userSelect: 'none', hover: { backgroundColor: active ? colors.card : colors.hover } }}
            onClick={() => onChange(mode)}
            onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onChange(mode) }}
          >
            <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 10, fontWeight: active ? 650 : 500, whiteSpace: 'nowrap' }}>{label}</text>
          </div>
        )
      })}
    </div>
  )
}

function SettingsActions({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: 48, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 7, padding: 9 }}>{children}</div>
}
