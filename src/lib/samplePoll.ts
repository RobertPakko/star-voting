import { supabase } from './supabase'
import type {
  BallotSheet,
  OpenGroupQuestion,
  OpenPollView,
  PollResults,
  RankingEntry,
} from './types'

/**
 * The sample poll the About page links to, and the one place that serves it.
 *
 * It is a real three-question poll -- "Movie night" -- in two states: one copy
 * still taking votes, and one that nine people finished, whose questions get
 * progressively harder for STAR to settle. Both are answered out of
 * `samplePollData.ts`, which `scripts/sample-poll.sh` records by building the
 * poll in a throwaway database and asking the real RPCs about it.
 *
 * **Why a recording rather than rows in the real database.** A sample poll
 * living in Supabase would be deleted by the nightly retention purge six
 * months after it was created, and until then anyone holding the link could
 * vote in it -- so the tie-break the About page promises to demonstrate would
 * drift away from the ballots that produce it. Neither is true of a file.
 *
 * **What is not faked.** Every payload here came out of `star_round()`,
 * `poll_ranking()` and `ballot_sheet()`. Nothing in the browser recomputes a
 * tally, so the sample cannot show a STAR result this app would not produce;
 * change the ballots in `scripts/sample-poll.sql` and rerun the script and the
 * page follows.
 *
 * The pages themselves know none of this. `PublicPoll` renders a sample id
 * exactly as it renders a real one, because every open-poll read goes
 * through `openPollRpc` below and it is the only thing that decides what
 * answers it. The one place outside this file that has to know a sample id
 * when it sees one is `PollPage` in App.tsx, which routes it to `PublicPoll`
 * rather than offering it to the account reading first: there is no `polls`
 * row for that read to find, and asking for one got the reader a uuid
 * syntax error instead of the sample.
 */

/** The three questions of one copy of the sample, keyed by poll id. */
export interface SampleQuestion {
  view: OpenPollView
  group: OpenGroupQuestion[]
  /** The three a finished poll has and an open one does not. */
  results?: PollResults
  ranking?: RankingEntry[]
  ballots?: BallotSheet
}

export type SamplePayloads = Record<string, SampleQuestion>

/** Question 1 of each copy: where the About page's two links point. */
export const SAMPLE_POLL_ID = 'sample-host'
export const SAMPLE_RESULT_ID = 'sample-result-host'

/**
 * A real poll id is a v4 UUID, so nothing the database can mint begins with
 * this and no poll can be shadowed by the sample. It is also why the sample's
 * ids are words: a poll's id is its link now, and the sample's links are meant
 * to be read in the address bar and pasted into a talk.
 *
 * They are ids the `polls` table would refuse -- it would not merely fail to
 * find them, it errors on the cast -- so this has to be asked before anything
 * puts one in front of the database. Two places do: `openPollRpc` below, for
 * every open-poll call, and `PollPage` in App.tsx, for which of the two
 * readings of a poll address to render at all.
 */
export function isSampleId(pollId: string): boolean {
  return pollId.startsWith('sample-')
}

/**
 * What every open-poll RPC answers with, narrowed to the two fields this app
 * reads. `PostgrestError` satisfies it, which is what lets one call site hold
 * either answer without knowing which it got.
 */
export interface RpcAnswer {
  data: unknown
  error: { message: string } | null
}

interface OpenPollArgs {
  p_poll_id: string
  p_voter_key?: string
  p_scores?: { candidate_id: string; score: number }[]
  p_voter_name?: string | null
}

/**
 * Every read and write an open poll makes under its id, sent to the server
 * or, for the sample, answered here.
 *
 * The sample's data is `import()`ed rather than bundled with the app: it is
 * forty-odd kilobytes of recorded JSON, and the overwhelming majority of
 * readers never open the sample at all.
 */
export function openPollRpc(fn: string, args: OpenPollArgs): PromiseLike<RpcAnswer> {
  if (!isSampleId(args.p_poll_id)) return supabase.rpc(fn, args)
  return import('./samplePollData').then(({ SAMPLE_PAYLOADS }) => answer(SAMPLE_PAYLOADS, fn, args))
}

