import { openPollRpc } from './samplePoll'
import { parseAnswer, pollReadSchema } from './rpcSchemas'
import { heldVoterKeyFor } from './voterKey'
import type { PollRead } from './types'

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
