/** @jsxImportSource react */
// DOM renderers for gpuix's markdown, code, and diff intrinsics. They take the same props (source/theme/code/patch) and
// paint with the theme's metrics so text sits on the same grid as the desktop.

import React, { forwardRef, useMemo, useState, type CSSProperties } from 'react'
import type { EventPayload, StyleDesc } from '@gpuix/react'
import { toCss } from './style.ts'
import { plainPayload } from './events.ts'
import { parseMarkdownBlocks, type BlockNode, type InlineNode } from '../web/markdown-blocks.ts'
import { markdownSourceWithNewlines } from '../ui/markdown-source.ts'

type AnyProps = Record<string, unknown>

interface ThemeLike {
  text?: string; textMuted?: string; textFaint?: string; accent?: string; codeText?: string; codeWash?: string; border?: string
  diffAdd?: string; diffDel?: string; diffHunkBg?: string; fontSans?: string; fontMono?: string
  metrics?: Record<string, number | number[]>
}

function themeVars(theme: ThemeLike | undefined): CSSProperties {
  const m = theme?.metrics ?? {}
  const n = (key: string, fallback: number) => `${typeof m[key] === 'number' ? m[key] : fallback}px`
  const vars: Record<string, string> = {
    '--md-text-size': n('mdTextSize', 14),
    '--md-line-height': n('mdLineHeight', 22),
    '--md-block-gap': n('mdBlockGap', 12),
    '--md-code-radius': n('mdCodeRadius', 9),
    '--md-code-px': n('mdCodePaddingX', 12),
    '--md-code-py': n('mdCodePaddingY', 10),
    '--code-text-size': n('codeTextSize', 12),
    '--code-line-height': n('codeLineHeight', 19),
    '--diff-text-size': n('diffTextSize', 12),
    '--diff-line-height': n('diffLineHeight', 19),
  }
  if (theme?.text) vars['--md-text'] = theme.text
  if (theme?.textMuted) vars['--md-muted'] = theme.textMuted
  if (theme?.codeText) vars['--md-code-text'] = theme.codeText
  if (theme?.codeWash) vars['--md-code-wash'] = theme.codeWash
  if (theme?.accent) vars['--md-accent'] = theme.accent
  if (theme?.border) vars['--md-border'] = theme.border
  if (theme?.diffAdd) vars['--md-diff-add'] = theme.diffAdd
  if (theme?.diffDel) vars['--md-diff-del'] = theme.diffDel
  if (theme?.diffHunkBg) vars['--md-diff-hunk'] = theme.diffHunkBg
  if (theme?.fontSans) vars['--md-font-sans'] = fontStack(theme.fontSans)
  if (theme?.fontMono) vars['--md-font-mono'] = fontStack(theme.fontMono, true)
  return vars as CSSProperties
}

