import { useEffect, useRef } from 'react'

/**
 * A ballot somebody has started and not sent, kept in this browser so that
 * losing the page does not lose the work.
 *
 * A ballot's scores lived in the card's own state and nowhere else, so
 * anything that took the card down took them with it: a refresh, a tab the
 * phone threw away in the background, or a step to another question of the
 * same poll and back -- which unmounts the card (see "A crossing between two
 * questions replaces the question" in AGENTS.md). A voter halfway down a long
 * list, or halfway across a week of calendar, came back to a blank ballot.
 * So every score given on a first ballot is written here as it is given, and
 * the card opens with it when it mounts again.
 *
 * **Only a ballot that has not gone in.** The moment the server holds a
 * ballot it is the answer: a revision opens with the scores the server hands
 * back (`initial`), never with anything here, and a draft is deleted the
 * moment its ballot is accepted. A draft that outlives a ballot cast somewhere
 * else is never read, because a reader who has voted is shown *your vote is
 * in* rather than a ballot to fill in, and it ages out below.
 *
 * **Ten polls, newest kept.** A poll of several questions counts once -- its
 * questions are filed under the group -- so walking a five-question poll is
 * one of the ten, not half of them. Opening the eleventh drops the poll
 * touched longest ago.
 *
 * **Whose draft it is.** A draft is filed against the account that wrote it,
 * or against nobody on a browser signed out, and is read back only by the
 * same: an invite poll's ballot left half done on a shared browser is not the
 * next person's to find filled in. Writing for a different reader replaces
 * the poll's entry rather than keeping both.
 *
 * Nothing here reaches the server and nothing here is trusted. What is read
 * back is narrowed to what the ballot on screen can still hold -- an option
 * the creator has since removed, or a cell the poll no longer asks about, is
 * dropped by the card -- so the worst a stale draft can do is fill in a
 * score the voter can see and change before anything is sent.
 *
 * The About page's sample is kept in memory instead, for the length of the
 * visit, for the reason its ballots are (see `forgetSampleBallots`):
 * `forgetSampleDrafts` goes with them.
 */

/** One question's scores so far: option id → score, or a calendar's cell → rating. */
export type BallotDraft = Record<string, number>

/** Which ballot a draft belongs to, and whose. */
export interface DraftScope {
  /** The question -- a poll of its own. */
  pollId: string
  /** The poll it is one question of, when it asks several; what the cap counts. */
  groupId?: string | null
  /** The account writing it, or null signed out. */
  owner: string | null
}

const STORAGE_KEY = 'star-voting:ballot-drafts'

/** How many polls keep a draft, oldest dropped first. */
export const DRAFT_POLLS_MAX = 10

/** One poll's drafts, a question at a time. */
interface PollDrafts {
  poll: string
  owner: string | null
  questions: Record<string, BallotDraft>
}

/** Where the drafts go when storage refuses: kept for this tab, which still covers a crossing. */
let memory: PollDrafts[] = []
/** The sample's, which are never written to storage at all. */
let sample: PollDrafts[] = []

function isSample(pollId: string): boolean {
  // The same test as `isSampleId`, which lives in a module that would import
  // this one back.
  return pollId.startsWith('sample-')
}

function pollOf(scope: DraftScope): string {
  return scope.groupId ?? scope.pollId
}

/** A stored draft, if it is one: scores that are whole numbers from 0 to 5. */
function asDraft(value: unknown): BallotDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const draft: BallotDraft = {}
  for (const [key, score] of Object.entries(value)) {
    if (Number.isInteger(score) && (score as number) >= 0 && (score as number) <= 5) {
      draft[key] = score as number
    }
  }
  return draft
}

