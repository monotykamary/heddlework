/** @jsxImportSource react */
import React, { useState } from 'react'
import { colors } from '../ui/theme.ts'
import { normalizeHostUrl } from './client.ts'
import { workspaceClient } from './store.ts'

export function ConnectPage({ onConnected }: { onConnected(): void }) {
  const [host, setHost] = useState(location.origin)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string>()
  const connect = (event: React.FormEvent) => {
    event.preventDefault()
    try {
      const normalized = normalizeHostUrl(host)
      workspaceClient().connect(normalized, token.trim())
      localStorage.setItem('heddlework.host', normalized)
      sessionStorage.setItem('heddlework.token', token.trim())
      setError(undefined); onConnected()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <main className="connect-page"><form className="connect-shell" onSubmit={connect}><p className="connect-kicker">Heddlework remote</p><h1 className="connect-title">Connect to your workbench</h1><p className="connect-lead">Remote access stays off until you start a host. Enter its address and pairing token.</p><label className="connect-label">Host<input className="connect-input connect-input-single" value={host} onChange={(event) => setHost((event.target as HTMLInputElement).value)} autoCapitalize="none" autoCorrect="off" inputMode="url" /></label><label className="connect-label">Pairing token<input className="connect-input connect-input-single" type="password" value={token} onChange={(event) => setToken((event.target as HTMLInputElement).value)} autoCapitalize="none" autoCorrect="off" /></label>{error ? <p className="connect-error">{error}</p> : null}<button className="connect-submit" type="submit">Connect</button><p className="connect-security" style={{ color: colors.textFaint }}>The token is kept only for this browser tab.</p></form></main>
}