// '.SystemUIFont' is gpuix's alias for the platform UI face; the browser equivalent is the system-ui stack.
export function fontStack(family: string, mono = false): string {
  if (family === '.SystemUIFont') return '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif'
  const quoted = /[\s"']/.test(family) ? `"${family.replace(/"/g, '')}"` : family
  return mono ? `${quoted}, ui-monospace, "SF Mono", Menlo, Consolas, monospace` : `${quoted}, -apple-system, system-ui, sans-serif`
}

function Blocks({ blocks }: { blocks: BlockNode[] }) {
  return <>{blocks.map((block, index) => <Block key={index} block={block} />)}</>
}

function Block({ block }: { block: BlockNode }) {
  switch (block.kind) {
    case 'paragraph': return <p><Inline nodes={block.children} /></p>
    case 'heading': return React.createElement(`h${Math.min(6, block.level + 2)}`, { className: `gx-md-h${block.level}` }, <Inline nodes={block.children} />)
    case 'code': return <CodeBlock text={block.text} language={block.language} />
    case 'quote': return <blockquote><Blocks blocks={block.children} /></blockquote>
    case 'rule': return <hr />
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}><ListItem blocks={item} /></li>)
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>
    }
    case 'table': return (
      <div className="gx-md-table">
        <table>
          <thead><tr>{block.header.map((cell, index) => <th key={index}><Inline nodes={cell} /></th>)}</tr></thead>
          <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}><Inline nodes={cell} /></td>)}</tr>)}</tbody>
        </table>
      </div>
    )
  }
}

// Fenced code carries a header with the language and a copy action, like gpuix markdown/render.rs.
function CodeBlock({ text, language }: { text: string; language?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="gx-md-code">
      <div className="gx-md-code-header">
        <span>{language || 'text'}</span>
        <button type="button" className="gx-md-copy" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }) }}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre><code>{text}</code></pre>
    </div>
  )
}

function ListItem({ blocks }: { blocks: BlockNode[] }) {
  if (blocks.length === 1 && blocks[0]!.kind === 'paragraph') return <Inline nodes={blocks[0]!.children} />
  return <Blocks blocks={blocks} />
}

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return <>{nodes.map((node, index) => <InlineItem key={index} node={node} />)}</>
}

function InlineItem({ node }: { node: InlineNode }) {
  switch (node.kind) {
    case 'text': return <>{node.text}</>
    case 'code': return <code>{node.text}</code>
    case 'strong': return <strong><Inline nodes={node.children} /></strong>
    case 'em': return <em><Inline nodes={node.children} /></em>
    case 'strike': return <s><Inline nodes={node.children} /></s>
    case 'break': return <br />
    case 'link': return <a href={node.href} data-gx-link="">{<Inline nodes={node.children} />}</a>
  }
}

export const DomMarkdown = forwardRef(function DomMarkdown(props: AnyProps, ref: React.ForwardedRef<HTMLDivElement>) {
  const source = String(props.source ?? '')
  const blocks = useMemo(() => parseMarkdownBlocks(markdownSourceWithNewlines(source)), [source])
  const onLink = props.onLinkClick as ((event: EventPayload) => void) | undefined
  return (
    <div
      ref={ref}
      className="gx-markdown"
      data-testid={props.testId as string | undefined}
      style={{ ...themeVars(props.theme as ThemeLike | undefined), ...toCss(props.style as StyleDesc) }}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest('a[data-gx-link]') as HTMLAnchorElement | null
        if (!anchor) return
        event.preventDefault()
        if (onLink) onLink(plainPayload(0, 'linkClick', { value: anchor.getAttribute('href') ?? '' }))
        else window.open(anchor.href, '_blank', 'noopener,noreferrer')
      }}
    >
      <Blocks blocks={blocks} />
    </div>
  )
})

export const DomCode = forwardRef(function DomCode(props: AnyProps, ref: React.ForwardedRef<HTMLDivElement>) {
  const code = String(props.code ?? '')
  const lines = useMemo(() => code.split('\n'), [code])
  const numbers = Boolean(props.showLineNumbers)
  return (
    <div ref={ref} className="gx-code" data-testid={props.testId as string | undefined} data-language={String(props.language ?? '')} style={{ ...themeVars(props.theme as ThemeLike | undefined), ...toCss(props.style as StyleDesc) }}>
      <pre>{lines.map((line, index) => (
        <span key={index} className="gx-code-line">{numbers ? <span className="gx-code-ln">{index + 1}</span> : null}{line}{'\n'}</span>
      ))}</pre>
    </div>
  )
})

interface DiffFile { path: string; lines: Array<{ kind: 'add' | 'del' | 'hunk' | 'ctx' | 'meta'; text: string; oldLine?: number; newLine?: number }> }

export function parseDomDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | undefined
  let oldLine = 0
  let newLine = 0
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = /b\/(.+)$/.exec(raw)
      current = { path: match?.[1] ?? raw.slice(11), lines: [] }
      files.push(current)
      continue
    }
    if (!current) {
      if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue
      current = { path: '', lines: [] }
      files.push(current)
    }
    if (raw.startsWith('+++ ')) { if (!current.path) current.path = raw.slice(4).replace(/^b\//, ''); continue }
    if (raw.startsWith('--- ') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ')) { current.lines.push({ kind: 'meta', text: raw }); continue }
    if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw)
      oldLine = Number(m?.[1] ?? 0); newLine = Number(m?.[2] ?? 0)
      current.lines.push({ kind: 'hunk', text: raw })
      continue
    }
    if (raw.startsWith('+')) { current.lines.push({ kind: 'add', text: raw.slice(1), newLine }); newLine++; continue }
    if (raw.startsWith('-')) { current.lines.push({ kind: 'del', text: raw.slice(1), oldLine }); oldLine++; continue }
    if (raw.startsWith('\\')) continue
    current.lines.push({ kind: 'ctx', text: raw.slice(1), oldLine, newLine }); oldLine++; newLine++
  }
  return files.filter((file) => file.lines.length > 0)
}

export const DomDiff = forwardRef(function DomDiff(props: AnyProps, ref: React.ForwardedRef<HTMLDivElement>) {
  const patch = String(props.patch ?? '')
  const files = useMemo(() => parseDomDiff(patch), [patch])
  const collapsed = new Set((props.collapsedPaths as string[] | undefined) ?? [])
  const maxLines = typeof props.maxLines === 'number' ? props.maxLines : Infinity
  const onToggle = props.onToggleFile as ((event: EventPayload) => void) | undefined
  const onShowMore = props.onShowMore as ((event: EventPayload) => void) | undefined
  const onLine = props.onLineClick as ((event: EventPayload) => void) | undefined
  let budget = maxLines
  let remaining = 0
  const rendered = files.map((file) => {
    const isCollapsed = collapsed.has(file.path)
    const shown = isCollapsed ? [] : file.lines.slice(0, Math.max(0, budget))
    remaining += isCollapsed ? 0 : file.lines.length - shown.length
    budget -= shown.length
    return (
      <div key={file.path} className="gx-diff-file">
        {file.path ? <div className="gx-diff-header" onClick={() => onToggle?.(plainPayload(0, 'toggleFile', { value: file.path }))}><span className="gx-diff-chev">{isCollapsed ? '▸' : '▾'}</span>{file.path}</div> : null}
        {shown.map((line, index) => (
          <div key={index} className={`gx-diff-line gx-diff-${line.kind}`} onClick={() => onLine?.(plainPayload(0, 'lineClick', { oldLine: line.oldLine, newLine: line.newLine, value: file.path }))}>
            {line.kind === 'add' || line.kind === 'del' || line.kind === 'ctx' ? <span className="gx-diff-gutter">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span> : null}
            <span className="gx-diff-text">{line.text || ' '}</span>
          </div>
        ))}
      </div>
    )
  })
  return (
    <div ref={ref} className={props.wordDiff ? 'gx-diff gx-diff-word' : 'gx-diff'} data-testid={props.testId as string | undefined} style={{ ...themeVars(props.theme as ThemeLike | undefined), ...toCss(props.style as StyleDesc) }}>
      {rendered}
      {remaining > 0 ? <button type="button" className="gx-diff-more" onClick={() => onShowMore?.(plainPayload(0, 'showMore', { value: String(remaining) }))}>Show {remaining} more lines</button> : null}
    </div>
  )
})
