import { supabase } from './supabase'
import type { PollListItem } from './types'

/** Polls to a page of the list; `list_polls` is always asked for this many. */
export const PAGE_SIZE = 10

/**
 * The poll list as it was last drawn, kept for the walk back to it.
 *
 * Going back from a poll to the list used to be a fresh page: a skeleton, a
 * subscription, a read, and the reader at the top of a list they had been
 * halfway down. So the list leaves itself here — the page it was on, its rows,
 * and how far it was scrolled — and a return to it draws from this at once,
 * where it was, with the heading of the poll being left flying back onto its
 * card (lib/headingFlight.ts). The list still subscribes and reads exactly as it
 * always has, and that read replaces these rows within moments; what is kept
 * here only has to be right for the first frame, and a list is a live page
 * anyway, so it is never trusted for longer than that.
 *
 * **Only a return uses it**: the page's own back control, or the browser's
 * back button. Arriving any other way — the wordmark, a freshly created poll —
 * is somebody asking for the list as it is now, and a list drawn from memory
 * for a moment and then corrected under them is a list that jumps.
 *
 * In memory, and so for the life of the tab: nothing about another reader's
 * list may outlive the session that read it, which is also why it is filed
 * against the account.
 */
type ListSnapshot = {
  userId: string
  polls: PollListItem[]
  total: number
  removedCount: number
  page: number
  scrollY: number
}

let snapshot: ListSnapshot | null = null

export function readListSnapshot(userId: string | undefined): ListSnapshot | null {
  return userId && snapshot?.userId === userId ? snapshot : null
}

export function writeListSnapshot(next: Omit<ListSnapshot, 'scrollY'>) {
  snapshot = { ...next, scrollY: snapshot?.userId === next.userId ? snapshot.scrollY : 0 }
}

/**
 * Makes sure the way back from a poll has a list to land on: when nothing is
 * kept, or what is kept is the first page and this poll is not on it (one
 * made since, or reached by its link), page one is read now, in the
 * background, while the reader is on the poll. Without it the heading has no
 * card to fly back to, and the list arrives as a skeleton. The new copy starts
 * at the top, where a poll missing from the old one will be.
 */
export async function keepListFor(userId: string, pollId: string) {
  const held = readListSnapshot(userId)
  if (held && (held.page !== 1 || held.polls.some((poll) => poll.id === pollId))) return
  const { data, error } = await supabase.rpc('list_polls', {
    p_limit: PAGE_SIZE,
    p_offset: 0,
    p_removed: false,
  })
  const rows = (data as PollListItem[] | null) ?? []
  // Somebody else's list by now, or nothing worth keeping.
  if (error || rows.length === 0 || readListSnapshot(userId) !== held) return
  snapshot = {
    userId,
    polls: rows,
    total: rows[0].total_count,
    removedCount: rows[0].removed_count,
    page: 1,
    scrollY: 0,
  }
}

/** How far down the list was, written as the reader leaves it. */
export function writeListScroll(userId: string, scrollY: number) {
  if (snapshot?.userId === userId) snapshot = { ...snapshot, scrollY }
}
