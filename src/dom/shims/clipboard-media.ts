// Browser clipboard helpers with the same exports as src/ui/clipboard-media.ts. Images stay as data URLs.

import type { ComposerImage, PiContentBlock, PiMessage } from '../../pi/types.ts'

const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024

export async function readClipboardImage(): Promise<ComposerImage | undefined> {
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const type = item.types.find((candidate) => candidate.startsWith('image/'))
      if (!type) continue
      const blob = await item.getType(type)
      return createComposerImage(new Uint8Array(await blob.arrayBuffer()), type)
    }
  } catch {
    return undefined
  }
  return undefined
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function editorTextAfterImagePaste(previous: string, current: string): string {
  if (previous === current) return current
  let prefix = 0
  while (prefix < previous.length && previous[prefix] === current[prefix]) prefix += 1
  let suffix = 0
  while (suffix < previous.length - prefix && previous[previous.length - suffix - 1] === current[current.length - suffix - 1]) suffix += 1
  const inserted = current.slice(prefix, current.length - suffix).trim().replace(/^['"]|['"]$/g, '')
  const normalized = inserted.toLowerCase()
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].some((extension) => normalized.endsWith(extension))
  const isPath = normalized.startsWith('file://') || normalized.includes('/') || normalized.includes('\\')
  return isImage && isPath ? previous : current
}

export function createComposerImage(bytes: Uint8Array, mimeType?: string, fileName?: string): ComposerImage {
  if (bytes.byteLength === 0) throw new Error('Clipboard image is empty')
  if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('Clipboard image exceeds 20 MB')
  const detectedMime = mimeType ?? sniffImageMime(bytes)
  if (!detectedMime) throw new Error('Clipboard does not contain a supported image')
  const extension = detectedMime === 'image/jpeg' ? 'jpg' : detectedMime === 'image/gif' ? 'gif' : detectedMime === 'image/webp' ? 'webp' : 'png'
  const id = `image-${crypto.randomUUID()}`
  const data = base64(bytes)
  return {
    id,
    type: 'image',
    data,
    mimeType: detectedMime,
    previewPath: `data:${detectedMime};base64,${data}`,
    fileName: fileName?.trim() || `Pasted image.${extension}`,
    size: bytes.byteLength,
  }
}

export function hydrateMessageImages(messages: PiMessage[]): PiMessage[] {
  return messages
}

export function imageBlocks(message: PiMessage): Array<PiContentBlock & { type: 'image'; data: string; mimeType: string }> {
  if (!Array.isArray(message.content)) return []
  return message.content.filter((block): block is PiContentBlock & { type: 'image'; data: string; mimeType: string } => (
    block.type === 'image' && typeof block.data === 'string' && block.data.length > 0 && typeof block.mimeType === 'string'
  ))
}

export function messageImageSrc(image: { data?: string; mimeType?: string; previewPath?: string }): string | undefined {
  if (image.previewPath?.startsWith('data:') || image.previewPath?.startsWith('http')) return image.previewPath
  if (image.data && image.mimeType) return `data:${image.mimeType};base64,${image.data}`
  return undefined
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.byteLength; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 4)) === 'GIF8') return 'image/gif'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}
