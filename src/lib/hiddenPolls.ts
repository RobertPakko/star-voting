import { useSyncExternalStore } from 'react'

/**
 * Which polls this browser keeps off the list, and nothing else knows about.
 *
 * A poll history only grows — a poll cannot be left, an invite cannot be
 * declined, and nothing leaves the list until the six-month sweep takes it (see
 * [Polls are deleted after six months](../../AGENTS.md#polls-are-deleted-after-six-months))
 * — so the list a reader comes back to is every poll they were ever in, settled
 * ones included. Hiding is the reader's own housekeeping over that: the poll is
 * still theirs, still readable at its own address, still counted, just not in
 * the way.
 *
 * **It is stored here and sent nowhere.** Nothing about it belongs in the
 * database: hiding a poll changes nothing about the poll, tells the creator
 * nothing, and is not a permission — a hidden poll is one this reader has read
 * enough of, which is a fact about a screen rather than about an election. It
 * is also the one kind of state that must never be mistaken for having left a
 * poll, and a column on a shared row is exactly how that mistake gets made.
 * So it goes where the ballot order, the remembered name and the sign-in
 * choice already live: `localStorage`, per browser, under one key.
 *
 * Per browser therefore, not per account — the same trade the rest of
 * `src/lib` makes. A reader who hides a poll on their laptop still sees it on
 * their phone. The alternative is a table, and a table is a disclosure.
 *
 * **Ids, not rows.** What is kept is a set of poll ids, so nothing here can go
 * stale in a way that matters: a poll renamed, voted in or closed is the same
 * id, and a hidden poll that has since been deleted is an id matching nothing,
 * which costs a few bytes and draws nothing. See `pruneHiddenPolls` for the one
 * case where those can be swept up honestly.
 */

const STORAGE_KEY = 'star-voting:hidden-polls'

/**
 * The empty set, as one object rather than a fresh one each time.
 *
 * `useSyncExternalStore` compares snapshots by identity and re-renders when
 * they differ, so a getter handing back a new empty `Set` on every call is an
 * infinite render loop rather than a tidier line.
 */
const NONE: ReadonlySet<string> = new Set()

/**
 * The current set, held at module scope because that is what a snapshot has to
 * be: one value React can read during render and compare against the last one.
 * Replaced whole on every change rather than mutated, for the same reason.
 *
 * When `localStorage` refuses — private browsing, storage disabled — this is
 * still the set the page draws from; only the writing is lost. Hiding a poll
 * then works for as long as the tab is open, which is the same bargain
 * `ballotOrder` and `voterName` strike.
 */
let hidden = readStored()

const subscribers = new Set<() => void>()

function announce() {
  for (const notify of subscribers) notify()
}

/**
 * What is in storage, defensively. A key holding anything but an array of
 * strings is read as nothing hidden rather than allowed to throw on a page
 * whose only job is to list polls — it is one reader's own storage, which a
 * different version of this app, an extension, or a hand in a console can all
 * have written.
 */
function readStored(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return NONE
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return NONE
    const ids = parsed.filter((id): id is string => typeof id === 'string')
    return ids.length > 0 ? new Set(ids) : NONE
  } catch {
    return NONE
  }
}

/** Takes the new set as the current one, records it, and says so. */
function keep(next: ReadonlySet<string>) {
  hidden = next.size > 0 ? next : NONE
  try {
    // Removed rather than stored as `[]`: a reader who unhides everything is
    // back where they started, and should leave nothing behind.
    if (hidden.size === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden]))
  } catch {
    // Nothing lost that this tab can see; see the note on `hidden` above.
  }
  announce()
}

// Another tab of the same browser is the same reader making the same decision,
// so a poll hidden in one is hidden in the other. `storage` fires only in the
// *other* tabs, which is exactly right: this one already has the new set.
//
// A null key is the whole origin being cleared, which includes this one.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return
    hidden = readStored()
    announce()
  })
}

function subscribe(notify: () => void) {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

/** The ids this browser is keeping off the list, live. */
export function useHiddenPolls(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => hidden,
    // The server snapshot, which this app never renders; see installPrompt.ts
    // for the same line and the same reason.
    () => NONE,
  )
}

/**
 * Hides a poll, or brings it back. Both directions in one function because
 * this is one control that toggles, and two exports would be two places for
 * the key to be got wrong.
 */
export function setPollHidden(id: string, hide: boolean): void {
  if (hidden.has(id) === hide) return
  const next = new Set(hidden)
  if (hide) next.add(id)
  else next.delete(id)
  keep(next)
}

/**
 * Forgets hidden ids that are not in `alive`.
 *
 * **Only sound when `alive` is the reader's whole list**, which is why the
 * caller decides rather than this: the list is paged in the database, so a
 * hidden id missing from the page on screen is nearly always a hidden poll on
 * another page, and sweeping on that would quietly unhide half of them. A page
 * that is the whole list — the total says so — is the one read that can tell
 * a deleted poll from an absent one.
 *
 * Nothing depends on it. A stale id hides nothing and breaks nothing, and the
 * button that offers to show hidden polls deliberately carries no number for
 * one to inflate. What it can still do is leave that button on screen with
 * nothing behind it, which is the one place a reader would meet a poll that is
 * no longer there.
 */
export function pruneHiddenPolls(alive: Iterable<string>): void {
  if (hidden.size === 0) return
  const live = new Set(alive)
  const next = new Set<string>()
  for (const id of hidden) {
    if (live.has(id)) next.add(id)
  }
  if (next.size === hidden.size) return
  keep(next)
}
