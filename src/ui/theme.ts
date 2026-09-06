export type ResolvedTheme = 'light' | 'dark'

export interface ColorPalette {
  window: string
  background: string
  sidebar: string
  sidebarControl: string
  sidebarHover: string
  sidebarActive: string
  settledText: string
  settledMeta: string
  settledIcon: string
  settledDivider: string
  panel: string
  card: string
  raised: string
  popover: string
  hover: string
  input: string
  border: string
  borderStrong: string
  text: string
  textMuted: string
  textFaint: string
  placeholder: string
  primary: string
  primaryHover: string
  info: string
  success: string
  warning: string
  error: string
  message: string
  composer: string
  composerFrame: string
  composerHighlight: string
  composerControlText: string
  composerControlIcon: string
  contextBar: string
  contextText: string
  contextIcon: string
  composerOutline: string
  code: string
  diffAdd: string
  diffDel: string
  diffHunkBg: string
  transparent: string
}

export const darkColors: ColorPalette = {
  window: '#0A0A0A', background: '#0A0A0A', sidebar: '#090A0B', sidebarControl: '#151617', sidebarHover: '#151617', sidebarActive: '#1B1C1D',
  settledText: '#595A5D', settledMeta: '#4D4E51', settledIcon: '#4B4C4F', settledDivider: '#191A1B', panel: '#0B0C0C', card: '#111212', raised: '#151616',
  popover: '#1A1B1B', hover: '#202121', input: '#1B1C1C', border: '#1D1E1E', borderStrong: '#2A2B2B', text: '#E7E7E7', textMuted: '#A0A0A3',
  textFaint: '#66676A', placeholder: '#77787B', primary: '#4F67D8', primaryHover: '#5B74E8', info: '#60A5FA', success: '#4ADEA4', warning: '#F1C75B',
  error: '#F87171', message: '#171818', composer: '#121212', composerFrame: '#1E1E1E', composerHighlight: '#191919', composerControlText: '#88888B',
  composerControlIcon: '#737477', contextBar: '#171717', contextText: '#767679', contextIcon: '#5F6063', composerOutline: '#282828', code: '#111212',
  diffAdd: '#123526', diffDel: '#3B1E24', diffHunkBg: '#162238', transparent: '#00000000',
}

export const lightColors: ColorPalette = {
  window: '#F7F7F8', background: '#F7F7F8', sidebar: '#EFEFF1', sidebarControl: '#E2E2E5', sidebarHover: '#E3E3E6', sidebarActive: '#DADAE0',
  settledText: '#898A90', settledMeta: '#96979C', settledIcon: '#929399', settledDivider: '#DEDEE2', panel: '#F4F4F5', card: '#FFFFFF', raised: '#ECECEF',
  popover: '#FFFFFF', hover: '#E3E3E7', input: '#FFFFFF', border: '#E2E2E5', borderStrong: '#D0D0D5', text: '#1D1D20', textMuted: '#5D5E64',
  textFaint: '#85868D', placeholder: '#77787E', primary: '#435CC4', primaryHover: '#344DB8', info: '#2563B8', success: '#16845B', warning: '#9A6700',
  error: '#C43D45', message: '#ECECEF', composer: '#FFFFFF', composerFrame: '#DCDCE1', composerHighlight: '#F0F0F2', composerControlText: '#5F6067',
  composerControlIcon: '#74757C', contextBar: '#F0F0F2', contextText: '#696A71', contextIcon: '#7C7D83', composerOutline: '#D4D4D9', code: '#F1F1F3',
  diffAdd: '#DDF3E8', diffDel: '#F9E1E3', diffHunkBg: '#E1EAF8', transparent: '#00000000',
}

export const colors: ColorPalette = { ...darkColors }

