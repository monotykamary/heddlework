// Minimal node:path for the browser: src/ui only needs resolve/join/basename/dirname on POSIX-style paths.

function normalizeSegments(path: string): string {
  const absolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split(/[\\/]+/)) {
    if (!part || part === '.') continue
    if (part === '..') { parts.pop(); continue }
    parts.push(part)
  }
  return (absolute ? '/' : '') + parts.join('/')
}

export function resolve(...paths: string[]): string {
  let joined = ''
  for (const path of paths) joined = path.startsWith('/') || /^[A-Za-z]:/.test(path) ? path : joined ? `${joined}/${path}` : path
  return normalizeSegments(joined) || '/'
}
export function join(...paths: string[]): string { return normalizeSegments(paths.filter(Boolean).join('/')) }
export function basename(path: string, ext?: string): string {
  const base = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base
}
export function dirname(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? (index === 0 ? '/' : '.') : trimmed.slice(0, index)
}
export function normalize(path: string): string { return normalizeSegments(path) }
export const sep = '/'
export const delimiter = ':'
export function extname(path: string): string {
  const base = basename(path)
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index) : ''
}
export function isAbsolute(path: string): boolean { return path.startsWith('/') || /^[A-Za-z]:/.test(path) }
export function relative(from: string, to: string): string {
  const a = normalizeSegments(from).split('/').filter(Boolean)
  const b = normalizeSegments(to).split('/').filter(Boolean)
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1
  return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/')
}
export default { resolve, join, basename, dirname, normalize, sep, delimiter, extname, isAbsolute, relative }
