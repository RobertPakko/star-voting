import { useEffect, useState, useSyncExternalStore } from 'react'
import { supabase } from './supabase'
import { knownWinners, rememberWinner, subscribeWinners } from './settled'

/**
 * What this tab has been told one poll elected, without asking anybody.
 *
 * `undefined` until an answer exists, `null` for a poll that elected nobody,
 * and the option's name otherwise — the three states the state badge tells
 * apart. It re-renders when the answer arrives, whichever of the two places
 * it arrives from: `poll_winners()`, or the tally a `Results` card fetched
 * for itself and filed under the poll.
 */
export function useKnownWinner(pollId: string | undefined) {
  return useSyncExternalStore(subscribeWinners, () =>
    pollId ? knownWinners().get(pollId) : undefined,
  )
}

/**
 * What one poll elected, for the state badge beside its title, asking for it
 * if this tab has not been told — and whether an answer is still coming.
 *
 * The poll list asks about a page of polls at once; a poll page asks about
 * the one it is showing. Both go through `poll_winners()` and both remember
 * what they learn in the same place, so arriving at a poll from the list,
 * which is how most people arrive, costs nothing at all, and the badge on
 * the card and the badge on the page cannot disagree.
 *
 * **The public voting page uses `useKnownWinner` instead**, and asks nothing.
 * `poll_winners()` answers only to an account, and that page has none — but
 * the tally under its heading is fetched either way and carries the same
 * answer, so the badge waits the moment it takes that card to load rather
 * than making the server run a second election to fill itself in sooner.
 *
 * `pending` is what keeps the badge from saying anything in the meantime.
 * Without it a finished poll drew *Results ready* until this request landed
 * and then rewrote itself into the winner's name — a flicker on every load of
 * every finished poll, through a state that was true for nobody. It goes
 * false when the request settles **whether or not it succeeded**: a failure
 * leaves the winner `undefined`, and *Results ready* without a name is
 * exactly what that state is for. A badge held back forever would be a worse
 * answer than a vague one.
 */
export function useWinner(pollId: string | undefined, resultsAvailable: boolean) {
  const winner = useKnownWinner(pollId)
  // Whether this poll's winner has been asked about and answered — either
  // way. Keyed by poll id, because navigating from one poll to another
  // remounts nothing and an `asked` flag left set would let the next poll's
  // badge through before its own request had landed.
  const [asked, setAsked] = useState<string | null>(null)

  useEffect(() => {
    // Nothing to name until the results have unlocked, and asking early
    // would be asking the database to tell a voter how it is going.
    if (!pollId || !resultsAvailable) return
    if (knownWinners().has(pollId)) return

    let cancelled = false
    supabase.rpc('poll_winners', { p_poll_ids: [pollId] }).then(({ data, error }) => {
      if (!error && data) {
        const rows = data as { poll_id: string; winner_name: string | null }[]
        // Remembered whether or not this component still wants it: the answer
        // is about the poll, not about who asked.
        for (const row of rows) rememberWinner(row.poll_id, row.winner_name)
      }
      if (cancelled) return
      // Marked asked even on a failure, and even when the answer named no
      // poll at all: what this records is that the question has been put, not
      // that it came back with something.
      setAsked(pollId)
    })

    return () => {
      cancelled = true
    }
  }, [pollId, resultsAvailable])

  return {
    winner,
    pending: Boolean(pollId) && resultsAvailable && winner === undefined && asked !== pollId,
  }
}
