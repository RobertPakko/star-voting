import { describe, expect, test } from 'vitest'
import { capRows, RESULTS_ROWS_MAX } from './resultsRows'
import { count } from './plural'

/**
 * The cut the results page makes in a long tally, and the wording that admits
 * to it.
 *
 * Small enough to read in one sitting, and here rather than left to the
 * component because both of the things it has to get right are quiet when they
 * are wrong. A cut that hands back a copy of a short list is a fresh array
 * identity on every render of every result; a `hidden` off by one is a page
 * that says "and 14 options not shown" over fifteen of them, in the one place
 * in this app where a reader is checking numbers against each other.
 *
 * The rows themselves are never reordered here: the tally arrives highest
 * score first (`poll_tally` orders it, with a tie-break winner lifted above
 * the option it beat), and taking the first twenty is what makes the cut *the
 * top twenty* rather than an arbitrary twenty.
 */
describe('capRows', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => i)

  test('a list at or under the ceiling is passed straight through', () => {
    const short = list(5)
    const capped = capRows(short)

    expect(capped.rows).toBe(short)
    expect(capped.hidden).toBe(0)
  })

  test('a list exactly at the ceiling is not cut', () => {
    const exact = list(RESULTS_ROWS_MAX)

    expect(capRows(exact).rows).toBe(exact)
    expect(capRows(exact).hidden).toBe(0)
  })

  test('a longer list keeps its first rows and counts the rest', () => {
    const capped = capRows(list(137))

    expect(capped.rows).toHaveLength(RESULTS_ROWS_MAX)
    expect(capped.rows[0]).toBe(0)
    expect(capped.rows.at(-1)).toBe(RESULTS_ROWS_MAX - 1)
    expect(capped.hidden).toBe(137 - RESULTS_ROWS_MAX)
  })

  test('one row over the ceiling hides exactly one row', () => {
    expect(capRows(list(RESULTS_ROWS_MAX + 1)).hidden).toBe(1)
  })

  test('an empty list is a list under the ceiling', () => {
    expect(capRows([])).toEqual({ rows: [], hidden: 0 })
  })

  test('the ceiling can be given, for a caller that wants a shorter one', () => {
    expect(capRows(list(10), 3)).toEqual({ rows: [0, 1, 2], hidden: 7 })
  })
})

/**
 * The remainder is read back as prose, so it has to agree with itself: the
 * singular is reachable, on a poll with twenty-one options or a tied group of
 * exactly twenty-one pairs.
 */
describe('count', () => {
  test('agrees with the number in front of it', () => {
    expect(count(1, 'option')).toBe('1 option')
    expect(count(117, 'option')).toBe('117 options')
    expect(count(1, 'pair')).toBe('1 pair')
    expect(count(415, 'pair')).toBe('415 pairs')
  })
})
