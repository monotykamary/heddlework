/** @jsxImportSource react */
// A DOM host for the gpuix React tree. It renders the same intrinsic elements (div, text, svg, input, textarea,
// anchored, virtual-list, code, diff, markdown, shimmer, img) that packages/native draws with GPUI, so src/ui runs in a
// browser unchanged. The web bundle aliases '@gpuix/react' and '@gpuix/react/jsx-runtime' to this module.

import { popupViewportShift } from './popup-position.ts'
import React, { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { jsx as domJsx, jsxs as domJsxs, Fragment as DomFragment } from 'react/jsx-runtime'
import type { EventPayload, NativeRenderer, StyleDesc } from '@gpuix/react'
import { hasStateStyles, toCss } from './style.ts'
import { keyPayload, mousePayload, plainPayload } from './events.ts'
import { DomVirtualList } from './virtual-list.tsx'
import { DomMarkdown, DomCode, DomDiff } from './rich.tsx'

export type { EventPayload, NativeRenderer, StyleDesc }
export type { MotionProps, MotionStyle, MotionTransition, MotionEase, PublicInstance, HighlightSpec, HighlightMatch, WindowKeyEventHandler, WindowKeyEventHandlers, CursorValue, LinearGradientBackground, LinearGradientStop, EdgeInsets, NativeWindowInsets, ShimmerProps, TerminalFrame, TerminalProps, BrowserProps } from '@gpuix/react'

type AnyProps = Record<string, unknown>

let nextElementId = 1

export interface DomInstance { id: number; type: string; props: AnyProps; node: HTMLElement | null }

const registry = new Map<number, DomInstance>()
const scrollHandles = new Map<number, { scrollTo(x: number, y: number): void; scrollToItem(index: number, offset?: number): void; offset(): [number, number] }>()

export function registerScrollHandle(id: number, handle: { scrollTo(x: number, y: number): void; scrollToItem(index: number, offset?: number): void; offset(): [number, number] }): () => void {
  scrollHandles.set(id, handle)
  return () => { scrollHandles.delete(id) }
}

export function useElementId(): number {
  const ref = useRef(0)
  if (ref.current === 0) ref.current = nextElementId++
  return ref.current
}

function focusable(node: HTMLElement | null): HTMLElement | null {
  if (!node) return null
  const inner = node.querySelector('textarea, input')
  return (inner as HTMLElement | null) ?? node
}

export const domRenderer: NativeRenderer = {
  applyBatch: () => [],
  focusElement(id) { focusable(registry.get(id)?.node ?? null)?.focus() },
  focusNext() {},
  focusPrevious() {},
  blur() { (document.activeElement as HTMLElement | null)?.blur() },
  scrollTo(id, x, y) {
    const handle = scrollHandles.get(id)
    if (handle) { handle.scrollTo(x, y); return }
    const node = registry.get(id)?.node
    if (node) { node.scrollLeft = x; node.scrollTop = y }
  },
  scrollToItem(id, index, offset) { scrollHandles.get(id)?.scrollToItem(index, offset) },
  getScrollOffset(id) {
    const handle = scrollHandles.get(id)
    if (handle) return handle.offset()
    const node = registry.get(id)?.node
    return node ? [node.scrollLeft, node.scrollTop] : null
  },
  setWindowTitle(title) { if (typeof document !== 'undefined') document.title = title },
} as NativeRenderer

// Shared native controls are aliased to this stable DOM renderer context.
export const GpuixContext = createContext<{ renderer: NativeRenderer | null }>({ renderer: domRenderer })
export function useGpuix() { return useContext(GpuixContext) }
export function useGpuixRequired(): NativeRenderer {
  const { renderer } = useGpuix()
  if (!renderer) throw new Error('useGpuixRequired must be used within a GpuixProvider')
  return renderer
}

function viewportMetrics() {
  const viewport = window.visualViewport
  const width = document.documentElement.clientWidth || window.innerWidth
  const height = document.documentElement.clientHeight || window.innerHeight
  const visibleHeight = viewport?.height ?? height
  const keyboardTop = Math.min(height, (viewport?.offsetTop ?? 0) + visibleHeight)
  const keyboardInset = viewport && viewport.scale === 1 ? Math.max(0, height - keyboardTop) : 0
  return { width, height, visibleHeight, keyboardTop, keyboardInset }
}

export function useWindowSize(_options?: { intervalMs?: number }): { width: number; height: number } {
  const read = () => { const value = viewportMetrics(); return { width: value.width, height: value.height } }
  const [size, setSize] = useState(read)
  useEffect(() => {
    const onResize = () => setSize((current) => {
      const next = read()
      return current.width === next.width && current.height === next.height ? current : next
    })
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('scroll', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('scroll', onResize)
    }
  }, [])
  return size
}

export function useWindowInsets(_options?: { intervalMs?: number }) {
  const [metrics, setMetrics] = useState(viewportMetrics)
  useEffect(() => {
    const update = () => setMetrics((current) => {
      const next = viewportMetrics()
      return current.width === next.width && current.height === next.height && current.keyboardTop === next.keyboardTop ? current : next
    })
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [])
  const zero = { top: 0, right: 0, bottom: 0, left: 0 }
  const ime = { ...zero, bottom: metrics.keyboardInset }
  return { safeArea: zero, ime, effective: ime, keyboardTop: metrics.keyboardTop, keyboardVisible: metrics.keyboardInset > 80, visibleHeight: metrics.visibleHeight }
}

export function findRanges(): Array<[number, number]> { return [] }
export function useTextSearch() { return { query: '', setQuery: () => undefined, matches: [], activeIndex: 0, next: () => undefined, previous: () => undefined } }

const EVENT_PROPS = new Set(['onClick', 'onAuxClick', 'onMouseDown', 'onMouseUp', 'onMouseEnter', 'onMouseLeave', 'onMouseMove', 'onMouseDownOutside', 'onKeyDown', 'onKeyUp', 'onFocus', 'onBlur', 'onScroll', 'onChange', 'onSubmit', 'onToggleFile', 'onShowMore', 'onLineClick', 'onLinkClick', 'onVisibleRange', 'onHighlight', 'onBrowserState', 'onBrowserOpen', 'onBrowserError'])
const HOST_ONLY = new Set(['style', 'testId', 'motion', 'highlight', 'autoFocus', 'tabIndex', 'children', 'ref', 'key', 'windowDragRegion', 'windowResizeEdge', ...EVENT_PROPS])

function useInstance(type: string, props: AnyProps, ref: React.ForwardedRef<unknown>) {
  const id = useElementId()
  const nodeRef = useRef<HTMLElement | null>(null)
  const instance = useMemo<DomInstance>(() => ({ id, type, props, node: null }), [id, type])
  instance.props = props
  useImperativeHandle(ref, () => instance, [instance])
  useLayoutEffect(() => {
    registry.set(id, instance)
    return () => { registry.delete(id) }
  }, [id, instance])
  const setNode = useCallback((node: HTMLElement | null) => { nodeRef.current = node; instance.node = node }, [instance])
  return { id, instance, nodeRef, setNode }
}

// Outside-press dismissal mirrors gpuix: any mousedown whose target is not inside the element fires the handler.
function useMouseDownOutside(id: number, nodeRef: React.MutableRefObject<HTMLElement | null>, handler: ((event: EventPayload) => void) | undefined) {
  useEffect(() => {
    if (!handler) return undefined
    const listener = (event: MouseEvent) => {
      const node = nodeRef.current
      if (!node || node.contains(event.target as Node)) return
      handler(mousePayload(id, 'mouseDownOutside', event))
    }
    document.addEventListener('mousedown', listener, true)
    return () => document.removeEventListener('mousedown', listener, true)
  }, [handler, id, nodeRef])
}

function useMotion(nodeRef: React.MutableRefObject<HTMLElement | null>, motion: AnyProps | undefined) {
  const first = useRef(true)
  const animate = motion?.animate as Record<string, number> | undefined
  const transition = motion?.transition as { duration?: number; delay?: number; ease?: unknown } | undefined
  const initial = motion?.initial as Record<string, number> | false | undefined
  const signature = JSON.stringify(animate ?? null)
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (!node || !animate) return
    const duration = (transition?.duration ?? 0.3) * 1000
    const ease = Array.isArray(transition?.ease) ? `cubic-bezier(${(transition!.ease as number[]).join(',')})` : typeof transition?.ease === 'string' ? cssEase(transition.ease) : 'ease'
    const keys = Object.keys(animate)
    const css = toCss(animate as StyleDesc)
    if (first.current) {
      first.current = false
      if (initial) {
        Object.assign(node.style, toCss(initial as StyleDesc))
        void node.offsetWidth
      } else {
        Object.assign(node.style, css)
        return
      }
    }
    node.style.transition = keys.map((key) => `${cssKey(key)} ${duration}ms ${ease} ${(transition?.delay ?? 0) * 1000}ms`).join(', ')
    Object.assign(node.style, css)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeRef, signature])
}

