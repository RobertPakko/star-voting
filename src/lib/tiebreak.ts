import type { Tiebreak } from './types'

type Named = { id: string; name: string }

/**
 * Which of a tie's advancing options earned their slot and which were drawn.
 *
 * `star_round` reports a tie as `random` when a draw decided the *last* slot,
 * but a three-way tie for two slots can be half settled first: one option
 * leads on five-star votes and takes a slot outright, and only the two level
 * behind it are drawn between. Saying all of them "advanced on a random draw"
 * is then false of the leader. The draw was among the options level with the
 * lowest advancing one on the last rule tried, so anything advancing above
 * that value earned its slot on that rule.
 */
export function splitAdvanced(tb: Tiebreak): {
  earned: Named[]
  drawn: Named[]
  drawnFrom: Named[]
} {
  if (tb.resolved_by !== 'random') return { earned: tb.advanced, drawn: [], drawnFrom: [] }

  const last = tb.steps[tb.steps.length - 1]
  const value = new Map(last?.results.map((r) => [r.id, r.value]) ?? [])
  const at = (o: Named) => value.get(o.id) ?? 0
  const cut = Math.min(...tb.advanced.map(at))

  return {
    earned: tb.advanced.filter((o) => at(o) > cut),
    drawn: tb.advanced.filter((o) => at(o) === cut),
    drawnFrom: tb.tied.filter((o) => at(o) === cut),
  }
}
