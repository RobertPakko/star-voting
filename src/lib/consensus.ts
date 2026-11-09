import { formatWindow } from './schedule'
import type { ConsensusResult } from './types'

/**
 * The options a consensus left level on every score, named for the reader
 * (a time poll's windows formatted), as `CoinFlip` takes them. Empty where
 * the consensus has a winner.
 */
export function levelOptions(
  consensus: ConsensusResult,
  h24: boolean,
): { id: string; name: string }[] {
  return consensus.level_ids.map((id, i) => ({
    id,
    name: formatWindow(consensus.level_names[i] ?? id, h24),
  }))
}