function answer(payloads: SamplePayloads, fn: string, args: OpenPollArgs): RpcAnswer {
  const question = payloads[args.p_poll_id]

  // The same message a mistyped link gets from the server, because a
  // mistyped sample link is the same mistake.
  if (!question) return failed('Poll not found')

  switch (fn) {
    case 'open_poll_view':
      return ok(withYourBallot(question.view, args.p_poll_id))
    case 'open_poll_group':
      return ok(question.group)
    // The sample is an open poll and its reader is outside it, always: it is
    // nobody's poll and was never a row, so there is no account reading of it
    // to be entitled to. That is the same answer `PollPage` hard-codes by
    // routing a sample id straight to the public reading, said here as well
    // so the two cannot disagree if that route is ever widened.
    case 'poll_page':
      return ok({
        kind: 'open',
        view: withYourBallot(question.view, args.p_poll_id),
        questions: question.group,
      })
    case 'open_poll_results':
      return question.results ? ok(question.results) : failed('Results are not available yet')
    case 'open_poll_ranking':
      return question.ranking ? ok(question.ranking) : failed('Results are not available yet')
    case 'open_poll_ballots':
      return question.ballots
        ? ok(question.ballots)
        : failed('Ballots are not available until the poll is closed')
    case 'open_poll_submit':
    case 'open_poll_revise':
      return castLocally(question, args)
    default:
      return failed(`The sample poll cannot answer ${fn}`)
  }
}

const ok = (data: unknown): RpcAnswer => ({ data, error: null })
const failed = (message: string): RpcAnswer => ({ data: null, error: { message } })

/**
 * A ballot cast in the sample, which stays in this browser.
 *
 * Voting is half of what the sample is for, so the open copy takes a vote and
 * behaves afterwards exactly as a real poll does: it says your vote is in, it
 * hands the ballot back to be changed, and it adds you to the roster. What it
 * does not do is tell anybody, which the poll's own description says in the
 * first line a voter reads.
 */
interface SampleBallot {
  name: string | null
  scores: Record<string, number>
}

const BALLOTS_KEY = 'star-voting:sample-ballots'

function storedBallots(): Record<string, SampleBallot> {
  try {
    return JSON.parse(localStorage.getItem(BALLOTS_KEY) ?? '{}') as Record<string, SampleBallot>
  } catch {
    // Private browsing, storage disabled, or something else's key. The sample
    // is then a poll you can vote in once per page load, which is a smaller
    // loss than a page that fails to load.
    return {}
  }
}

function castLocally(question: SampleQuestion, args: OpenPollArgs): RpcAnswer {
  if (question.view.is_closed) return failed('This poll is closed')

  const scores: Record<string, number> = {}
  for (const { candidate_id, score } of args.p_scores ?? []) scores[candidate_id] = score

  const ballots = storedBallots()
  const existing = ballots[args.p_poll_id]
  ballots[args.p_poll_id] = {
    // A revision keeps the name given when the ballot went in, which is what
    // open_poll_revise does: it takes no name at all.
    name: existing ? existing.name : (args.p_voter_name ?? null),
    scores,
  }

  try {
    localStorage.setItem(BALLOTS_KEY, JSON.stringify(ballots))
  } catch {
    // Nothing to do. The vote is accepted and shown; it just won't survive a
    // reload, which is the same thing that happens to a real open-poll ballot
    // whose voter key could not be kept.
  }

  return ok(null)
}

/**
 * The recorded view, with this browser's own sample ballot folded into it --
 * the three fields `open_poll_view` fills in for whoever presents the voter
 * key that cast one, plus the two counts that a ballot moves.
 */
function withYourBallot(view: OpenPollView, pollId: string): OpenPollView {
  const ballot = storedBallots()[pollId]
  if (!ballot) return view

  return {
    ...view,
    voted: true,
    your_name: ballot.name,
    your_scores: ballot.scores,
    voted_count: view.voted_count + 1,
    voters: view.voters && ballot.name ? [...view.voters, ballot.name] : view.voters,
  }
}