function cssEase(name: string): string {
  return name === 'easeIn' ? 'ease-in' : name === 'easeOut' ? 'ease-out' : name === 'easeInOut' ? 'ease-in-out' : name
}
function cssKey(key: string): string {
  return key === 'flexGrow' ? 'flex-grow' : key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

function stateStyle(style: StyleDesc | undefined, hovered: boolean, active: boolean): React.CSSProperties {
  return toCss(style, hovered, active)
}

function dataProps(props: AnyProps): AnyProps {
  const out: AnyProps = {}
  for (const [key, value] of Object.entries(props)) {
    if (HOST_ONLY.has(key) || value === undefined || typeof value === 'function' || typeof value === 'object') continue
    if (key === 'src' || key === 'alt' || key === 'value' || key === 'placeholder' || key === 'readOnly') continue
    out[`data-${key.toLowerCase()}`] = String(value)
  }
  return out
}

interface BoxProps extends AnyProps { style?: StyleDesc; testId?: string; children?: ReactNode; tabIndex?: number; autoFocus?: boolean; motion?: AnyProps }

type BoxElementProps = BoxProps & { tag: 'div' | 'span' }
const Box = forwardRef<unknown, BoxElementProps>(function Box(all, ref) {
  const { tag, ...props } = all as BoxElementProps
  const { id, nodeRef, setNode } = useInstance(tag === 'span' ? 'text' : 'div', props, ref)
  const [hovered, setHovered] = useState(false)
  const [active, setActive] = useState(false)
  const compositionCommitted = useRef(false)
  const stateful = hasStateStyles(props.style)
  const terminalInput = typeof props.testId === 'string' && props.testId.startsWith('terminal-input-')
  useMouseDownOutside(id, nodeRef, props.onMouseDownOutside as ((event: EventPayload) => void) | undefined)
  useMotion(nodeRef, props.motion)
  useEffect(() => { if (props.autoFocus) nodeRef.current?.focus() }, [props.autoFocus, nodeRef])
  const on = <K extends string>(key: K) => props[key] as ((event: EventPayload) => void) | undefined
  const handlers: AnyProps = {}
  const click = on('onClick'); const aux = on('onAuxClick')
  if (click || aux) handlers.onClick = (event: React.MouseEvent) => { event.stopPropagation(); if (event.button === 0) click?.(mousePayload(id, 'click', event)); else aux?.(mousePayload(id, 'auxClick', event)) }
  if (aux) handlers.onContextMenu = (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); aux(mousePayload(id, 'auxClick', event, { isRightClick: true, button: 2 })) }
  const down = on('onMouseDown'); const up = on('onMouseUp')
  handlers.onMouseDown = (event: React.MouseEvent) => { if (stateful) setActive(true); if (down) { event.stopPropagation(); down(mousePayload(id, 'mouseDown', event)) } }
  handlers.onMouseUp = (event: React.MouseEvent) => { if (stateful) setActive(false); if (up) { event.stopPropagation(); up(mousePayload(id, 'mouseUp', event)) } }
  const enter = on('onMouseEnter'); const leave = on('onMouseLeave'); const move = on('onMouseMove')
  handlers.onMouseEnter = (event: React.MouseEvent) => { if (stateful) setHovered(true); enter?.(mousePayload(id, 'mouseEnter', event)) }
  handlers.onMouseLeave = (event: React.MouseEvent) => { if (stateful) { setHovered(false); setActive(false) } leave?.(mousePayload(id, 'mouseLeave', event)) }
  if (move) handlers.onMouseMove = (event: React.MouseEvent) => move(mousePayload(id, 'mouseMove', event, { pressedButton: event.buttons & 1 ? 0 : undefined }))
  const keyDown = on('onKeyDown'); const keyUp = on('onKeyUp')
  const sendTerminalText = (data: string, paste = false) => keyDown?.(plainPayload(id, paste ? 'paste' : 'textInput', { key: '', keyChar: data, modifiers: { shift: false, ctrl: false, alt: false, cmd: false } }))
  useEffect(() => {
    const node = nodeRef.current
    if (!terminalInput || !keyDown || !node) return
    // React's synthetic beforeInput uses a textInput/keypress polyfill, which
    // drops spaces and can duplicate Enter. Use the browser InputEvent directly.
    const beforeInput = (event: InputEvent) => {
      if (event.inputType === 'insertFromComposition') {
        event.preventDefault()
        if (event.data && !compositionCommitted.current) {
          compositionCommitted.current = true
          sendTerminalText(event.data)
        }
        node.textContent = ''
        return
      }
      if (event.isComposing || event.inputType === 'insertCompositionText') return
      event.preventDefault()
      // The browser cannot replace bytes already delivered to a PTY.
      if (event.inputType === 'insertReplacementText') { node.textContent = ''; return }
      const text = event.inputType === 'deleteContentBackward' ? '\x7f'
        : event.inputType === 'deleteContentForward' ? '\x1b[3~'
          : event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak' ? '\r'
            : event.data ?? event.dataTransfer?.getData('text/plain')
      if (text) sendTerminalText(text, event.inputType === 'insertFromPaste')
      node.textContent = ''
    }
    node.addEventListener('beforeinput', beforeInput)
    return () => node.removeEventListener('beforeinput', beforeInput)
  }, [terminalInput, keyDown, id, nodeRef])
  if (keyDown) {
    handlers.onKeyDown = (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget) return
      if (terminalInput) {
        if (event.nativeEvent.isComposing || event.key === 'Process') return
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return
        event.preventDefault()
        event.stopPropagation()
      }
      keyDown(keyPayload(id, 'keyDown', event))
    }
    if (terminalInput) {
      handlers.onCompositionStart = () => { compositionCommitted.current = false }
      handlers.onCompositionEnd = (event: React.CompositionEvent<HTMLElement>) => {
        if (event.data && !compositionCommitted.current) {
          compositionCommitted.current = true
          sendTerminalText(event.data)
        }
        event.currentTarget.textContent = ''
      }
      handlers.onPaste = (event: React.ClipboardEvent<HTMLElement>) => { const data = event.clipboardData.getData('text/plain'); if (!data) return; event.preventDefault(); sendTerminalText(data, true); event.currentTarget.textContent = '' }
    }
  }
  if (keyUp) handlers.onKeyUp = (event: React.KeyboardEvent) => { if (event.target !== event.currentTarget) return; keyUp(keyPayload(id, 'keyUp', event)) }
  const focus = on('onFocus'); const blur = on('onBlur')
  if (focus) handlers.onFocus = (event: React.FocusEvent) => { if (event.target === event.currentTarget) focus(plainPayload(id, 'focus')) }
  if (blur) handlers.onBlur = (event: React.FocusEvent) => { if (event.target === event.currentTarget) blur(plainPayload(id, 'blur')) }
  const scroll = on('onScroll')
  // gpuix reports wheel deltas on any element the wheel passes over; DOM only fires scroll on scrollers.
  if (scroll) handlers.onWheel = (event: React.WheelEvent) => scroll(plainPayload(id, 'scroll', { deltaX: -event.deltaX, deltaY: -event.deltaY, precise: event.deltaMode === 0, x: event.clientX, y: event.clientY, modifiers: { shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, cmd: event.metaKey } }))
  const style = stateStyle(props.style, hovered, active)
  const Tag = tag as 'div'
  return (
    <Tag
      ref={setNode as React.Ref<HTMLDivElement>}
      className={tag === 'span' ? 'gx-text' : 'gx-div'}
      style={style}
      data-testid={props.testId}
      tabIndex={props.tabIndex}
      contentEditable={terminalInput}
      suppressContentEditableWarning={terminalInput}
      inputMode={terminalInput ? 'text' : undefined}
      spellCheck={terminalInput ? false : undefined}
      autoCorrect={terminalInput ? 'off' : undefined}
      autoCapitalize={terminalInput ? 'none' : undefined}
      role={terminalInput ? 'textbox' : undefined}
      aria-label={terminalInput ? 'Terminal input' : undefined}
      {...dataProps(props)}
      {...handlers}
    >
      {props.children as ReactNode}
    </Tag>
  )
})

