import { isCanonicalPollId } from './pollId'

/**
 * The open polls this browser has opened through their links, so the poll
 * list can carry them.
 *
 * `list_polls` knows two ways a poll belongs to somebody: they made it, or
 * they are on its invite list. An open poll somebody else made is neither,
 * however many times its link has been opened here, so the only way back to
 * one was the link it came by — and a link lives in a chat that scrolls, an
 * email, a QR code on a projector that has since been switched off. This is
 * the third way onto the list, and it is the browser's to answer.
 *
 * **Stored here, not in the database, and that is the whole design.** An open
 * poll has no idea who has read it: a ballot cast through a link carries a
 * per-question `voter_key` precisely so that one browser's ballots cannot be
 * joined, and a row recording "this account opened that poll" would be the
 * join, made on the server, about every open poll anybody signed in has ever
 * looked at. Kept here it is a fact about one browser that leaves it only as
 * the argument to the list's own read — see `list_polls`'s `p_open_ids`,
 * which answers with nothing a reader holding these links could not already
 * have asked `open_poll_view` for.
 *
 * So it is per browser rather than per account, on the same terms as hidden
 * polls, the ballot order and the remembered name: a poll opened on the phone
 * is not on the laptop's list, and a poll opened before signing in is on the
 * list of whoever signs in afterwards in the same browser. That is the trade
 * for having no table, and it is the one this app keeps making.
 *
 * **Recorded by the first question's id.** A poll of several questions is one
 * row on the list and that row is its first question, whichever of them the
 * link happened to open — so the id kept is the one the list will answer with,
 * which is also what lets `pruneOpenedPolls` compare the two directly.
 *
 * **Each id carries the poll's creation date.** The
 * list watches the opened polls on the page in front of the reader, and has to
 * be subscribed to them *before* the read that draws the page — a topic joined
 * after a read leaves a gap in which a vote goes unannounced. It cannot ask the
 * page which polls are on it without reading it, but it can work it out: the
 * list is ordered newest first, so the opened polls on page one are among the
 * ten newest opened polls, and those on any later page are among the ten
 * newest older than the page before it ended. That needs the dates, which
 * `open_poll_view` carries for exactly this (0067_open_poll_view_says_when.sql)
 * and `PublicPoll` records beside the id. See `openedCandidates`, and
 * `PollList` for what it does when the guess is wrong.
 */

const STORAGE_KEY = 'star-voting:opened-polls'

/**
 * How many are kept, newest-opened first. Every one is handed to the database
 * on every read of the list, so this bounds a request body rather than how
 * much anybody cares about; the oldest drop off the end the way they would
 * drop off the bottom of a feed. It is not a channel count — the list watches
 * the page's opened polls, ten at the most; see `openedCandidates`.
 */
const LIMIT = 100

/** One remembered poll: its id, and when it was created where that is known. */
interface Opened {
  id: string
  /**
   * As the database spells it. Absent only where the view that opened the
   * poll did not carry one — a database from before 0067, or storage written
   * by a build from before the dates.
   */
  created_at?: string
}

/** Where a page of the list ends: the sort key of its last row. */
export interface ListCursor {
  created_at: string
  id: string
}

/**
 * What is in storage, defensively: newest-opened first, uuids only, no
 * repeats. An entry may be a bare id, which is how a build before the dates
 * wrote them.
 *
 * Only uuids, because this is handed to Postgres as a `uuid[]` and one string
 * that is not one fails the list's read entire. A sample's word could only get
 * here by a bug — `rememberOpenedPoll` refuses them — but this is storage a
 * different build, an extension or a console can have written, and the list
 * is the page a signed-in reader lands on.
 */
function readStored(): Opened[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const entries: Opened[] = []
    for (const item of parsed) {
      const id =
        typeof item === 'string'
          ? item
          : item && typeof item === 'object' && typeof item.id === 'string'
            ? item.id
            : null
      if (!id || !isCanonicalPollId(id)) continue
      const key = id.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const created = typeof item === 'object' ? item.created_at : undefined
      entries.push(typeof created === 'string' ? { id: key, created_at: created } : { id: key })
    }
    return entries.slice(0, LIMIT)
  } catch {
    return []
  }
}

/**
 * Held at module scope as well as stored, so a browser whose storage refuses
 * — private browsing, storage turned off — still lists what this tab has
 * opened for as long as the tab is open. The same bargain `hiddenPolls` makes.
 */
let opened = readStored()

