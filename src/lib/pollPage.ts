import { openPollRpc } from './samplePoll'
import { parseAnswer, pollReadSchema } from './rpcSchemas'
import { heldVoterKeyFor } from './voterKey'
import type { OpenPollView, PollRead, PollStatus } from './types'

/**
 * The one read that opens a poll page, whoever is opening it.
 *
 * `poll_page` answers what the route is actually asking — *what may this
 * reader see at this address* — and hands back the page along with the
 * answer, so the two are one request rather than a guess followed by a
 * correction. See `PollPage` in App.tsx.
 *
 * It goes through `openPollRpc` so the About page's sample answers out of its
 * file like every other open-poll read; asking the database about
 * `sample-host` is a uuid syntax error rather than an empty result.
 *
 * **The voter key is peeked at, never minted.** This is the request that
 * establishes whether the address even leads to an open poll, so minting here
 * would leave a key behind for every invite poll an account opens, none of
 * which could ever be used. A browser that has voted is already holding its
 * key; one that is not has not voted. See `heldVoterKeyFor`.
 */
export async function readPollPage(
  pollId: string,
): Promise<{ page: PollRead | null; error: string | null }> {
  const { data, error } = await openPollRpc('poll_page', {
    p_poll_id: pollId,
    p_voter_key: heldVoterKeyFor(pollId) ?? undefined,
  })

  if (error) return { page: null, error: error.message }

  // An answer that is not the shape this page draws from is no answer at all,
  // and is reported as a failure rather than rendered from: pretending
  // otherwise puts the mistake on screen instead of in front of whoever can
  // fix it. The tag is part of what is checked — see `pollReadSchema`, which
  // is a union on it.
  const { value, error: shape } = parseAnswer(pollReadSchema, 'poll_page', data)
  if (shape) return { page: null, error: shape }
  return { page: value, error: null }
}

/**
 * An **open** poll's status, read off the view its own link answers with.
 *
 * `poll_status` and `open_poll_view` are two readings of one poll, and on an
 * open poll the second contains the first: the counts come from the same
 * `count(*) from ballots`, `confirmed_count` from the same
 * `poll_confirmed_count()`, the winner from the same two columns, and
 * `is_closed`, `soliciting` and `results_available` from the same derivations.
 * So the creator's own page — the one screen that reads both — asks for one of
 * them and works the other out here, rather than paying a round trip for a
 * strict subset of what it already has.
 *
 * Five of the fields are `poll_status`' alone, and all five are answered here
 * exactly as it answers them on an open poll. That is the whole point: this
 * has to be a translation rather than a second opinion.
 *
 *  - **The invite list is empty**, because an open poll has none. `poll_status`
 *    counts `invited_voters` and gets nothing, so `is_complete` — which needs
 *    `invited > 0` — is false and stays false however many people vote.
 *  - **`voted` and `confirmed` are false**, and not because they are unknown.
 *    They are `poll_status`' questions about the *account*, and an open poll
 *    records neither against one: `open_poll_submit` inserts a ballot with
 *    `voter_id` null and `open_poll_confirm_options` stores no voter at all,
 *    both keyed by the browser's `voter_key` instead. So `poll_status` returns
 *    false here for a creator who has voted in their own open poll, and so
 *    does this. What that browser has done is in `OpenPollView.voted` and
 *    `.confirmed`, which is where the page reads it.
 *
 * And `expires_at` is the one field the view genuinely does not carry, which
 * is why it is asked for rather than derived: it is `created_at` plus the
 * retention window, fixed on the day the poll is made and never revised, so
 * the read that opened the page is holding the only copy anybody needs. See
 * `poll_expires_at`.
 */
export function statusFromOpenView(
  view: OpenPollView,
  expiresAt: PollStatus['expires_at'],
): PollStatus {
  return {
    invited_count: 0,
    voted_count: view.voted_count,
    is_complete: false,
    voted: false,
    is_closed: view.is_closed,
    results_available: view.results_available,
    soliciting: view.soliciting,
    expires_at: expiresAt,
    invited: false,
    confirmed: false,
    confirmed_count: view.confirmed_count,
    winner_name: view.winner_name,
    winner_settled: view.winner_settled,
  }
}

/**
 * Which questions a read covers, so the route can tell a crossing between two
 * questions of one poll from an arrival at a different poll.
 *
 * Every question answers with its whole group, so a read of any one describes
 * all of them and moving between them needs nothing further from the server.
 * That is what keeps the poll on screen while a voter walks through it.
 */
export function questionsCovered(page: PollRead): string[] {
  return page.kind === 'unreadable' ? [] : page.questions.map((question) => question.id)
}