const Svg = forwardRef(function Svg(props: AnyProps, ref) {
  const { setNode } = useInstance('svg', props, ref)
  const src = String(props.src ?? '')
  const style = toCss(props.style as StyleDesc)
  // Icons are `currentColor` SVGs; a mask keeps them tinted by CSS color like gpuix does.
  return <span ref={setNode as never} className="gx-svg" data-testid={props.testId as string | undefined} style={{ ...style, display: 'inline-block', backgroundColor: 'currentColor', WebkitMaskImage: `url("${src}")`, maskImage: `url("${src}")`, WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat', WebkitMaskSize: 'contain', maskSize: 'contain', WebkitMaskPosition: 'center', maskPosition: 'center', ...(props.rotation ? { transform: `rotate(${props.rotation}deg)` } : {}) }} />
})

const Img = forwardRef(function Img(props: AnyProps, ref) {
  const { setNode } = useInstance('img', props, ref)
  const fit = props.objectFit as string | undefined
  return <img ref={setNode as never} className="gx-img" data-testid={props.testId as string | undefined} src={String(props.src ?? '')} alt={String(props.alt ?? '')} style={{ ...toCss(props.style as StyleDesc), objectFit: fit === 'scaleDown' ? 'scale-down' : (fit as never) ?? 'fill', display: 'block' }} />
})

function textStyleFor(style: StyleDesc | undefined): React.CSSProperties {
  const css = toCss(style)
  const { borderStyle: _bs, borderWidth: _bw, borderColor: _bc, ...rest } = css
  return { ...rest, border: 0, outline: 'none', boxShadow: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: css.fontSize ?? 'inherit', lineHeight: css.lineHeight ?? 'inherit', color: css.color ?? 'inherit', margin: 0, paddingTop: css.paddingTop ?? 0, paddingBottom: css.paddingBottom ?? 0, paddingLeft: css.paddingLeft ?? 0, paddingRight: css.paddingRight ?? 0, caretColor: css.color, resize: 'none' }
}

const Field = forwardRef<unknown, AnyProps & { multiline: boolean }>(function Field({ multiline, ...props }, ref) {
  const { id, setNode } = useInstance(multiline ? 'textarea' : 'input', props, ref)
  const value = String(props.value ?? '')
  const lineHeight = typeof (props.style as StyleDesc | undefined)?.lineHeight === 'number' ? (props.style as StyleDesc).lineHeight as number : 21
  const minRows = Number(props.minRows ?? 1)
  const maxRows = Number(props.maxRows ?? (multiline ? 10 : 1))
  const onChange = props.onChange as ((event: EventPayload) => void) | undefined
  const onSubmit = props.onSubmit as ((event: EventPayload) => void) | undefined
  const onKeyDown = props.onKeyDown as ((event: EventPayload) => void) | undefined
  const onKeyUp = props.onKeyUp as ((event: EventPayload) => void) | undefined
  const onFocus = props.onFocus as ((event: EventPayload) => void) | undefined
  const onBlur = props.onBlur as ((event: EventPayload) => void) | undefined
  const onClick = props.onClick as ((event: EventPayload) => void) | undefined
  const nodeRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (!node || !multiline) return
    node.style.height = '0px'
    const rows = Math.max(minRows, Math.min(maxRows, Math.ceil(node.scrollHeight / lineHeight)))
    node.style.height = `${rows * lineHeight}px`
    node.style.overflowY = node.scrollHeight > rows * lineHeight + 1 ? 'auto' : 'hidden'
  }, [value, multiline, minRows, maxRows, lineHeight])
  const shared = {
    ref: (el: HTMLTextAreaElement | HTMLInputElement | null) => { nodeRef.current = el; setNode(el as HTMLElement | null) },
    'data-testid': props.testId as string | undefined,
    value,
    placeholder: String(props.placeholder ?? ''),
    readOnly: Boolean(props.readOnly),
    autoFocus: Boolean(props.autoFocus),
    tabIndex: props.tabIndex as number | undefined,
    spellCheck: false,
    style: textStyleFor(props.style as StyleDesc),
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => onChange?.(plainPayload(id, 'change', { value: event.target.value })),
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      const payload = keyPayload(id, 'keyDown', event)
      onKeyDown?.(payload)
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        onSubmit?.(plainPayload(id, 'submit', { value: (event.target as HTMLTextAreaElement).value, modifiers: payload.modifiers }))
      }
      if (event.key === 'Tab' && onKeyDown) event.preventDefault()
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => onKeyUp?.(keyPayload(id, 'keyUp', event)),
    onFocus: () => onFocus?.(plainPayload(id, 'focus')),
    onBlur: () => onBlur?.(plainPayload(id, 'blur')),
    onClick: (event: React.MouseEvent) => onClick?.(mousePayload(id, 'click', event)),
  }
  return multiline
    ? <textarea className="gx-textarea" rows={minRows} {...(shared as React.TextareaHTMLAttributes<HTMLTextAreaElement>)} />
    : <input className="gx-input" type="text" {...(shared as React.InputHTMLAttributes<HTMLInputElement>)} />
})

