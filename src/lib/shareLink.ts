import type { Poll } from './types'

/**
 * The app is served under a base path and routes off the hash, so the app
 * root is origin + pathname with the hash dropped.
 */
function appRoot(): string {
  return window.location.origin + window.location.pathname
}

/**
 * One address per poll, whoever is reading it.
 *
 * There used to be two: open polls lived at `#/p/<share token>` and invite
 * polls at `#/polls/<id>`, so an open poll's creator was looking at an
 * address that was not the one to hand out -- copying what was in front of
 * them sent the recipient to a sign-in screen and then to "poll not found".
 * The share token is gone and a poll's id is its link, so this is the same
 * string for both modes and for both sides of the poll.
 *
 * What the link grants still differs sharply, and that is a fact about the
 * poll rather than about the URL: an open poll's link is the capability, and
 * an invite poll's is a convenience, since the recipient must still sign in
 * and still be on the list. `ShareLink` says which in so many words.
 */
export function shareLinkFor(poll: Pick<Poll, 'id'>): string {
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
    // Nothing to do; the user just lands on the poll list instead.
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
