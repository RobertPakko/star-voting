/**
 * Which questions this browser has a ballot in, kept in this browser.
 *
 * It exists for one badge: the question strip's tick on a question already
 * answered. On an invite poll the server fills that in — `poll_group`
 * returns a `voted` flag per question, because an invite ballot carries the
 * voter's account and nothing has to be linked to find it. **On an open poll
 * nothing can.** A share-link ballot is identified by a `voter_key` minted
 * per question precisely so that one browser's ballots cannot be joined to
 * each other, and `open_poll_group` will not undo that to fill in a tick —
 * its own comment says the browser already knows, and is the one place
 * entitled to. This is that place.
 *
 * So it is the same shape as `voterName`: continuity a voter actually
 * notices, carried by the only party who legitimately holds both halves,
 * and never sent anywhere. Nothing here reaches the server, and nothing here
 * is trusted for anything — being wrong colours a badge and cannot let
 * anybody vote twice, see a sealed result or reach a poll they don't hold a
 * link to. The server decides all three, on every call, from the key it is
 * shown.
 *
 * **A question is recorded under every name it goes by.** The public route
 * knows a question by its share token, the creator's own poll page knows the
 * same question by its poll id, and both draw the same strip; writing both
 * on every read is what lets either page answer for a question the other one
 * visited. `open_poll_view` returns the poll id alongside the view and the
 * creator's page holds the token, so both are always to hand.
 *
 * It is also kept honest rather than only appended to: a creator who clears
 * a poll's votes leaves this browser holding a ballot that no longer exists,
 * so a read that comes back "not voted" erases the record instead of letting
 * a stale tick outlive the ballot it was about.
 */

const STORAGE_KEY = 'star-voting:answered'

/**
 * How many questions are remembered, oldest dropped first.
 *
 * Polls are deleted six months after they are created, so an entry is dead
 * long before this cap is reached by anybody voting at a human rate; the cap
 * is only here so that a browser that never clears its storage cannot grow
 * this without limit. Losing the oldest entry costs one badge on a poll from
 * last year.
 */
const REMEMBERED_MAX = 500

/** The recorded ids, oldest first. Anything unreadable reads as none. */
function stored(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
  } catch {
    // Private browsing, storage disabled, or something else's key. No ticks,
    // which is exactly what this browser showed before it remembered any.
    return []
  }
}

function persist(ids: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-REMEMBERED_MAX)))
  } catch {
    // Nothing to do; the strip simply goes back to marking nothing.
  }
}

/**
 * Every question this browser has recorded a ballot in, by share token and
 * by poll id alike. Read fresh rather than cached: the pages ask once per
 * poll read, and a cache would be one more thing to keep in step with a
 * ballot going in.
 */
export function answeredQuestions(): ReadonlySet<string> {
  return new Set(stored())
}

/**
 * Record a ballot against every name the question goes by; see the note
 * above on why there are two. Nulls are passed through so a caller can hand
 * over a token that a poll may not have without checking first.
 */
export function rememberAnswered(...ids: (string | null | undefined)[]) {
  const adding = ids.filter((id): id is string => !!id)
  if (adding.length === 0) return
  const kept = stored().filter((id) => !adding.includes(id))
  persist([...kept, ...adding])
}

/** Forget one, under every name: the ballot it stood for is gone. */
export function forgetAnswered(...ids: (string | null | undefined)[]) {
  const dropping = ids.filter((id): id is string => !!id)
  if (dropping.length === 0) return
  const before = stored()
  const kept = before.filter((id) => !dropping.includes(id))
  if (kept.length !== before.length) persist(kept)
}
