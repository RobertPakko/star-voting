/**
 * What this browser has done with a poll's questions, kept in this browser.
 *
 * Two marks, one stage apart: the question strip's tick on a question already
 * answered, and — while the poll is still collecting its options — on a
 * question this reader has finished adding to.
 *
 * On an invite poll the server fills both in; `poll_group` returns a flag
 * each, because both carry the reader's account. **On an open poll nothing
 * can.** A share-link ballot, and its confirmation with it, is identified by a
 * `voter_key` minted per question precisely so one browser's marks cannot be
 * joined, and `open_poll_group` will not undo that to fill in a tick. The
 * browser already knows, and is the one place entitled to. This is that place.
 *
 * Nothing here reaches the server, and nothing here is trusted: being wrong
 * colours a badge and cannot let anybody vote twice, see a sealed result or
 * reach a poll they do not hold a link to. The server decides all three, on
 * every call, from the key it is shown.
 *
 * **A question is recorded by its poll id**, which is the only name it has —
 * the public page and the creator's page reach the same question at the same
 * address, so a question answered on either is marked on both.
 *
 * **Both are kept honest rather than only appended to**: a creator who clears
 * a poll's votes leaves this browser holding a ballot that no longer exists,
 * and a confirmation can be taken back, so a read that comes back "no" erases
 * the record instead of letting a stale tick outlive what it stood for.
 *
 * **The two are stored apart, because they are true at different times.** A
 * poll still collecting takes no ballots and a poll taking ballots collects
 * nothing, so one key holding both would mean a question confirmed before the
 * poll opened reading afterwards as a ballot nobody cast.
 */

const ANSWERED_KEY = 'star-voting:answered'
const CONFIRMED_KEY = 'star-voting:confirmed-options'

/**
 * How many questions are remembered per mark, oldest dropped first. Polls are
 * deleted six months after creation, so an entry is dead long before anybody
 * voting at a human rate reaches this; the cap is only so a browser that never
 * clears its storage cannot grow it without limit.
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
    // which is what this browser showed before it remembered any.
    return []
  }
}

function persist(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids.slice(-REMEMBERED_MAX)))
  } catch {
    // Nothing to do; the strip goes back to marking nothing.
  }
}

/**
 * One mark's worth of storage. Written once and used twice rather than copied,
 * so the two cannot drift into behaving differently — which, for two ticks
 * drawn by the same strip in the same colour, would read as a bug in the strip.
 */
function mark(key: string) {
  return {
    /** Every question recorded under this mark. Read fresh: the pages ask once per poll read. */
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
