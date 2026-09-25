// In-app navigation targets. Shared because the tray, notifications and deep
// links (main process) can navigate the renderer too.

export type SettingsSection =
  | 'preferences'
  | 'profile'
  | 'calendar'
  | 'notifications'
  | 'connectors'
  | 'help'
  | 'general'
  | 'members'
  | 'spaces'
  | 'analytics'
  | 'billing'
  | 'referrals'

export type Route =
  | { name: 'home' }
  | { name: 'shared' }
  | { name: 'chat'; threadId?: string }
  | { name: 'note'; id: string }
  | { name: 'space'; space: 'private' | 'workspace' }
  | { name: 'folder'; id: string }
  | { name: 'people' }
  | { name: 'person'; email: string }
  | { name: 'companies' }
  | { name: 'company'; domain: string }
  | { name: 'recipes' }
  | { name: 'settings'; section: SettingsSection }

export const DEEP_LINK_SCHEME = 'granola-clone'

/** `granola-clone://note/<id>` → route. Returns null for anything unrecognised. */
export function parseDeepLink(url: string): Route | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return null
  // For custom schemes WHATWG URL puts the first segment in `host`.
  const [kind, id] = [parsed.host, parsed.pathname.replace(/^\//, '')]
  if (kind === 'note' && /^[\w-]+$/.test(id)) return { name: 'note', id }
  return null
}

export const noteLink = (id: string): string => `${DEEP_LINK_SCHEME}://note/${id}`
