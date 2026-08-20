import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { knownWinners, rememberWinner } from './settled'

/**
 * What one poll elected, for the state badge beside its title.
 *
 * The poll list asks about a page of polls at once; a poll page asks about
 * the one it is showing. Both go through `poll_winners()` and both remember
 * what they learn in the same place, so arriving at a poll from the list,
 * which is how most people arrive, costs nothing at all, and the badge on
 * the card and the badge on the page cannot disagree.
 *
 * Returns `undefined` until an answer exists, `null` for a poll that elected
 * nobody, and the option's name otherwise. A failed request stays
 * `undefined`: the badge then says the results are ready without saying what
 * they were, which is what a browser older than the function sees too.
 */
export function useWinner(pollId: string | undefined, resultsAvailable: boolean) {
  const [winner, setWinner] = useState<string | null | undefined>(() =>
    pollId ? knownWinners().get(pollId) : undefined,
  )

  useEffect(() => {
    // Nothing to name until the results have unlocked, and asking early
    // would be asking the database to tell a voter how it is going.
    if (!pollId || !resultsAvailable) return

    const known = knownWinners()
    if (known.has(pollId)) {
      setWinner(known.get(pollId))
      return
    }

    let cancelled = false
    supabase.rpc('poll_winners', { p_poll_ids: [pollId] }).then(({ data, error }) => {
      if (error || !data) return
      const rows = data as { poll_id: string; winner_name: string | null }[]
      // Remembered whether or not this component still wants it: the answer
      // is about the poll, not about who asked.
      for (const row of rows) rememberWinner(row.poll_id, row.winner_name)
      if (cancelled) return
      const row = rows.find((r) => r.poll_id === pollId)
      if (row) setWinner(row.winner_name)
    })

    return () => {
      cancelled = true
    }
  }, [pollId, resultsAvailable])

  return winner
}
