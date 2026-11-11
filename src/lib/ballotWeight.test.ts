import { describe, expect, it } from 'vitest'
import { formatWeight, sheetWeights } from './ballotWeight'
import type { BallotSheet } from './types'

const sheet = (given: (number | undefined)[]): BallotSheet => ({
  voters_named: true,
  options: [],
  ballots: given.map((g, i) => ({
    voter: `v${i}`,
    scores: {},
    ...(g === undefined ? {} : { given: g }),
  })),
})

describe('ballot weights', () => {
  it('are absent on a sheet with no N', () => {
    expect(sheetWeights(sheet([undefined, undefined]))).toBeNull()
  })

  it('scale the strongest ballot to one', () => {
    expect(sheetWeights(sheet([5, 0, 10]))).toEqual([1 / 2, 1, 1 / 3])
    expect(sheetWeights(sheet([5, 15]))).toEqual([1, 1 / 2])
  })

  it('read as exact fractions where the stars are whole', () => {
    expect(formatWeight(0, 0)).toBe('1')
    expect(formatWeight(5, 0)).toBe('1/2')
    expect(formatWeight(1, 0)).toBe('5/6')
    expect(formatWeight(15, 5)).toBe('1/2')
  })

  it('and to two places where they are not', () => {
    expect(formatWeight(1.923077, 0)).toBe('0.72')
  })
})
