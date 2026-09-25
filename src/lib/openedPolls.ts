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
 */

const STORAGE_KEY = 'star-voting:opened-polls'

/**
 * How many are kept, newest first. The list hands every one of them to the
 * database on every read, so this is a bound on a request body rather than on
 * how much anybody cares about: a browser that has opened more open polls than
 * this is keeping the most recent ones, and the oldest drop off the end the
 * way they would drop off the bottom of a feed.
 */
const LIMIT = 100

/**
 * What is in storage, defensively: newest first, uuids only, no repeats.
 *
 * Only uuids, because this is handed to Postgres as a `uuid[]` and one string
 * that is not one fails the list's read entire. A sample's word could only get
 * here by a bug — `rememberOpenedPoll` refuses them — but this is storage a
 * different build, an extension or a console can have written, and the list
 * is the page a signed-in reader lands on.
 */
function readStored(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const ids = parsed.filter((id): id is string => typeof id === 'string' && isCanonicalPollId(id))
    return [...new Set(ids.map((id) => id.toLowerCase()))].slice(0, LIMIT)
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

function keep(next: string[]) {
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
 * The open polls this browser has opened, newest first, for `list_polls`.
 *
 * Read when the list reads rather than watched: nothing on the list's screen
 * opens a poll, so the set cannot change while it is the page in front of
 * the reader, and the next read of the list picks up whatever changed while
 * they were away from it.
 */
export function openedPolls(): readonly string[] {
  return opened
}

/**
 * Records an open poll as opened in this browser, or moves it back to the
 * front if it already was.
 *
 * `firstQuestionId` is the id the poll list knows the poll by — the poll's
 * own id when it asks one question — so pass that rather than whichever
 * question is on screen; see the note at the top of this file.
 */
export function rememberOpenedPoll(firstQuestionId: string): void {
  if (!isCanonicalPollId(firstQuestionId)) return
  const id = firstQuestionId.toLowerCase()
  if (opened[0] === id) return
  keep([id, ...opened.filter((other) => other !== id)].slice(0, LIMIT))
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
  const next = opened.filter((id) => live.has(id))
  if (next.length === opened.length) return
  keep(next)
}
