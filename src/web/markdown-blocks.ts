// Dependency-free Markdown block parser for the web client. The desktop app renders Markdown natively through GPUix;
// the browser needs real HTML for the same source. Coverage is what agent transcripts actually contain: paragraphs,
// ATX headings, fenced code, block quotes, ordered and bullet lists, pipe tables, thematic breaks, and inline
// code/bold/italic/strike/links. Anything else falls through as a paragraph.

export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'em'; children: InlineNode[] }
  | { kind: 'strike'; children: InlineNode[] }
  | { kind: 'link'; href: string; children: InlineNode[] }
  | { kind: 'break' }

export type BlockNode =
  | { kind: 'paragraph'; children: InlineNode[] }
  | { kind: 'heading'; level: number; children: InlineNode[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'quote'; children: BlockNode[] }
  | { kind: 'list'; ordered: boolean; start: number; items: BlockNode[][] }
  | { kind: 'table'; header: InlineNode[][]; rows: InlineNode[][][] }
  | { kind: 'rule' }

const FENCE = /^(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^(\s*)([-*+])\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

export function parseMarkdownBlocks(source: string): BlockNode[] {
  return parseLines(source.replace(/\r\n?/g, '\n').split('\n'))
}

function parseLines(lines: string[]): BlockNode[] {
  const blocks: BlockNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (!line.trim()) { index += 1; continue }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]!
      const body: string[] = []
      index += 1
      while (index < lines.length && !lines[index]!.startsWith(marker)) { body.push(lines[index]!); index += 1 }
      index += 1
      blocks.push({ kind: 'code', language: fence[2] ?? '', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, children: parseInline(heading[2] ?? '') })
      index += 1
      continue
    }

    if (RULE.test(line)) { blocks.push({ kind: 'rule' }); index += 1; continue }

    if (line.trimStart().startsWith('>')) {
      const body: string[] = []
      while (index < lines.length && lines[index]!.trimStart().startsWith('>')) {
        body.push(lines[index]!.trimStart().replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push({ kind: 'quote', children: parseLines(body) })
      continue
    }

    if (isTableStart(lines, index)) {
      const header = splitRow(line)
      const rows: InlineNode[][][] = []
      index += 2
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) {
        rows.push(splitRow(lines[index]!))
        index += 1
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered)
      const indent = (bullet ?? ordered)![1]!.length
      const start = ordered ? Number(ordered[2]) : 1
      const items: BlockNode[][] = []
      while (index < lines.length) {
        const current = lines[index]!
        const match = isOrdered ? ORDERED.exec(current) : BULLET.exec(current)
        if (!match || match[1]!.length !== indent) break
        const itemLines = [match[3] ?? '']
        index += 1
        // Continuation lines belong to the item while they are indented deeper than the marker or are blank
        // followed by an indented line.
        while (index < lines.length) {
          const next = lines[index]!
          const nextIndent = next.length - next.trimStart().length
          if (next.trim() && nextIndent > indent) { itemLines.push(next.slice(indent + 2)); index += 1; continue }
          if (!next.trim() && index + 1 < lines.length) {
            const after = lines[index + 1]!
            const afterIndent = after.length - after.trimStart().length
            if (after.trim() && afterIndent > indent) { itemLines.push(''); index += 1; continue }
          }
          break
        }
        items.push(parseLines(itemLines))
      }
      blocks.push({ kind: 'list', ordered: isOrdered, start, items })
      continue
    }

    const paragraph: string[] = [line]
    index += 1
    while (index < lines.length) {
      const next = lines[index]!
      if (!next.trim() || FENCE.test(next) || HEADING.test(next) || RULE.test(next) || BULLET.test(next) || ORDERED.test(next) || next.trimStart().startsWith('>') || isTableStart(lines, index)) break
      paragraph.push(next)
      index += 1
    }
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) })
  }
  return blocks
}

function isTableStart(lines: string[], index: number): boolean {
  const line = lines[index]
  const divider = lines[index + 1]
  return Boolean(line && divider && line.includes('|') && TABLE_DIVIDER.test(divider))
}

function splitRow(line: string): InlineNode[][] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (const character of trimmed) {
    if (escaped) { current += character; escaped = false; continue }
    if (character === '\\') { escaped = true; continue }
    if (character === '|') { cells.push(current); current = ''; continue }
    current += character
  }
  cells.push(current)
  return cells.map((cell) => parseInline(cell.trim()))
}

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let index = 0
  let text = ''
  const flush = (): void => { if (text) { nodes.push({ kind: 'text', text }); text = '' } }
  while (index < source.length) {
    const character = source[index]!

    if (character === '\\' && index + 1 < source.length) { text += source[index + 1]; index += 2; continue }

    if (character === '`') {
      const run = source.slice(index).match(/^`+/)![0]
      const close = source.indexOf(run, index + run.length)
      if (close > index) {
        flush()
        nodes.push({ kind: 'code', text: source.slice(index + run.length, close).replace(/^ (.+) $/, '$1') })
        index = close + run.length
        continue
      }
    }

    if (character === '\n') { flush(); nodes.push({ kind: 'break' }); index += 1; continue }

    if (character === '[') {
      const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(source.slice(index))
      if (link) {
        flush()
        nodes.push({ kind: 'link', href: link[2]!, children: parseInline(link[1] ?? '') })
        index += link[0].length
        continue
      }
    }

    const url = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(source.slice(index))
    if (url && (index === 0 || /[\s(]/.test(source[index - 1]!))) {
      flush()
      nodes.push({ kind: 'link', href: url[0], children: [{ kind: 'text', text: url[0] }] })
      index += url[0].length
      continue
    }

    const wrapped = delimited(source, index)
    if (wrapped) {
      flush()
      nodes.push({ kind: wrapped.kind, children: parseInline(wrapped.inner) })
      index = wrapped.end
      continue
    }

    text += character
    index += 1
  }
  flush()
  return nodes
}

function delimited(source: string, index: number): { kind: 'strong' | 'em' | 'strike'; inner: string; end: number } | undefined {
  for (const [marker, kind] of [['**', 'strong'], ['__', 'strong'], ['~~', 'strike'], ['*', 'em'], ['_', 'em']] as const) {
    if (!source.startsWith(marker, index)) continue
    const after = source[index + marker.length]
    if (!after || after === ' ' || after === marker[0]) continue
    // Underscore emphasis must not open inside a word (snake_case identifiers).
    if (marker[0] === '_' && index > 0 && /\w/.test(source[index - 1]!)) continue
    let cursor = index + marker.length
    while (cursor < source.length) {
      const close = source.indexOf(marker, cursor)
      if (close < 0) break
      const before = source[close - 1]
      const afterClose = source[close + marker.length]
      const wordAfter = marker[0] === '_' && afterClose !== undefined && /\w/.test(afterClose)
      if (before !== ' ' && close > index + marker.length && !wordAfter) {
        return { kind, inner: source.slice(index + marker.length, close), end: close + marker.length }
      }
      cursor = close + marker.length
    }
  }
  return undefined
}