const SIDE_ANCHOR: Record<string, React.CSSProperties> = {
  'bottom:start': { top: '100%', left: 0 },
  'bottom:center': { top: '100%', left: '50%', transform: 'translateX(-50%)' },
  'bottom:end': { top: '100%', right: 0 },
  'top:start': { bottom: '100%', left: 0 },
  'top:center': { bottom: '100%', left: '50%', transform: 'translateX(-50%)' },
  'top:end': { bottom: '100%', right: 0 },
  'right:start': { left: '100%', top: 0 },
  'right:center': { left: '100%', top: '50%', transform: 'translateY(-50%)' },
  'right:end': { left: '100%', bottom: 0 },
  'left:start': { right: '100%', top: 0 },
  'left:center': { right: '100%', top: '50%', transform: 'translateY(-50%)' },
  'left:end': { right: '100%', bottom: 0 },
}

// Floating layer anchored at its trigger, snapped inside the window after layout like gpuix snap_to_window_with_margin.
const Anchored = forwardRef(function Anchored(props: AnyProps, ref) {
  const { setNode } = useInstance('anchored', props, ref)
  const side = String(props.side ?? 'bottom')
  const align = String(props.align ?? 'start')
  const gap = Number(props.gap ?? 0)
  const offset = (props.offset as { x: number; y: number } | undefined) ?? { x: 0, y: 0 }
  const margin = Number(props.snapMargin ?? 8)
  const position = props.position as { x: number; y: number } | undefined
  const inner = useRef<HTMLDivElement | null>(null)
  const [shift, setShift] = useState({ x: 0, y: 0 })
  useLayoutEffect(() => {
    const node = inner.current
    if (!node) return
    const next = popupViewportShift(node.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, margin, shift)
    setShift((current) => current.x === next.x && current.y === next.y ? current : next)
  })
  const base: React.CSSProperties = position
    ? { position: 'fixed', left: position.x, top: position.y }
    : { position: 'absolute', ...SIDE_ANCHOR[`${side}:${align}`] }
  const sideShift = side === 'top' ? { y: -gap } : side === 'bottom' ? { y: gap } : side === 'left' ? { x: -gap } : { x: gap }
  return (
    <div ref={setNode as never} className="gx-anchored" style={{ ...base, zIndex: 40 + Number(props.priority ?? 0), pointerEvents: 'none' }}>
      <div ref={inner} style={{ position: 'relative', pointerEvents: 'auto', left: (sideShift.x ?? 0) + offset.x + shift.x, top: (sideShift.y ?? 0) + offset.y + shift.y, ...(String(base.transform ?? '') ? { transform: base.transform } : {}) }}>
        {props.children as ReactNode}
      </div>
    </div>
  )
})

