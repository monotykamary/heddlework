import { useSyncExternalStore } from 'react'
import { WorkspaceClient, type WorkspaceClientView } from './client.ts'
export { readConnectionSettings, workspaceSocketUrl, WorkspaceClient } from './client.ts'
export type { WorkspaceClientView, WorkspaceClientStatus } from './client.ts'
const client = new WorkspaceClient()
export function workspaceClient(): WorkspaceClient { return client }
export function useWorkspace(): WorkspaceClientView { return useSyncExternalStore(client.subscribe.bind(client), client.getSnapshot.bind(client), client.getSnapshot.bind(client)) }
