import { openPollRpc } from './samplePoll'
import { heldVoterKeyFor } from './voterKey'
import type { PollRead } from './types'

/**
 * The one read that opens a poll page, whoever is opening it.
 *
 * `poll_page` answers what the route is actually asking — *what may this
 * reader see at this address* — and hands back the page along with the
 * answer, so the two are one request rather than a guess followed by a
 * correction. See `PollPage` in App.tsx for what is done with it, and
 * 0048_one_read_opens_a_poll.sql for what the server will and will not say.
 *
 * It goes through `openPollRpc` rather than `supabase.rpc` so the About
 * page's sample answers it out of its file like every other open-poll read.
 * The sample is not a row anywhere, and asking the database about
 * `sample-host` is a uuid syntax error rather than an empty result.
 *
 * **The voter key is peeked at, never minted.** This is the request that
 * establishes whether the address even leads to an open poll, so minting one
 * on the way in would leave a key behind for every invite poll an account
 * opens, none of which could ever be used for anything. A browser that has
 * voted is already holding its key; one that is not holding a key has not
 * voted, and both answers are the same. See `heldVoterKeyFor`.
 */
export async function readPollPage(
  pollId: string,
): Promise<{ page: PollRead | null; error: string | null }> {
  const { data, error } = await openPollRpc('poll_page', {
    p_poll_id: pollId,
    p_voter_key: heldVoterKeyFor(pollId) ?? undefined,
  })

  if (error) return { page: null, error: error.message }

  // An answer that is not one of the three tags is no answer at all, and is
  // reported as a failure rather than rendered from: there is no shape here
  // to draw a poll out of, and pretending otherwise puts the mistake on
  // screen instead of in front of whoever can fix it.
  const page = data as PollRead | null
  if (!page || (page.kind !== 'account' && page.kind !== 'open' && page.kind !== 'unreadable')) {
    return { page: null, error: 'Poll not found.' }
  }
  return { page, error: null }
}

/**
 * Which questions a read covers, so the route can tell a crossing between two
 * questions of one poll from an arrival at a different poll.
 *
 * A poll of several questions is several polls sharing a group, and every one
 * of them answers with the whole group — so a read of any question is a read
 * that describes all of them, and moving between them needs nothing from the
 * server that this read did not already bring. Which is what keeps the poll
 * on screen while a voter walks through it.
 */
export function questionsCovered(page: PollRead): string[] {
  return page.kind === 'unreadable' ? [] : page.questions.map((question) => question.id)
}
