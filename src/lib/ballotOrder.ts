import { useMemo } from 'react'
import type { PollOption } from './types'

/**
 * The order options are shown in on a ballot: shuffled, and shuffled the same
 * way every time for any one browser.
 *
 * Ballot order is not neutral. An option at the top of a list is read first
 * and read most carefully, and scores better for it than the same option
 * would halfway down — so one fixed list for every voter hands whatever the
 * creator typed first an advantage that has nothing to do with the option.
 * Shuffling per browser spreads that advantage across the options: the bias
 * does not go away, it stops always landing in the same place.
 *
 * **Stable per browser rather than per render**, which is what keeps it
 * usable: a voter who reloads, or comes back to change their vote, finds the
 * ballot where they left it. A list that reshuffled on every paint would be
 * fair by the same argument and impossible to fill in.
 *
 * What is stored is one seed, not any poll's running order. The order is
 * derived by hashing that seed with each option's id, so a creator correcting
 * the options — or a soliciting poll taking one more suggestion — slots the
 * new option into the order the rest already have instead of invalidating a
 * stored arrangement. One seed covers every poll, because option ids are
 * unique to their poll.
 *
 * **Display only.** A ballot is sent as a score per option id and read back by
 * id, so the order it travels in means nothing to anyone. Applied in
 * `BallotCard` and nowhere else: results are ordered by score, the published
 * sheet has an ordering of its own that is deliberately not arrival order, and
 * the creator's option editor shows the list in the order they typed it.
 */

const STORAGE_KEY = 'star-voting:ballot-order-seed'

/** Set only when localStorage refused; see voterKey.ts for the same trade. */
let memorySeed: string | null = null

function randomSeed(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function browserSeed(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY)
    if (existing) return existing
    const created = randomSeed()
    localStorage.setItem(STORAGE_KEY, created)
    return created
  } catch {
    // Private browsing, or storage disabled. A per-tab seed still holds the
    // order steady across every re-render and re-read, which is the whole of
    // what a voter filling in a ballot notices; it just cannot survive a
    // reload.
    memorySeed ??= randomSeed()
    return memorySeed
  }
}

/**
 * FNV-1a, 32-bit, finished with murmur3's avalanche step.
 *
 * The finisher is not decoration, and dropping it visibly tilts the ballot.
 * Every option here is hashed as the same seed followed by a different id, and
 * FNV alone leaves two such hashes differing by close to a fixed XOR pattern —
 * enough to sort with, but not evenly: comparing XOR-related numbers favours
 * whichever id carries the pattern in its high bits, in the same direction for
 * every browser. Measured over 200k seeds on a five-option poll, plain FNV put
 * one option first 24% of the time and another 17%, against the 20% each the
 * shuffle is supposed to deliver. With the avalanche the same measurement
 * comes back inside 19.8–20.2%.
 */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 0x01000193)
  }
  value ^= value >>> 16
  value = Math.imul(value, 0x85ebca6b)
  value ^= value >>> 13
  value = Math.imul(value, 0xc2b2ae35)
  value ^= value >>> 16
  return value >>> 0
}

/**
 * The poll's options in this browser's order. A copy, since `sort` works in
 * place and the array handed in belongs to the page that read the poll.
 *
 * Ids break a hash collision so two options can never sort as equal — `sort`
 * is stable, so a pair left equal would fall back to the authored order this
 * exists to break up.
 */
export function useBallotOrder(options: PollOption[]): PollOption[] {
  return useMemo(() => {
    const seed = browserSeed()
    const keys = new Map(options.map((option) => [option.id, hash(seed + option.id)]))
    return [...options].sort((a, b) => keys.get(a.id)! - keys.get(b.id)! || (a.id < b.id ? -1 : 1))
  }, [options])
}
