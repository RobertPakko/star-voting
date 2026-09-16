import { forgetAnswered } from './questionMarks'
import { supabase } from './supabase'
import type { Database } from './database.types'
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
 * progressively harder to take in. The last of them is a poll that finds a
 * time, so the sample shows both ballots this app has. Both are answered out of
 * `samplePollData.ts`, which `scripts/sample-poll.sh` records by building the
 * poll in a throwaway database and asking the real RPCs about it.
 *
 * **Why a recording rather than rows in the real database.** A sample poll
 * living in Supabase would be deleted by the nightly retention purge six
 * months after creation, and until then anyone holding the link could vote in
 * it — so the tie-break the About page promises to demonstrate would drift
 * away from the ballots that produce it. Neither is true of a file.
 *
 * **What is not faked.** Every payload came out of `star_round()`,
 * `poll_ranking()` and `ballot_sheet()`. Nothing in the browser recomputes a
 * tally, so the sample cannot show a STAR result this app would not produce.
 *
 * The pages know none of this: `PublicPoll` renders a sample id exactly as it
 * renders a real one, because every open-poll read goes through `openPollRpc`
 * below. The one place outside this file that has to recognise a sample id is
 * `PollPage`, which routes it to `PublicPoll` rather than offering it to the
 * account reading — there is no `polls` row to find, and asking for one got
 * the reader a uuid syntax error instead of the sample.
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
export const SAMPLE_POLL_ID = 'sample-dinner'
export const SAMPLE_RESULT_ID = 'sample-result-dinner'

/**
 * A real poll id is a v4 UUID, so nothing the database can mint begins with
 * this and no poll can be shadowed by the sample. It is also why the sample's
 * ids are words: a poll's id is its link, and the sample's links are meant to
 * be read in the address bar and pasted into a talk.
 *
 * The `polls` table would not merely fail to find these — it errors on the
 * cast — so this has to be asked before anything puts one in front of the
 * database. Two places do: `openPollRpc` below, and `PollPage` in App.tsx.
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
 * Every function an open poll's link may reach, named rather than taken as a
 * bare string: the generated `Database` type knows the whole catalogue, and a
 * typo here would otherwise be a runtime "function does not exist" that only
 * the reader who hit it ever sees.
 *
 * `poll_page` is on the list because the read that *opens* a poll goes through
 * here too, so the sample can answer it — see lib/pollPage.ts.
 */
type OpenPollFn =
  | Extract<keyof Database['public']['Functions'], `open_poll_${string}`>
  | 'poll_page'

/**
 * Every read and write an open poll makes under its id, sent to the server
 * or, for the sample, answered here.
 *
 * The sample's data is `import()`ed rather than bundled with the app: it is
 * forty-odd kilobytes of recorded JSON, and the overwhelming majority of
 * readers never open the sample at all.
 */
export function openPollRpc(fn: OpenPollFn, args: OpenPollArgs): PromiseLike<RpcAnswer> {
  if (!isSampleId(args.p_poll_id)) return supabase.rpc(fn, args)
  return import('./samplePollData').then(({ SAMPLE_PAYLOADS }) => answer(SAMPLE_PAYLOADS, fn, args))
}

function answer(payloads: SamplePayloads, fn: OpenPollFn, args: OpenPollArgs): RpcAnswer {
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
        // Carried here for the same reason as everything else on this branch:
        // the shape is the server's, so the page cannot come to depend on the
        // sample answering it differently. Null on a question whose file holds
        // no tally, which is the same "ask for yourself" the server means by
        // it — and what the reader gets then is `open_poll_results` above,
        // answered out of the same file.
        results: question.results ?? null,
        ballots: question.ballots ?? null,
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
 * A ballot cast in the sample, which lasts as long as the visit that cast it.
 *
 * Voting is half of what the sample is for, so the open copy takes a vote and
 * behaves afterwards exactly as a real poll does: it says your vote is in, it
 * hands the ballot back to be changed, and it adds you to the roster. What it
 * does not do is tell anybody, which the poll's own description says in the
 * first line a voter reads.
 *
 * **And it is not kept.** These lived in `localStorage`, on the reasoning that
 * a sample which forgets your vote is a sample that behaves unlike the real
 * thing. It reads the other way round: a real poll is a thing you vote in
 * once, and the sample is a thing you come back to -- from a talk, from the
 * About page, to show somebody. A reader returning to it wants the ballot they
 * came to try, not the one they filled in weeks ago and a *your vote is in*
 * they have to find their way past. So the visit is the whole of the memory:
 * enough for the three questions to be walked through and the roster to be
 * right while that is happening, and gone by the next arrival. `PollPage`
 * calls `forgetSampleBallots` on its way off the poll routes.
 */
interface SampleBallot {
  name: string | null
  scores: Record<string, number>
}

const ballots = new Map<string, SampleBallot>()

/**
 * Leaving the sample behind; see `SampleBallot`.
 *
 * The strip's ticks go with them. They are the same fact written down twice --
 * a sample question is marked answered exactly where this map holds a ballot
 * for it -- and a tick outliving the ballot it stands for is the worse half of
 * what this is here to prevent: a reader coming back to a blank ballot under a
 * strip saying they had already finished, and a poll that thinks it is over
 * before its first question has been answered.
 */
export function forgetSampleBallots(): void {
  for (const pollId of ballots.keys()) forgetAnswered(pollId)
  ballots.clear()
}

function castLocally(question: SampleQuestion, args: OpenPollArgs): RpcAnswer {
  if (question.view.is_closed) return failed('This poll is closed')

  const scores: Record<string, number> = {}
  for (const { candidate_id, score } of args.p_scores ?? []) scores[candidate_id] = score

  const existing = ballots.get(args.p_poll_id)
  ballots.set(args.p_poll_id, {
    // A revision keeps the name given when the ballot went in, which is what
    // open_poll_revise does: it takes no name at all.
    name: existing ? existing.name : (args.p_voter_name ?? null),
    scores,
  })

  return ok(null)
}

/**
 * The recorded view, with this visit's own sample ballot folded into it --
 * the three fields `open_poll_view` fills in for whoever presents the voter
 * key that cast one, plus the two counts that a ballot moves.
 */
function withYourBallot(view: OpenPollView, pollId: string): OpenPollView {
  const ballot = ballots.get(pollId)
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
