import { useCallback, useMemo, useState } from 'react'

/**
 * What this reader has done with a poll's questions: the server's answer
 * where it has one, and this browser's own where it does not.
 *
 * Two marks, one stage apart: the question strip's tick on a question already
 * answered, and — while the poll is still collecting its options — on a
 * question this reader has finished adding to.
 *
 * On an invite poll the server fills both in; `poll_group` returns a flag
 * each, because both carry the reader's account. **On an open poll the server
 * can too, for a reader who is signed in**: a ballot cast through the link
 * while signed in carries the account (`ballots.account_id`), so
 * `open_poll_group` and `poll_group` say which questions it answered — on the
 * phone as well as on the laptop that cast them. That is `useQuestionMarks`
 * below, and it is the answer that follows a reader between devices.
 *
 * **Signed out, nothing but this browser can.** A share-link ballot cast with
 * nobody signed in, and its confirmation with it, is identified by a
 * `voter_key` minted per question precisely so one browser's marks cannot be
 * joined, and `open_poll_group` will not undo that to fill in a tick. The
 * browser already knows, and is the one place entitled to. The storage below
 * is that place, and the hook's fallback for a ballot this browser cast
 * before its reader signed in.
 *
 * Nothing stored here reaches the server, and nothing here is trusted: being
 * wrong colours a badge and cannot let anybody vote twice, see a sealed result
 * or reach a poll they do not hold a link to. The server decides all three, on
 * every call, from the key it is shown and the account it is signed in as.
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

/** Both marks, as sets of question ids. */
export interface QuestionMarks {
  answered: ReadonlySet<string>
  confirmed: ReadonlySet<string>
}

const NO_MARKS: QuestionMarks = { answered: new Set(), confirmed: new Set() }

/**
 * A question as a group read lists it. The two flags are there where the
 * server could answer them — every question of an invite poll, and an open
 * poll's for a reader who is signed in — and absent where it could not.
 */
interface ListedQuestion {
  id: string
  voted?: boolean
  confirmed?: boolean
}

/** What a read of one question says about this reader's part in it. */
interface QuestionReading {
  voted: boolean
  confirmed?: boolean
}

function withMark(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  if (set.has(id) === on) return set
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

function union(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  if (b.size === 0) return a
  if (a.size === 0) return b
  return new Set([...a, ...b])
}

/**
 * The marks an open poll's question strip draws, from both places that can
 * know them.
 *
 * **The server's answer comes with the group** (`fromGroup`): the questions
 * this reader's account voted in or confirmed, wherever it did so. It is kept
 * in memory and never written to storage — it is the account's, and this
 * browser may be signed out of it by the next visit.
 *
 * **This browser's comes from storage**, for a ballot cast signed out.
 *
 * **A read of one question corrects both** (`fromView`). The group is read
 * once per arrival and a confirmation can be taken back after it, so a flag
 * the group gave can go stale; the view of that question is newer, and asks
 * the same server by the same rule — the account, or this browser's key — so
 * whatever it says about its question replaces what either source said.
 *
 * A mark is drawn where either says so.
 */
export function useQuestionMarks() {
  const [stored, setStored] = useState<QuestionMarks>(() => ({
    answered: answeredQuestions(),
    confirmed: confirmedQuestions(),
  }))
  const [account, setAccount] = useState<QuestionMarks>(NO_MARKS)

  const fromGroup = useCallback((questions: readonly ListedQuestion[]) => {
    setAccount({
      answered: new Set(questions.filter((q) => q.voted === true).map((q) => q.id)),
      confirmed: new Set(questions.filter((q) => q.confirmed === true).map((q) => q.id)),
    })
  }, [])

  const fromView = useCallback((questionId: string, reading: QuestionReading) => {
    const isConfirmed = reading.confirmed === true
    // Erased rather than only written: a confirmation can be taken back on the
    // card that gave it, and a read that comes back "no" is what says so.
    if (reading.voted) rememberAnswered(questionId)
    else forgetAnswered(questionId)
    if (isConfirmed) rememberConfirmed(questionId)
    else forgetConfirmed(questionId)
    setStored({ answered: answeredQuestions(), confirmed: confirmedQuestions() })
    setAccount((marks) => ({
      answered: withMark(marks.answered, questionId, reading.voted),
      confirmed: withMark(marks.confirmed, questionId, isConfirmed),
    }))
  }, [])

  const marks = useMemo<QuestionMarks>(
    () => ({
      answered: union(stored.answered, account.answered),
      confirmed: union(stored.confirmed, account.confirmed),
    }),
    [stored, account],
  )

  return { ...marks, fromGroup, fromView }
}
