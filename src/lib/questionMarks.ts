/**
 * What this browser has done with a poll's questions, kept in this browser.
 *
 * Two marks, and they are the same mark one stage apart: the question strip's
 * tick on a question already answered, and — while the poll is still
 * collecting its options — on a question this reader has finished adding to.
 *
 * On an invite poll the server fills both in. `poll_group` returns a `voted`
 * flag and a `confirmed` flag per question, because both carry the reader's
 * account and nothing has to be linked to find them. **On an open poll nothing
 * can.** A share-link ballot, and a share-link confirmation with it, is
 * identified by a `voter_key` minted per question precisely so that one
 * browser's marks cannot be joined to each other, and `open_poll_group` will
 * not undo that to fill in a tick — its own comment says the browser already
 * knows, and is the one place entitled to. This is that place.
 *
 * So it is the same shape as `voterName`: continuity a voter actually
 * notices, carried by the only party who legitimately holds both halves,
 * and never sent anywhere. Nothing here reaches the server, and nothing here
 * is trusted for anything — being wrong colours a badge and cannot let
 * anybody vote twice, see a sealed result or reach a poll they don't hold a
 * link to. The server decides all three, on every call, from the key it is
 * shown.
 *
 * **A question is recorded by its poll id**, which is the only name it has:
 * the public page and the creator's own page reach the same question at the
 * same address, so a question answered on either is marked on both. This used
 * to take two entries per ballot -- the share token the public route knew a
 * question by, and the poll id the creator's page knew it by -- and it does
 * not any more, for the same reason the two pages are now one address.
 *
 * Both are kept honest rather than only appended to: a creator who clears a
 * poll's votes leaves this browser holding a ballot that no longer exists, and
 * a confirmation can be taken back, so a read that comes back "not voted" or
 * "not confirmed" erases the record instead of letting a stale tick outlive
 * what it was about.
 *
 * **The two are stored apart, because they are true at different times.** A
 * poll still collecting takes no ballots and a poll taking ballots collects
 * nothing, so one key holding both would mean a question confirmed before the
 * poll opened reading afterwards as a ballot nobody cast.
 */

const ANSWERED_KEY = 'star-voting:answered'
const CONFIRMED_KEY = 'star-voting:confirmed-options'

/**
 * How many questions are remembered per mark, oldest dropped first.
 *
 * Polls are deleted six months after they are created, so an entry is dead
 * long before this cap is reached by anybody voting at a human rate; the cap
 * is only here so that a browser that never clears its storage cannot grow
 * this without limit. Losing the oldest entry costs one badge on a poll from
 * last year.
 */
const REMEMBERED_MAX = 100

/** The recorded ids under one key, oldest first. Anything unreadable reads as none. */
function stored(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
  } catch {
    // Private browsing, storage disabled, or something else's key. No ticks,
    // which is exactly what this browser showed before it remembered any.
    return []
  }
}

function persist(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids.slice(-REMEMBERED_MAX)))
  } catch {
    // Nothing to do; the strip simply goes back to marking nothing.
  }
}

/**
 * One mark's worth of storage. Written once and used twice rather than copied,
 * so the two marks cannot drift into behaving differently — which, for two
 * ticks drawn by the same strip in the same colour, would read as a bug in the
 * strip rather than as two stores disagreeing.
 */
function mark(key: string) {
  return {
    /**
     * Every question this browser has recorded under this mark. Read fresh
     * rather than cached: the pages ask once per poll read, and a cache would
     * be one more thing to keep in step with what it is about.
     */
    all: (): ReadonlySet<string> => new Set(stored(key)),
    /** Record it. */
    remember: (pollId: string) => {
      const kept = stored(key).filter((id) => id !== pollId)
      persist(key, [...kept, pollId])
    },
    /** Forget it: what it stood for is gone. */
    forget: (pollId: string) => {
      const before = stored(key)
      const kept = before.filter((id) => id !== pollId)
      if (kept.length !== before.length) persist(key, kept)
    },
  }
}

const answered = mark(ANSWERED_KEY)
const confirmed = mark(CONFIRMED_KEY)

/** Every question this browser has a ballot in. */
export const answeredQuestions = answered.all
/** Record that a ballot of this browser's is in for this question. */
export const rememberAnswered = answered.remember
/** Forget one: the ballot it stood for is gone. */
export const forgetAnswered = answered.forget

/** Every question this browser has said it is done adding options to. */
export const confirmedQuestions = confirmed.all
/** Record that this browser is done adding to this question's list. */
export const rememberConfirmed = confirmed.remember
/** Forget one: the confirmation was taken back, or the poll has moved on. */
export const forgetConfirmed = confirmed.forget
