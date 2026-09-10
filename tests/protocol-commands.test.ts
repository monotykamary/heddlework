import { describe, expect, it } from 'bun:test'
import { applyWorkbenchCommand, isWorkbenchCommand } from '../src/protocol/commands.ts'
import { serializeSnapshot, SNAPSHOT_IMAGE_LIMIT_BYTES } from '../src/protocol/snapshot.ts'
import { createInitialState } from '../src/workbench/state.ts'
import type { WorkbenchController } from '../src/workbench/controller.ts'
describe('remote command validation', () => {
  it('rejects malformed payloads instead of checking only the type', () => { expect(isWorkbenchCommand({ type: 'submit' })).toBe(false); expect(isWorkbenchCommand({ type: 'moveQueuedInput', id: 'a', targetIndex: -1 })).toBe(false); expect(isWorkbenchCommand({ type: 'writeTerminal', id: 't', data: 'x'.repeat(8_193) })).toBe(false); expect(isWorkbenchCommand({ type: 'switchWorkspace', path: '/tmp' })).toBe(false); expect(isWorkbenchCommand({ type: 'submit', text: 'safe' })).toBe(true) })
  it('validates image size and embedded preview metadata against the actual base64 payload', () => {
    const data = 'aGVsbG8='
    const image = { id: 'image-1', type: 'image', data, mimeType: 'image/png', previewPath: `data:image/png;base64,${data}`, fileName: 'hello.png', size: 5 }
    expect(isWorkbenchCommand({ type: 'addEditorImage', image })).toBe(true)
    expect(isWorkbenchCommand({ type: 'addEditorImage', image: { ...image, size: 1 } })).toBe(false)
    expect(isWorkbenchCommand({ type: 'addEditorImage', image: { ...image, previewPath: `data:text/html;base64,${data}` } })).toBe(false)
    expect(isWorkbenchCommand({ type: 'addEditorImage', image: { ...image, mimeType: 'image/png;base64,text/html' } })).toBe(false)
    expect(isWorkbenchCommand({ type: 'addEditorImage', image: { ...image, headerData: 'x'.repeat(1_000_000) } })).toBe(false)
  })
  it('omits images using serialized data bytes and does not retain an embedded preview copy', () => {
    const data = 'A'.repeat(SNAPSHOT_IMAGE_LIMIT_BYTES + 4)
    const state = createInitialState('/workspace')
    state.editorImages = [{ id: 'image-1', type: 'image', data, mimeType: 'image/png', previewPath: `data:image/png;base64,${data}`, fileName: 'large.png', size: 1 }]
    const [image] = serializeSnapshot(state).editorImages
    expect(image?.data).toEqual({ omitted: true, bytes: data.length })
    expect(image?.previewPath).toBeUndefined()
    expect(image?.size).toBe(1)
  })
  it('authorizes session paths against the current catalog', async () => { const state = createInitialState('/workspace'); const controller = { getSnapshot: () => state, settleThread: () => { throw new Error('must not run') } } as unknown as WorkbenchController; await expect(applyWorkbenchCommand(controller, { type: 'settleThread', path: '/outside/session.jsonl' })).rejects.toThrow(/not authorized/) })
})
