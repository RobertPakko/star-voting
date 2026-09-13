import { describe, expect, test } from 'vitest'
import { coinFlip } from './coinFlip'

/**
 * The two properties the feature rests on, and they pull against each other.
 *
 * The coin has to be *fair* — a tie settled by a draw that quietly favours the
 * lower uuid is not a draw — and it has to be *the same draw for everybody*,
 * which is the half a running app cannot show you: a second reader opening the
 * modal is another browser, another day, and nothing on screen would say the
 * side had moved. So both are asserted here rather than looked at.
 */

/** A uuid-shaped id, from a seeded generator so a failure can be re-run. */
function ids(count: number): string[] {
  let state = 0x2545f491
  const hex = () => {
    state = (Math.imul(state ^ (state >>> 15), 0x27d4eb2d) >>> 0) % 0x10000
    return state.toString(16).padStart(4, '0')
  }

  return Array.from({ length: count }, () => `${hex()}${hex()}-${hex()}-${hex()}-${hex()}`)
}

describe('the coin', () => {
  test('gives it to one of the two finalists and not a third thing', () => {
    const [poll, a, b] = ids(3)
    expect([a, b]).toContain(coinFlip(poll, a, b))
  })

  test('lands the same way every time it is asked', () => {
    const [poll, a, b] = ids(3)
    const first = coinFlip(poll, a, b)

    // Reopening the modal, reloading the page, and the reader who arrives a
    // week later are all this call, made again.
    for (let i = 0; i < 100; i++) expect(coinFlip(poll, a, b)).toBe(first)
  })

  test('lands the same way whichever order the finalists are read in', () => {
    // `finalists` is an array, and nothing promises the two callers of it walk
    // it the same way round. A coin that cared would be two coins.
    const pairs = ids(60)

    for (let i = 0; i + 2 < pairs.length; i += 3) {
      const [poll, a, b] = pairs.slice(i, i + 3)
      expect(coinFlip(poll, a, b)).toBe(coinFlip(poll, b, a))
    }
  })

  test('is not the same coin for every poll', () => {
    // The same two options tied in two questions of one group is the case
    // this rules out: seeding on the finalists alone would hand both
    // questions to the same side, which looks like a rule rather than a draw.
    const [a, b, ...polls] = ids(202)
    const sides = new Set(polls.map((poll) => coinFlip(poll, a, b)))

    expect(sides.size).toBe(2)
  })

  test('is fair to within a whisker over two thousand ties', () => {
    // The bit is read off the top of an avalanche precisely so this holds; a
    // raw FNV hash's low bit would pass this and fail the digit test below.
    const pool = ids(6000)
    let first = 0

    for (let i = 0; i + 2 < pool.length; i += 3) {
      const [poll, a, b] = pool.slice(i, i + 3)
      const [lower] = a < b ? [a, b] : [b, a]
      if (coinFlip(poll, a, b) === lower) first++
    }

    const flips = Math.floor(pool.length / 3)
    // Three standard deviations of a fair coin over 2000 flips is about 67.
    expect(Math.abs(first - flips / 2)).toBeLessThan(70)
  })

  test('turns over on a single character of the seed', () => {
    // Ids differing in one digit are what a real pair of options looks like
    // often enough to matter — they are inserted together, and Postgres mints
    // them in one statement — and a hash that sent every near-neighbour the
    // same way would be a coin only over ids nobody has.
    const [poll] = ids(1)
    const a = '00000000-0000-4000-8000-000000000000'
    const sides = '123456789abcdef'
      .split('')
      .map((d) => (coinFlip(poll, a, `0000000${d}-0000-4000-8000-000000000000`) === a ? 'a' : 'b'))

    // Fifteen separate ties, so both sides should turn up among them.
    expect(new Set(sides).size).toBe(2)
  })
})
