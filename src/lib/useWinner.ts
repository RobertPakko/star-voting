import { useEffect, useSyncExternalStore } from 'react'
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
 * if this tab has not been told.
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
 * A failed request leaves this `undefined`: the badge then says the results
 * are ready without saying what they were, which is what a browser older than
 * the function sees too.
 */
export function useWinner(pollId: string | undefined, resultsAvailable: boolean) {
  const winner = useKnownWinner(pollId)

  useEffect(() => {
    // Nothing to name until the results have unlocked, and asking early
    // would be asking the database to tell a voter how it is going.
    if (!pollId || !resultsAvailable) return
    if (knownWinners().has(pollId)) return

    let cancelled = false
    supabase.rpc('poll_winners', { p_poll_ids: [pollId] }).then(({ data, error }) => {
      if (error || !data || cancelled) return
      const rows = data as { poll_id: string; winner_name: string | null }[]
      // Remembered whether or not this component still wants it: the answer
      // is about the poll, not about who asked.
      for (const row of rows) rememberWinner(row.poll_id, row.winner_name)
    })

    return () => {
      cancelled = true
    }
  }, [pollId, resultsAvailable])

  return winner
}
