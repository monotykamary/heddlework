import '../dom/process-shim.ts'
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { installCreateElementBridge } from '../dom/host.tsx'
import { ConnectPage } from './connect-page.tsx'
import { readConnectionSettings, workspaceClient } from './store.ts'
import { WebWorkbench } from './workbench.tsx'

installCreateElementBridge()
const settings = readConnectionSettings(location.search, sessionStorage, location.origin, location.hash)
const hasCredentials = Boolean(settings.host && settings.token)
if (hasCredentials) {
  localStorage.setItem('heddlework.host', settings.host)
  sessionStorage.setItem('heddlework.token', settings.token)
  workspaceClient().connect(settings.host, settings.token)
}
stripPairingParameters()
function Root() { const [connected, setConnected] = useState(hasCredentials); return connected ? <WebWorkbench /> : <ConnectPage onConnected={() => setConnected(true)} /> }
if ('serviceWorker' in navigator && (location.protocol === 'https:' || (location.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(location.hostname)))) void navigator.serviceWorker.register('/sw.js')
const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(<Root />)
function stripPairingParameters(): void { const url = new URL(location.href); const fragment = new URLSearchParams(url.hash.replace(/^#/, '')); const paired = url.searchParams.has('token') || url.searchParams.has('host') || fragment.has('token') || fragment.has('host'); if (!paired) return; url.searchParams.delete('token'); url.searchParams.delete('host'); fragment.delete('token'); fragment.delete('host'); url.hash = fragment.toString(); history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`) }