function Shimmer(props: AnyProps) {
  const style = toCss(props.style as StyleDesc)
  return <span className="gx-shimmer" data-testid={props.testId as string | undefined} style={{ ...style, ['--shimmer-base' as string]: props.baseColor, ['--shimmer-highlight' as string]: props.highlightColor, animationDuration: `${Number(props.duration ?? 2)}s` }}>{String(props.text ?? '')}</span>
}

function Unsupported({ type, ...props }: AnyProps & { type: string }) {
  return <div className="gx-unsupported" data-gx-type={type} style={toCss(props.style as StyleDesc)} />
}

const VirtualList = forwardRef(function VirtualList(props: AnyProps, ref) {
  const { id, setNode } = useInstance('virtual-list', props, ref)
  return <DomVirtualList elementId={id} setNode={setNode} {...(props as object)} />
})

const COMPONENTS: Record<string, React.ComponentType<AnyProps>> = {
  div: (props) => <Box tag="div" {...props} />,
  text: (props) => <Box tag="span" {...props} />,
  svg: Svg as never,
  img: Img as never,
  canvas: (props) => <Unsupported type="canvas" {...props} />,
  input: (props) => <Field multiline={false} {...props} />,
  textarea: (props) => <Field multiline {...props} />,
  anchored: Anchored as never,
  shimmer: Shimmer,
  code: DomCode as never,
  diff: DomDiff as never,
  markdown: DomMarkdown as never,
  terminal: (props) => <Unsupported type="terminal" {...props} />,
  browser: (props) => <Unsupported type="browser" {...props} />,
  'virtual-list': VirtualList as never,
}

