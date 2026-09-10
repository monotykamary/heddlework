export function popupViewportShift(
  rect: { left: number; right: number; top: number; bottom: number },
  viewport: { width: number; height: number },
  margin: number,
  applied: { x: number; y: number },
): { x: number; y: number } {
  // Measure the uncorrected position. Measuring the already-snapped popup alternates between zero and the
  // correction on every layout effect, eventually exhausting React's nested-update limit.
  const left = rect.left - applied.x, right = rect.right - applied.x
  const top = rect.top - applied.y, bottom = rect.bottom - applied.y
  let x = 0, y = 0
  if (right > viewport.width - margin) x = viewport.width - margin - right
  if (left + x < margin) x = margin - left
  if (bottom > viewport.height - margin) y = viewport.height - margin - bottom
  if (top + y < margin) y = margin - top
  return { x, y }
}
