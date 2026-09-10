import { canStoreShellResponse, isPublicShellRequest, ownedWebCacheName, staleOwnedWebCaches } from './sw-policy.ts'
interface WorkerScope { location: Location; skipWaiting(): Promise<void>; clients: { claim(): Promise<void> }; addEventListener(type: 'install' | 'activate', listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void): void; addEventListener(type: 'fetch', listener: (event: { request: Request; respondWith(response: Promise<Response> | Response): void }) => void): void }
declare const __HEDDLEWORK_BUILD_HASH__: string
declare const __HEDDLEWORK_PRECACHE__: string[]
const worker = self as unknown as WorkerScope
const CACHE = ownedWebCacheName(__HEDDLEWORK_BUILD_HASH__)
const PRECACHE = __HEDDLEWORK_PRECACHE__
worker.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => worker.skipWaiting())) })
worker.addEventListener('activate', (event) => { event.waitUntil((async () => { const keys = await caches.keys(); await Promise.all(staleOwnedWebCaches(keys, CACHE).map((key) => caches.delete(key))); await worker.clients.claim() })()) })
worker.addEventListener('fetch', (event) => {
  const request = event.request
  if (!isPublicShellRequest(request, PRECACHE, worker.location.origin)) return
  const url = new URL(request.url)
  if (request.mode === 'navigate') { event.respondWith(networkFirst(request, '/index.html')); return }
  event.respondWith(cacheFirst(request, url.pathname))
})
async function networkFirst(request: Request, cacheKey: string): Promise<Response> { try { const response = await fetch(request); if (canStoreShellResponse(response)) { const cache = await caches.open(CACHE); await cache.put(cacheKey, response.clone()) }; return response } catch { const cached = await caches.match(cacheKey); if (cached) return cached; throw new Error('Offline and no cached app shell') } }
async function cacheFirst(request: Request, cacheKey: string): Promise<Response> { const cached = await caches.match(cacheKey); if (cached) return cached; const response = await fetch(request); if (canStoreShellResponse(response)) { const cache = await caches.open(CACHE); await cache.put(cacheKey, response.clone()) }; return response }
