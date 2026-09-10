import { hasNativeTrafficLights } from './window-chrome.ts'
import React, { useEffect, useRef, useState } from 'react'
import type { Notice, NoticeKind, WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { IconButton, NativeVirtualList, useNativeVirtualWindow } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'
import { LAYOUT_MOTION_TRANSITION, MotionDiv } from './motion.ts'
import { useResponsiveLayout } from './responsive.tsx'

export function composerNotificationStackHeight(noticeCount: number): number {
  const visibleCount = Math.min(3, Math.max(0, noticeCount))
  return visibleCount === 0 ? 0 : 48 + (visibleCount - 1) * 18
}

const NOTIFICATION_EXIT_MS = 180

export function ComposerNotificationStack({ notices, onDismiss, onClear }: { notices: Notice[]; onDismiss(id: number): void; onClear(): void }) {
  const [exitingIds, setExitingIds] = useState<Set<number>>(() => new Set())
  const [promotions, setPromotions] = useState<Map<number, { opacity: number; top: number }>>(() => new Map())
  const [settlingIds, setSettlingIds] = useState<Set<number>>(() => new Set())
  const dismissTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const settleTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => () => {
    for (const timer of dismissTimers.current.values()) clearTimeout(timer)
    for (const timer of settleTimers.current) clearTimeout(timer)
    dismissTimers.current.clear()
    settleTimers.current.clear()
  }, [])
  const visible = notices.slice(-3)
  const dismiss = (id: number) => {
    if (dismissTimers.current.has(id)) return
    const index = visible.findIndex((notice) => notice.id === id)
    const nextMotions = new Map<number, { opacity: number; top: number }>()
    if (index >= 0 && notices.length > visible.length) {
      for (let candidate = 0; candidate < index; candidate += 1) {
        const notice = visible[candidate]
        if (notice) nextMotions.set(notice.id, { opacity: stackOpacity(visible.length - candidate - 2), top: 18 })
      }
    } else if (index >= 0) {
      for (let candidate = index + 1; candidate < visible.length; candidate += 1) {
        const notice = visible[candidate]
        if (notice) nextMotions.set(notice.id, { opacity: stackOpacity(visible.length - candidate - 1), top: -18 })
      }
    }
    const movingIds = [...nextMotions.keys()]
    setExitingIds((current) => new Set(current).add(id))
    if (movingIds.length > 0) {
      setPromotions((current) => {
        const next = new Map(current)
        for (const [noticeId, motion] of nextMotions) next.set(noticeId, motion)
        return next
      })
    }
    const timer = setTimeout(() => {
      dismissTimers.current.delete(id)
      onDismiss(id)
      setExitingIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      if (movingIds.length > 0) {
        setPromotions((current) => {
          const next = new Map(current)
          for (const noticeId of movingIds) next.delete(noticeId)
          return next
        })
        setSettlingIds((current) => {
          const next = new Set(current)
          for (const noticeId of movingIds) next.add(noticeId)
          return next
        })
        const settleTimer = setTimeout(() => {
          settleTimers.current.delete(settleTimer)
          setSettlingIds((current) => {
            const next = new Set(current)
            for (const noticeId of movingIds) next.delete(noticeId)
            return next
          })
        }, 0)
        settleTimers.current.add(settleTimer)
      }
    }, NOTIFICATION_EXIT_MS)
    dismissTimers.current.set(id, timer)
  }
  if (visible.length === 0) return null

  return (
    <div testId="composer-notification-stack" style={{ width: '100%', maxWidth: 768, display: 'flex', flexDirection: 'column', marginBottom: 8 }}>
      {visible.map((notice, index) => {
        const newest = index === visible.length - 1
        const depth = visible.length - index - 1
        return (
          <NotificationCard
            key={notice.id}
            notice={notice}
            newest={newest}
            depth={depth}
            stacked={index > 0}
            exiting={exitingIds.has(notice.id)}
            promotion={promotions.get(notice.id)}
            settling={settlingIds.has(notice.id)}
            onDismiss={() => dismiss(notice.id)}
            onClear={onClear}
          />
        )
      })}
    </div>
  )
}

function NotificationCard({ notice, newest, depth, stacked, exiting, promotion, settling, onDismiss, onClear }: { notice: Notice; newest: boolean; depth: number; stacked: boolean; exiting: boolean; promotion: { opacity: number; top: number } | undefined; settling: boolean; onDismiss(): void; onClear(): void }) {
  const tone = noticeColor(notice.kind)
  const baseOpacity = promotion?.opacity ?? stackOpacity(newest ? 0 : depth)
  return (
    <MotionDiv
      testId={newest ? 'notification-toast' : 'notification-stack-item'}
      initial={{ opacity: 0, top: 10 }}
      animate={{ opacity: exiting ? 0 : baseOpacity, top: exiting ? 18 : promotion?.top ?? 0 }}
      transition={{ duration: settling ? 0 : NOTIFICATION_EXIT_MS / 1_000, ease: 'easeOut' }}
      style={{
        position: 'relative',
        height: 40,
        minHeight: 40,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginTop: stacked ? -22 : 0,
        paddingTop: 8,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 12,
        borderRadius: 11,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        backgroundColor: colors.popover,
        overflow: 'hidden',
        selectionColor: '#4F67D866',
      }}
    >
      <div style={{ width: 18, height: 18, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: `${tone}22`, flexShrink: 0 }}>
        <Icon name={notice.kind === 'error' ? 'x' : notice.kind === 'warning' ? 'bell' : 'check'} size={11} color={tone} />
      </div>
      <AutoScrollingNoticeText message={notice.message} {...(newest ? { testId: 'notification-toast-message', scrollTestId: 'notification-toast-scroll' } : {})} />
      <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontSans, whiteSpace: 'nowrap', flexShrink: 0 }}>{formatDate(notice.createdAt)}</text>
      <div style={{ height: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        {newest && (
          <div testId="clear-notifications" tabIndex={0} style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover }, flexShrink: 0 }} onClick={onClear}>
            <div testId="clear-notifications-icon" style={{ width: 12, height: 12, pointerEvents: 'none' }}><Icon name="eraser" size={12} color={colors.textFaint} /></div>
          </div>
        )}
        <div testId={`dismiss-notification:${notice.id}`} tabIndex={0} style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: exiting ? 'default' : 'pointer', hover: { backgroundColor: colors.hover }, flexShrink: 0 }} onClick={onDismiss}>
          <div style={{ width: 11, height: 11, pointerEvents: 'none' }}><Icon name="x" size={11} color={colors.textFaint} /></div>
        </div>
      </div>
    </MotionDiv>
  )
}