function keep(next: Opened[]) {
  opened = next
  try {
    if (next.length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Nothing this tab can see is lost; see the note on `opened`.
  }
}

// Another tab is the same browser opening the same links, so what it records
// is read back here rather than overwritten by this tab's older copy on the
// next write. `storage` fires only in the other tabs; a null key is the whole
// origin being cleared.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return
    opened = readStored()
  })
}

/**
 * The open polls this browser has opened, newest-opened first, for
 * `list_polls`.
 *
 * Read when the list reads rather than watched: nothing on the list's screen
 * opens a poll, so the set cannot change while it is the page in front of
 * the reader, and the next read of the list picks up whatever changed while
 * they were away from it.
 */
export function openedPolls(): readonly string[] {
  return opened.map((entry) => entry.id)
}

/**
 * Newest first, in `list_polls`' own order: `created_at desc, id desc`.
 *
 * Compared as text, which is sound because both sides are Postgres's own JSON
 * spelling of a `timestamptz` in one session zone — `open_poll_view` for the
 * stored dates, PostgREST for the list's rows — and that orders as text. It
 * is ISO 8601 in one offset, with trailing zeros trimmed from the fraction,
 * and a trimmed fraction still sorts right: the offset's `+` sorts before the
 * fraction's `.`, which sorts before every digit, so `…:03+00:00` precedes
 * `…:03.1+00:00` precedes `…:03.12+00:00`. Parsing them into `Date` would
 * drop the microseconds, which is exactly where two polls made in one second
 * differ.
 * `37_opened_polls_on_the_list` holds the two spellings to each other.
 */
function newerFirst(a: ListCursor, b: ListCursor): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * The opened polls that can be on a page of `size` rows starting after
 * `after` — the last row of the page before, or nothing for page one.
 *
 * The list is ordered newest first and an opened poll is one of its rows, so
 * an opened poll on the page has fewer than `size` rows ahead of it past
 * `after`, and so fewer than `size` *opened* rows ahead of it. It is therefore
 * among the `size` newest dated opened polls past `after` — exact, given the
 * dates, and given `after` is still where the page before ends. A poll with no
 * date cannot be placed, so it is a candidate for every page; only as many as
 * a page could hold, since the list's check after reading (see `PollList`)
 * catches whatever this leaves out. Opening it again gives it a date.
 */
export function openedCandidates(after: ListCursor | null, size: number): string[] {
  const dated = opened
    .filter((entry): entry is Required<Opened> => entry.created_at !== undefined)
    .filter((entry) => !after || newerFirst(after, entry) < 0)
    .sort(newerFirst)
    .slice(0, size)
  const undated = opened.filter((entry) => entry.created_at === undefined).slice(0, size)
  return [...dated, ...undated].map((entry) => entry.id)
}

/**
 * Records an open poll as opened in this browser, or moves it back to the
 * front if it already was.
 *
 * `firstQuestionId` is the id the poll list knows the poll by — the poll's
 * own id when it asks one question — so pass that rather than whichever
 * question is on screen; see the note at the top of this file. `createdAt` is
 * when it was made, which every question of a group shares; left out, an
 * earlier visit's date is kept.
 */
export function rememberOpenedPoll(firstQuestionId: string, createdAt?: string): void {
  if (!isCanonicalPollId(firstQuestionId)) return
  const id = firstQuestionId.toLowerCase()
  const known = opened.find((entry) => entry.id === id)
  const created_at = createdAt ?? known?.created_at
  if (opened[0]?.id === id && known?.created_at === created_at) return
  const entry: Opened = created_at ? { id, created_at } : { id }
  keep([entry, ...opened.filter((other) => other.id !== id)].slice(0, LIMIT))
}

/**
 * Forgets remembered polls that are not in `alive`: a poll deleted by its
 * creator, or by the six-month sweep, leaves an id here that matches nothing.
 *
 * **Only sound when `alive` is the reader's whole list, read with these ids
 * handed in**, which is why the caller decides: the list is paged in the
 * database, so a remembered poll missing from the page on screen is nearly
 * always one on another page. It is `pruneHiddenPolls`' rule for the same
 * reason. Nothing breaks if it never runs — an id matching nothing lists
 * nothing — so a caller in any doubt should not call it.
 */
export function pruneOpenedPolls(alive: Iterable<string>): void {
  if (opened.length === 0) return
  const live = new Set([...alive].map((id) => id.toLowerCase()))
  const next = opened.filter((entry) => live.has(entry.id))
  if (next.length === opened.length) return
  keep(next)
}