function asPollDrafts(value: unknown): PollDrafts | null {
  if (!value || typeof value !== 'object') return null
  const { poll, owner, questions } = value as Record<string, unknown>
  if (typeof poll !== 'string') return null
  if (owner !== null && typeof owner !== 'string') return null
  if (!questions || typeof questions !== 'object') return null
  const kept: Record<string, BallotDraft> = {}
  for (const [question, draft] of Object.entries(questions)) {
    const valid = asDraft(draft)
    if (valid) kept[question] = valid
  }
  return { poll, owner, questions: kept }
}

/** Every poll's drafts, least recently touched first. Anything unreadable reads as none. */
function load(sampled: boolean): PollDrafts[] {
  if (sampled) return sample
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return memory
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(asPollDrafts).filter((entry): entry is PollDrafts => entry !== null)
  } catch {
    // Private browsing, storage disabled, or something else's key.
    return memory
  }
}

function store(sampled: boolean, entries: PollDrafts[]) {
  const kept = entries.slice(-DRAFT_POLLS_MAX)
  if (sampled) {
    sample = kept
    return
  }
  memory = kept
  try {
    if (kept.length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(kept))
  } catch {
    // Full, or refused: the tab keeps them in `memory`, which still carries a
    // ballot across a crossing and is all that is lost to a refresh.
  }
}

/** This reader's unsent scores for one question, or null where there are none. */
export function readBallotDraft(scope: DraftScope): BallotDraft | null {
  const entry = load(isSample(scope.pollId)).find((e) => e.poll === pollOf(scope))
  if (!entry || entry.owner !== scope.owner) return null
  const draft = entry.questions[scope.pollId]
  return draft && Object.keys(draft).length > 0 ? { ...draft } : null
}

/**
 * Writes one question's scores so far, and makes its poll the newest.
 *
 * Zeros are not kept: an untouched score is a 0 on both ballots, so a draft
 * of nothing but zeros is no draft, and the question's entry goes.
 */
export function saveBallotDraft(scope: DraftScope, draft: BallotDraft): void {
  const scores: BallotDraft = {}
  for (const [key, score] of Object.entries(draft)) if (score !== 0) scores[key] = score
  if (Object.keys(scores).length === 0) {
    clearBallotDraft(scope)
    return
  }

  const sampled = isSample(scope.pollId)
  const poll = pollOf(scope)
  const entries = load(sampled)
  const existing = entries.find((e) => e.poll === poll)
  const questions = existing && existing.owner === scope.owner ? existing.questions : {}
  store(sampled, [
    ...entries.filter((e) => e !== existing),
    { poll, owner: scope.owner, questions: { ...questions, [scope.pollId]: scores } },
  ])
}

/** The ballot went in, or there is nothing left of it: forget the question's draft. */
export function clearBallotDraft(scope: DraftScope): void {
  const sampled = isSample(scope.pollId)
  const poll = pollOf(scope)
  const entries = load(sampled)
  const existing = entries.find((e) => e.poll === poll)
  if (!existing || !(scope.pollId in existing.questions)) return
  const questions = { ...existing.questions }
  delete questions[scope.pollId]
  store(
    sampled,
    Object.keys(questions).length === 0
      ? entries.filter((e) => e !== existing)
      : entries.map((e) => (e === existing ? { ...e, questions } : e)),
  )
}

/** Leaving the sample behind; see `forgetSampleBallots`. */
export function forgetSampleDrafts(): void {
  sample = []
}

/**
 * Writes the card's scores as they change, from the first change on.
 *
 * Not on mount: a card opening has given no score yet, and writing what it
 * opened with would make a poll merely looked at the newest of the ten.
 * `scope` undefined -- a revision, whose ballot the server already holds --
 * writes nothing.
 */
export function useSaveBallotDraft(scope: DraftScope | undefined, draft: BallotDraft): void {
  const opened = useRef(draft)
  const pollId = scope?.pollId
  const groupId = scope?.groupId ?? null
  const owner = scope?.owner ?? null
  useEffect(() => {
    if (pollId === undefined || draft === opened.current) return
    saveBallotDraft({ pollId, groupId, owner }, draft)
  }, [pollId, groupId, owner, draft])
}