export function NotificationLedgerView({ state, fullscreen = false, fullscreenProgress, panelWidth = 422, onClear, onClose }: { state: WorkbenchState; fullscreen?: boolean; fullscreenProgress?: number; panelWidth?: number; onClear(): void; onClose?(): void }) {
  const { mobile } = useResponsiveLayout()
  const notices = [...state.notices].reverse()
  const virtualWindow = useNativeVirtualWindow(notices.length, `notifications:${notices.length}:${notices[0]?.id ?? ''}:${notices.at(-1)?.id ?? ''}`)
  const visibleNotices = notices.slice(virtualWindow.windowStart, virtualWindow.windowEnd)
  const titlebarProgress = fullscreenProgress ?? (fullscreen ? 1 : 0)
  const trafficLightInset = hasNativeTrafficLights() ? 96 * titlebarProgress : 0
  return (
    <div testId="notification-panel" style={{ width: fullscreen ? '100%' : panelWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel }}>
      <MotionDiv initial={false} animate={{ paddingLeft: 14 + trafficLightInset }} transition={LAYOUT_MOTION_TRANSITION} testId="notification-panel-header" style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14 + trafficLightInset, paddingRight: 14 }}>
        <Icon name="bell" size={15} color={colors.textMuted} />
        <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>Notifications</text>
        <div style={{ flexGrow: 1 }} />
        {!mobile && <text style={{ color: colors.textFaint, fontSize: 10 }}>{`${notices.length} saved`}</text>}
        {notices.length > 0 && (mobile
          ? <IconButton icon="eraser" label="Clear all notifications" testId="clear-notification-ledger" onClick={onClear} />
          : (
            <div testId="clear-notification-ledger" tabIndex={0} style={{ height: 26, display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 7, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClear}>
              <text style={{ color: colors.textMuted, fontSize: 10, pointerEvents: 'none' }}>Clear all</text>
            </div>
          ))}
        {onClose && <IconButton icon="x" label="Close notifications" testId="notification-panel-close" onClick={onClose} />}
      </MotionDiv>
      <NativeVirtualList testId="notification-list" alignment="top" estimatedItemHeight={52} overdraw={300} itemCount={Math.max(1, notices.length)} windowStart={virtualWindow.windowStart} onVisibleRange={virtualWindow.onVisibleRange} style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
        {notices.length === 0 ? (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 180, gap: 9 }}>
            <div style={{ width: 38, height: 38, borderRadius: 19, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card }}><Icon name="bell" size={18} color={colors.textFaint} /></div>
            <text style={{ color: colors.text, fontSize: 15, fontWeight: 600 }}>No notifications yet</text>
            <text style={{ maxWidth: '86%', color: colors.textFaint, fontSize: 11, lineHeight: 17, textAlign: 'center', whiteSpace: 'normal' }}>Harness and workspace events will be kept here.</text>
          </div>
        ) : visibleNotices.map((notice) => <LedgerRow key={notice.id} notice={notice} />)}
      </NativeVirtualList>
    </div>
  )
}

function LedgerRow({ notice }: { notice: Notice }) {
  const tone = noticeColor(notice.kind)
  return (
    <div testId="notification-ledger-row-frame" style={{ width: '100%', flexShrink: 0, display: 'flex', flexDirection: 'row', paddingLeft: 14, paddingRight: 14, paddingTop: 4, paddingBottom: 4 }}>
      <div testId="notification-ledger-row" style={{ minWidth: 0, minHeight: 40, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, selectionColor: '#4F67D866' }}>
        <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone, flexShrink: 0 }} />
        <AutoScrollingNoticeText message={notice.message} scrollTestId="notification-ledger-scroll" />
        <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontSans, whiteSpace: 'nowrap', flexShrink: 0 }}>{formatDate(notice.createdAt)}</text>
      </div>
    </div>
  )
}

function AutoScrollingNoticeText({ message, testId, scrollTestId }: { message: string; testId?: string; scrollTestId?: string }) {
  return (
    <div {...(scrollTestId ? { testId: scrollTestId } : {})} style={{ minWidth: 0, height: 18, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', overflow: 'hidden' }}>
      <text {...(testId ? { testId } : {})} style={{ minWidth: 0, color: colors.textMuted, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontFamily: nativeTheme.fontSans }}>{message}</text>
    </div>
  )
}

function stackOpacity(depth: number): number {
  return depth === 0 ? 1 : depth === 1 ? 0.55 : 0.28
}

function noticeColor(kind: NoticeKind): string {
  if (kind === 'error') return colors.error
  if (kind === 'warning') return colors.warning
  return colors.success
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
