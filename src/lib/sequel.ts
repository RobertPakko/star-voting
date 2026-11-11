import type { BallotSheet, PollResults, RankingEntry } from './types'

/**
 * The next poll of a sequence, worked out from a finished one: each voter's
 * stars for earlier winners (N) are what they brought to this poll plus what
 * they gave this poll's winners. The create form is filled in with the
 * answer and the creator can change any of it; nothing here is anything the
 * creator could not type.
 *
 * It needs the poll's published sheet with names on it, which is why *Create
 * sequel poll* fills nothing in from a poll that hides either.
 */

/**
 * The options this poll elected, whose stars every ballot is charged: STAR's
 * winner (also a ranking's first place), or for multiple winners the places
 * the question asked for, first place alone where it asked for no number. A
 * tie elected nobody, and charges nobody.
 */
export function winnersOf(results: PollResults): string[] {
  if (results.kind === 'multiple' && Array.isArray(results.kind_result)) {
    const spots = results.kind_result as RankingEntry[]
    if (spots.length > 0 && 'place' in spots[0]) {
      const wanted = results.kind_value ?? 1
      return spots
        .filter((spot) => spot.place <= wanted)
        .flatMap((spot) => spot.options.map((o) => o.id))
    }
  }
  return results.winner_id ? [results.winner_id] : []
}

/** Six places, as the database stores them; enough to keep a newcomer's share exact. */
const round = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * The earlier voters of the sequel: everyone who voted here, charged this
 * poll's winners, then everyone this poll carried who did not vote, as they
 * were (`skipped`), so missing a week costs nothing.
 */
export function carriedFrom(
  sheet: BallotSheet,
  results: PollResults,
  skipped: { voter: string; given: number }[],
): { voter: string; given: number }[] {
  const winners = winnersOf(results)
  const voted = sheet.ballots
    .filter((ballot) => ballot.voter)
    .map((ballot) => ({
      voter: ballot.voter as string,
      given: round(
        (ballot.given ?? 0) + winners.reduce((sum, id) => sum + (ballot.scores[id] ?? 0), 0),
      ),
    }))
  const seen = new Set(voted.map((row) => row.voter.toLowerCase()))
  return [...voted, ...skipped.filter((row) => !seen.has(row.voter.toLowerCase()))]
}
