import type { ComposerImage } from '../pi/types.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { utf8ByteLength } from './frames.ts'

export const SNAPSHOT_IMAGE_LIMIT_BYTES = 256 * 1024
export interface OmittedImageData { omitted: true; bytes: number }
export type SnapshotComposerImage = Omit<ComposerImage, 'data'> & { data: string | OmittedImageData }
export type WorkbenchSnapshot = Omit<WorkbenchState, 'editorImages'> & { editorImages: SnapshotComposerImage[] }
export type SnapshotKey = keyof WorkbenchSnapshot
export interface SnapshotPatch { version: 1; changed: Partial<WorkbenchSnapshot>; removed?: SnapshotKey[] }

export function serializeSnapshot(state: WorkbenchState): WorkbenchSnapshot {
  return { ...state, editorImages: state.editorImages.map(serializeImage) }
}
export function diffSnapshots(previous: WorkbenchSnapshot | undefined, next: WorkbenchSnapshot): SnapshotPatch {
  if (!previous) return { version: 1, changed: next }
  const changed: Partial<WorkbenchSnapshot> = {}
  const removed: SnapshotKey[] = []
  for (const key of Object.keys(next) as SnapshotKey[]) if (!Object.is(previous[key], next[key])) (changed as Record<string, unknown>)[key] = next[key]
  for (const key of Object.keys(previous) as SnapshotKey[]) if (!(key in next)) removed.push(key)
  return { version: 1, changed, ...(removed.length ? { removed } : {}) }
}
export function applySnapshotPatch(current: WorkbenchSnapshot, patch: SnapshotPatch): WorkbenchSnapshot {
  const next = { ...current, ...patch.changed }
  for (const key of patch.removed ?? []) delete (next as unknown as Record<string, unknown>)[key]
  return next
}
export function isPatchEmpty(patch: SnapshotPatch): boolean { return Object.keys(patch.changed).length === 0 && !patch.removed?.length }
function serializeImage(image: ComposerImage): SnapshotComposerImage {
  const bytes = utf8ByteLength(image.data)
  if (bytes <= SNAPSHOT_IMAGE_LIMIT_BYTES) return image
  const { previewPath, ...metadata } = image
  return { ...metadata, ...(previewPath && !previewPath.toLowerCase().startsWith('data:') ? { previewPath } : {}), data: { omitted: true, bytes } }
}