// Refs must reach the Box/Field instance, so forwardRef wrappers are pre-built once per intrinsic.
const FORWARDED: Record<string, React.ForwardRefExoticComponent<AnyProps>> = Object.fromEntries(
  Object.entries(COMPONENTS).map(([type, Component]) => [type, forwardRef<unknown, AnyProps>(function Intrinsic(props, ref) {
    return <Component {...props} ref={ref} />
  })]),
)

function resolve(type: unknown): unknown {
  return typeof type === 'string' && FORWARDED[type] ? FORWARDED[type] : type
}

export function jsx(type: unknown, props: AnyProps, key?: React.Key): React.ReactElement {
  return domJsx(resolve(type) as never, props as never, key as never)
}
export function jsxs(type: unknown, props: AnyProps, key?: React.Key): React.ReactElement {
  return domJsxs(resolve(type) as never, props as never, key as never)
}
export const Fragment = DomFragment
export function jsxDEV(type: unknown, props: AnyProps, key?: React.Key): React.ReactElement {
  return domJsx(resolve(type) as never, props as never, key as never)
}

// React.createElement('svg' | 'img' | 'markdown' | ...) calls in src/ui bypass the jsx runtime. The web bundle aliases
// 'react' to src/dom/react-shim.ts, which routes createElement through resolveIntrinsic.
export function resolveIntrinsic(type: unknown): unknown { return resolve(type) }
export function installCreateElementBridge(): void {}

