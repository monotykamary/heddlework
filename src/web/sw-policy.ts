export const WEB_CACHE_PREFIX = 'heddlework-shell-'
export function ownedWebCacheName(hash: string): string { return WEB_CACHE_PREFIX + hash }
export function staleOwnedWebCaches(keys: readonly string[], current: string): string[] { return keys.filter((key) => key.startsWith(WEB_CACHE_PREFIX) && key !== current) }
export function isPrivateWebPath(pathname: string): boolean { return pathname === '/ws' || pathname === '/health' || pathname.startsWith('/api/') }
export function isPublicShellRequest(request: Request, precache: readonly string[], origin: string): boolean {
  if (request.method !== 'GET') return false
  const url = new URL(request.url)
  if (url.origin !== origin || isPrivateWebPath(url.pathname) || url.searchParams.has('token') || url.searchParams.has('host')) return false
  if (request.mode === 'navigate') return true
  return url.search === '' && precache.includes(url.pathname)
}
export function canStoreShellResponse(response: Response): boolean { return response.ok && (response.type === 'basic' || response.type === 'default') && !response.headers.has('set-cookie') }
