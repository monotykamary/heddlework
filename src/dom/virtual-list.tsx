/** @jsxImportSource react */
// DOM counterpart of gpuix's <virtual-list>. It owns a scroller, measures children, keeps the tail pinned when
// followTail is set, anchors the viewport across prepends, and reports visibleRange in logical indexes
// (windowStart + child offset) exactly like packages/native's VirtualListEntry.

import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { EventPayload, StyleDesc } from '@gpuix/react'
import { toCss } from './style.ts'
import { registerScrollHandle } from './host.tsx'

interface Props {
  elementId: number
  setNode(node: HTMLElement | null): void
  children?: ReactNode
  style?: StyleDesc
  alignment?: 'top' | 'bottom'
  followTail?: boolean
  overdraw?: number
  estimatedItemHeight?: number
  testId?: string
  itemCount?: number
  windowStart?: number
  onScroll?(event: EventPayload): void
  onVisibleRange?(event: EventPayload): void
}

const TAIL_SLACK_PX = 24

export function DomVirtualList({ elementId, setNode, children, style, alignment = 'top', followTail = false, estimatedItemHeight = 72, testId, itemCount, windowStart = 0, onScroll, onVisibleRange }: Props) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const rendered = React.Children.count(children)
  const total = itemCount !== undefined && itemCount > rendered ? itemCount : rendered
  const before = Math.max(0, Math.min(windowStart, total - rendered))
  const after = Math.max(0, total - rendered - before)
  const [beforePx, setBeforePx] = useState(before * estimatedItemHeight)
  const lastRange = useRef<[number, number] | undefined>(undefined)
  const lastWindowStart = useRef(windowStart)
  const lastScrollTop = useRef(0)
  const pendingAnchor = useRef<{ key: string; top: number } | undefined>(undefined)
  const firstKeyRef = useRef<string | undefined>(undefined)
  const followRef = useRef(followTail)
  followRef.current = followTail

  useLayoutEffect(() => setBeforePx(before * estimatedItemHeight), [before, estimatedItemHeight])

  useEffect(() => registerScrollHandle(elementId, {
    scrollTo(x, y) { const node = scroller.current; if (node) { node.scrollLeft = x; node.scrollTop = y } },
    scrollToItem(index, offset = 0) {
      const node = scroller.current
      const child = content.current?.children[index - before] as HTMLElement | undefined
      if (!node) return
      node.scrollTop = child ? child.offsetTop + offset : index * estimatedItemHeight + offset
    },
    offset() { const node = scroller.current; return node ? [node.scrollLeft, node.scrollTop] : [0, 0] },
  }), [before, elementId, estimatedItemHeight])

  // First child key before render, so a prepend can be re-anchored after layout.
  const childArray = React.Children.toArray(children)
  const firstKey = childArray.length > 0 ? String((childArray[0] as { key?: React.Key | null }).key ?? '') : undefined
  if (firstKeyRef.current !== undefined && firstKey !== undefined && firstKeyRef.current !== firstKey && scroller.current && content.current && !followRef.current) {
    const previous = Array.from(content.current.children).find((child) => (child as HTMLElement).dataset.gxKey === firstKeyRef.current) as HTMLElement | undefined
    if (previous) pendingAnchor.current = { key: firstKeyRef.current, top: previous.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top }
  }
  firstKeyRef.current = firstKey

  const report = () => {
    const node = scroller.current
    const list = content.current
    if (!node || !list || !onVisibleRange) return
    const top = node.scrollTop
    const bottom = top + node.clientHeight
    let first = -1
    let last = -1
    const kids = list.children
    for (let index = 0; index < kids.length; index++) {
      const child = kids[index] as HTMLElement
      const y0 = child.offsetTop
      const y1 = y0 + child.offsetHeight
      if (y1 <= top || y0 >= bottom) continue
      if (first === -1) first = index
      last = index
    }
    if (first === -1) {
      first = top < beforePx ? Math.floor(top / estimatedItemHeight) : before + kids.length
      last = first
    } else {
      first += before
      last += before
    }
    const range: [number, number] = [first, last + 1]
    if (lastRange.current && lastRange.current[0] === range[0] && lastRange.current[1] === range[1]) return
    lastRange.current = range
    onVisibleRange({ elementId, eventType: 'visibleRange', startIndex: range[0], endIndex: range[1] })
  }

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    if (pendingAnchor.current) {
      const anchor = pendingAnchor.current
      pendingAnchor.current = undefined
      const target = Array.from(content.current?.children ?? []).find((child) => (child as HTMLElement).dataset.gxKey === anchor.key) as HTMLElement | undefined
      if (target) {
        const now = target.getBoundingClientRect().top - node.getBoundingClientRect().top
        node.scrollTop += now - anchor.top
      }
    } else if (lastWindowStart.current !== windowStart && !followRef.current) {
      node.scrollTop += (before - Math.max(0, Math.min(lastWindowStart.current, total - rendered))) * 0
    }
    lastWindowStart.current = windowStart
    if (followRef.current) node.scrollTop = node.scrollHeight
    lastScrollTop.current = node.scrollTop
    report()
  })

  // Tail pinning must survive late layout (images, fonts, code blocks measuring after paint).
  useEffect(() => {
    const node = scroller.current
    const list = content.current
    if (!node || !list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followRef.current) node.scrollTop = node.scrollHeight
      report()
    })
    observer.observe(list)
    observer.observe(node)
    return () => observer.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleScroll = () => {
    const node = scroller.current
    if (!node) return
    const delta = node.scrollTop - lastScrollTop.current
    lastScrollTop.current = node.scrollTop
    // gpuix reports wheel deltas with negative meaning downward travel; a DOM scroll increase is downward.
    if (delta !== 0) onScroll?.({ elementId, eventType: 'scroll', deltaY: -delta, precise: true })
    report()
  }
  // gpuix re-reports the visible range on every wheel, even when nothing moved. A list that fits its viewport never
  // scrolls, and consumers reset their cached range on session change after the mount report, so the dedupe would
  // otherwise leave them blind to the wheel that should page in older history.
  const handleWheel = () => {
    lastRange.current = undefined
    report()
  }

  const css = toCss(style)
  return (
    <div
      ref={(el) => { scroller.current = el; setNode(el) }}
      className="gx-virtual-list"
      data-testid={testId}
      data-alignment={alignment}
      data-window-start={before}
      data-window-end={before + rendered}
      style={{ ...css, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', overflowAnchor: 'none' }}
      onScroll={handleScroll}
      onWheel={handleWheel}
    >
      {alignment === 'bottom' ? <div aria-hidden style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} /> : null}
      {before > 0 ? <div aria-hidden data-testid="gx-window-before" style={{ height: beforePx, flexShrink: 0 }} /> : null}
      <div ref={content} className="gx-virtual-content" style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, width: '100%' }}>
        {childArray.map((child) => (
          <div key={(child as { key?: React.Key | null }).key ?? undefined} data-gx-key={String((child as { key?: React.Key | null }).key ?? '')} className="gx-virtual-row" style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, width: '100%' }}>{child}</div>
        ))}
      </div>
      {after > 0 ? <div aria-hidden data-testid="gx-window-after" style={{ height: after * estimatedItemHeight, flexShrink: 0 }} /> : null}
    </div>
  )
}