const MotionDiv = forwardRef<unknown, AnyProps>(function MotionDiv({ initial, animate, transition, ...props }, ref) {
  return <Box tag="div" {...props} ref={ref} motion={{ ...(initial === undefined ? {} : { initial }), animate, ...(transition === undefined ? {} : { transition }) } as AnyProps} />
})
export const motion = { div: MotionDiv }

export function handleGpuixEvent(): void {}
export function createRoot(): never { throw new Error('createRoot is not available on the DOM host') }
export function flushSync<T>(fn: () => T): T { return fn() }
export function enableAutomation(): void {}
export const MAC_CPU_THROTTLES = [] as const
export function readMacCpuThrottle(): undefined { return undefined }
export function applyMacCpuThrottleFromEnv(): void {}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectScrollDownButton, SelectScrollUpButton, SelectSeparator, SelectTrigger, SelectValue } from '@gpuix/react/select'
export { Combobox, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxInput, ComboboxItem, ComboboxLabel, ComboboxList, ComboboxSeparator, ComboboxTrigger, ComboboxValue } from '@gpuix/react/combobox'
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@gpuix/react/tooltip'
export type { SelectContentProps, SelectItemProps, SelectItemState, SelectProps, SelectTriggerProps, SelectTriggerState, SelectValueProps } from '@gpuix/react/select'
export type { ComboboxInputProps, ComboboxItemProps, ComboboxItemState, ComboboxListProps, ComboboxProps, ComboboxTriggerProps, ComboboxValueProps } from '@gpuix/react/combobox'
