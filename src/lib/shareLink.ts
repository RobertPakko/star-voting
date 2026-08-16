import type { Poll } from './types'

/**
 * The app is served under a base path and routes off the hash, so the app
 * root is origin + pathname with the hash dropped.
 */
function appRoot(): string {
  return window.location.origin + window.location.pathname
}

/**
 * Open polls link to the tokenized public route — that link IS the
 * capability. Invite polls link to the ordinary poll page: the recipient
 * still has to sign in and still has to be on the invite list, so the link
 * is a convenience, not access.
 */
export function shareLinkFor(poll: Pick<Poll, 'id' | 'mode' | 'public_token'>): string {
  if (poll.mode === 'open' && poll.public_token) {
    return `${appRoot()}#/p/${poll.public_token}`
  }
  return `${appRoot()}#/polls/${poll.id}`
}

/**
 * Where to send someone after they sign in. Stashed before the magic link
 * goes out, because the auth redirect lands on the app root with no hash,
 * which would otherwise drop an invitee who followed a share link straight
 * back to the poll list.
 */
const PENDING_KEY = 'star-voting:after-sign-in'
const PENDING_TTL_MS = 60 * 60 * 1000

export function rememberDestination(path: string) {
  if (!path || path === '/') return
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ path, at: Date.now() }))
  } catch {
    // Nothing to do — the user just lands on the poll list instead.
  }
}

export function takeDestination(): string | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw) return null
    localStorage.removeItem(PENDING_KEY)
    const { path, at } = JSON.parse(raw) as { path?: string; at?: number }
    if (!path || typeof at !== 'number') return null
    // A stale entry shouldn't hijack an unrelated sign-in weeks later.
    if (Date.now() - at > PENDING_TTL_MS) return null
    return path
  } catch {
    return null
  }
}
