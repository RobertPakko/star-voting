import { describe, expect, it } from 'vitest'
import { splitAdvanced } from './tiebreak'
import type { Tiebreak } from './types'

const p = { id: 'p', name: 'Paddington 2' }
const s = { id: 's', name: 'Spirited Away' }
const m = { id: 'm', name: 'The Matrix' }

function fiveStarTie(
  values: Record<string, number>,
  slots: number,
  advanced: (typeof p)[],
): Tiebreak {
  const tied = [p, s, m]
  return {
    tied_at: 26,
    tied: tied.map((o) => ({ ...o, total_score: 26 })),
    slots,
    steps: [
      {
        rule: 'five_star_votes',
        results: tied.map((o) => ({ ...o, value: values[o.id] })),
        decisive: false,
      },
    ],
    resolved_by: 'random',
    advanced,
  }
}

/** By id, since `drawnFrom` comes off `tied` and carries its totals. */
const ids = (split: ReturnType<typeof splitAdvanced>) => ({
  earned: split.earned.map((o) => o.id),
  drawn: split.drawn.map((o) => o.id),
  drawnFrom: split.drawnFrom.map((o) => o.id),
})

describe('splitAdvanced', () => {
  it('credits the leader on five-star votes and draws only among those level behind it', () => {
    const tb = fiveStarTie({ p: 2, s: 1, m: 1 }, 2, [p, m])
    expect(ids(splitAdvanced(tb))).toEqual({ earned: ['p'], drawn: ['m'], drawnFrom: ['s', 'm'] })
  })

  it('draws every slot when nothing separated the tie', () => {
    const tb = fiveStarTie({ p: 1, s: 1, m: 1 }, 2, [p, m])
    expect(ids(splitAdvanced(tb))).toEqual({
      earned: [],
      drawn: ['p', 'm'],
      drawnFrom: ['p', 's', 'm'],
    })
  })

  it('leaves a decided tie alone', () => {
    const tb = {
      ...fiveStarTie({ p: 2, s: 1, m: 1 }, 1, [p]),
      resolved_by: 'five_star_votes' as const,
    }
    expect(splitAdvanced(tb)).toEqual({ earned: [p], drawn: [], drawnFrom: [] })
  })
})