function createNativeTheme(appearance: ResolvedTheme, palette: ColorPalette) {
  const dark = appearance === 'dark'
  return {
    appearance,
    bg: palette.background,
    border: palette.borderStrong,
    text: palette.text,
    textMuted: palette.textMuted,
    textFaint: palette.textFaint,
    textDim: palette.textMuted,
    accent: palette.primary,
    caret: palette.text,
    codeText: dark ? '#D7D7DC' : '#25262A',
    codeWash: palette.code,
    diffAdd: palette.diffAdd,
    diffDel: palette.diffDel,
    diffHunkBg: palette.diffHunkBg,
    fontSans: 'Helvetica Neue',
    fontMono: 'Menlo',
    syntax: dark ? {
      comment: '#73737B', keyword: '#FF7AB2', string: '#A8CC8C', number: '#C7A0F8', boolean: '#79B8FF', typeName: '#E8B17A',
      constructor: '#E8B17A', function: '#C7A0F8', property: '#79B8FF', variable: '#E8E8EB', operator: '#FF7AB2', punctuation: '#A0A0A8',
    } : {
      comment: '#6F7077', keyword: '#A6266E', string: '#3A6F2C', number: '#6F42C1', boolean: '#145DA0', typeName: '#9A4A00',
      constructor: '#9A4A00', function: '#6F42C1', property: '#145DA0', variable: '#25262A', operator: '#A6266E', punctuation: '#5D5E64',
    },
    metrics: {
      codeTextSize: 12, codeLineHeight: 19, mdCodeRadius: 9, mdCodePaddingX: 12, mdCodePaddingY: 10, mdTextSize: 14, mdLineHeight: 22,
      mdBlockGap: 12, mdHeadingSizes: [20, 16, 14, 14], mdHeadingLineHeights: [28, 24, 22, 22], diffTextSize: 12, diffLineHeight: 19,
      diffFileHeaderHeight: 34,
    },
  }
}

export const nativeTheme = createNativeTheme('dark', darkColors)

export function applyResolvedTheme(appearance: ResolvedTheme, overlay?: Partial<ColorPalette>): void {
  const palette = appearance === 'light' ? { ...lightColors } : { ...darkColors }
  if (overlay) Object.assign(palette, overlay)
  Object.assign(colors, palette)
  Object.assign(nativeTheme, createNativeTheme(appearance, palette))
}

// Omarchy writes ~/.config/omarchy/current/theme/colors.toml with a small,
// stable semantic subset: [mode], background, foreground, accent, muted,
// border, and the color0-15 ANSI slots. We parse only these by line, validate
// hex strictly, and map them onto Heddlework's palette. Nothing depends on
// Omarchy: a malformed or missing file leaves the built-in palette intact.
const HEX_COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u

function toKey(value: string | undefined): string | undefined {
  return value?.toLowerCase().replaceAll('-', '_')
}

export function parseOmarchyPalette(toml: string): Partial<ColorPalette> | undefined {
  const fields: Record<string, string> = {}
  for (const rawLine of toml.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = toKey(line.slice(0, eq).trim())
    // Strip a trailing inline comment ("# ...") before pulling the value so
    // commented values still parse, then accept single- or double-quoted
    // strings as well as bare values.
    let raw = line.slice(eq + 1).trim()
    raw = raw.replace(/\s+#.*$/u, '').trim()
    const quoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
    const value = quoted ? raw.slice(1, -1) : raw
    if (!key) continue
    fields[key] = value
  }

  const hex = (key: string | undefined): string | undefined => {
    const normalized = key === undefined ? undefined : toKey(key)
    const value = normalized === undefined ? undefined : fields[normalized]
    return value && HEX_COLOR.test(value) ? value : undefined
  }
  const overlay: Partial<ColorPalette> = {}
  const background = hex('background') ?? hex('bg')
  const foreground = hex('foreground') ?? hex('fg')
  const accent = hex('accent')
  const muted = hex('muted')
  const border = hex('border')
  const sidebar = hex('sidebar') ?? hex('panel')
  const selection = hex('selection')
  if (background) { overlay.background = background; overlay.window = background; overlay.panel = background }
  if (foreground) overlay.text = foreground
  if (accent) { overlay.primary = accent; overlay.info = accent }
  if (muted) { overlay.textMuted = muted; overlay.textFaint = muted }
  if (border) overlay.borderStrong = border
  if (sidebar) overlay.sidebar = sidebar
  if (selection) { overlay.code = selection; overlay.message = selection; overlay.composer = selection }
  return Object.keys(overlay).length > 0 ? overlay : undefined
}
