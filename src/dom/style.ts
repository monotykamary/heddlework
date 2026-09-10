// Translates a gpuix StyleDesc into inline CSS the way packages/native/src/renderer.rs apply_styles interprets it.
// gpuix boxes are block-level by default, opt into flex/grid, and take pixel numbers everywhere.

import type { CSSProperties } from 'react'
import type { StyleDesc } from '@gpuix/react'

type AnyStyle = Record<string, unknown>

const PX_KEYS = new Set([
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'top', 'right', 'bottom', 'left', 'gap', 'rowGap', 'columnGap',
  'borderWidth', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'fontSize', 'lineHeight', 'flexBasis',
])

const PASS_KEYS = new Set([
  'display', 'visibility', 'flexDirection', 'flexWrap', 'flexGrow', 'flexShrink', 'alignItems', 'alignSelf', 'alignContent',
  'justifyContent', 'position', 'color', 'opacity', 'borderColor', 'fontFamily', 'fontWeight', 'textAlign', 'overflow',
  'overflowX', 'overflowY', 'cursor', 'pointerEvents', 'userSelect', 'backgroundColor',
])

function px(value: unknown): string | number | undefined {
  if (typeof value === 'number') return `${value}px`
  if (typeof value === 'string') return value
  return undefined
}

function background(value: StyleDesc['background']): string | undefined {
  if (!value) return undefined
  if (typeof value === 'string') return value
  const [a, b] = value.stops
  const space = value.colorSpace === 'oklab' ? ' in oklab' : ''
  return `linear-gradient(${value.angle}deg${space}, ${a.color} ${a.position * 100}%, ${b.color} ${b.position * 100}%)`
}

function shadow(value: StyleDesc['boxShadow']): string | undefined {
  if (!value) return undefined
  return `${value.offsetX}px ${value.offsetY}px ${value.blurRadius}px ${value.spreadRadius}px ${value.color}`
}

// gpuix hides both scrollbars and clips for 'hidden'; 'scroll'/'auto' clip and let wheel events move content.
function overflow(value: unknown): string | undefined {
  if (value === 'scroll' || value === 'auto') return 'auto'
  if (value === 'hidden') return 'hidden'
  if (value === 'visible') return 'visible'
  return undefined
}

export function toCss(style: StyleDesc | undefined, hovered = false, active = false): CSSProperties {
  if (!style) return {}
  const merged: AnyStyle = { ...style }
  if (hovered && style.hover) Object.assign(merged, style.hover)
  if (active && style.active) Object.assign(merged, style.active)
  const css: AnyStyle = {}
  for (const [key, raw] of Object.entries(merged)) {
    if (raw === undefined || raw === null || key === 'hover' || key === 'active') continue
    if (PX_KEYS.has(key)) {
      const value = px(raw)
      if (value !== undefined) css[key] = value
      continue
    }
    switch (key) {
      case 'background': css.background = background(raw as StyleDesc['background']); break
      case 'boxShadow': css.boxShadow = shadow(raw as StyleDesc['boxShadow']); break
      case 'overflow': css.overflow = overflow(raw); break
      case 'overflowX': css.overflowX = overflow(raw); break
      case 'overflowY': css.overflowY = overflow(raw); break
      case 'whiteSpace': css.whiteSpace = raw === 'nowrap' ? 'nowrap' : 'pre-wrap'; break
      case 'textOverflow':
        css.textOverflow = 'ellipsis'
        css.overflow = css.overflow ?? 'hidden'
        css.whiteSpace = css.whiteSpace ?? 'nowrap'
        if (raw === 'ellipsis-start') css.direction = 'rtl'
        break
      case 'lineClamp':
        css.display = '-webkit-box'
        css.WebkitBoxOrient = 'vertical'
        css.WebkitLineClamp = raw
        css.overflow = 'hidden'
        break
      case 'gridTemplateColumns': css.gridTemplateColumns = `repeat(${raw}, minmax(0, 1fr))`; break
      case 'gridTemplateRows': css.gridTemplateRows = `repeat(${raw}, minmax(0, 1fr))`; break
      case 'selectionColor': css['--selection'] = raw; break
      default:
        if (PASS_KEYS.has(key)) css[key] = raw
    }
  }
  // gpuix draws borderWidth only when a color is present, and a color without a width draws nothing.
  const hasBorder = ['borderWidth', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some((key) => typeof merged[key] === 'number' && (merged[key] as number) > 0)
  if (hasBorder) css.borderStyle = 'solid'
  if (hasBorder && merged.borderColor === undefined) css.borderColor = 'transparent'
  if (merged.borderWidth === undefined && hasBorder) {
    css.borderWidth = 0
    for (const [key, cssKey] of [['borderTopWidth', 'borderTopWidth'], ['borderRightWidth', 'borderRightWidth'], ['borderBottomWidth', 'borderBottomWidth'], ['borderLeftWidth', 'borderLeftWidth']] as const) {
      if (merged[key] !== undefined) css[cssKey] = px(merged[key])
    }
  }
  // GPUI paints children in source order and treats every element as the containing block for absolute
  // children. In CSS, positioned elements paint above static siblings, so a static sibling after an absolute
  // backdrop would be covered. Defaulting to relative restores source-order painting.
  css.position = merged.position === 'absolute' ? 'absolute' : 'relative'
  return css as CSSProperties
}

export function hasStateStyles(style: StyleDesc | undefined): boolean {
  return Boolean(style && (style.hover || style.active))
}
