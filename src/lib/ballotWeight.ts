import type { BallotSheet } from './types'

/**
 * What a ballot on a sequential poll counts as, drawn from the stars it had
 * given earlier winners (`given`, N): 5 / (5 + N), scaled so the
 * strongest ballot on the sheet counts as one. The scale is the database's
 * (`poll_ballot_weights`), so the weighted totals under the grid are the
 * tally's own, and it changes no result: every count is a sum of weights.
 */

/** Each ballot's weight, in the sheet's order; null on a sheet that carries none. */
export function sheetWeights(sheet: BallotSheet): number[] | null {
  if (!sheet.ballots.some((b) => b.given !== undefined)) return null
  const low = Math.min(...sheet.ballots.map((b) => b.given ?? 0))
  return sheet.ballots.map((b) => (5 + low) / (5 + (b.given ?? 0)))
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/**
 * A weight as a reader checks it: an exact fraction where the stars are whole
 * (`2/3`), two places where a newcomer's share made them otherwise, and `1`
 * for a ballot at full strength.
 */
export function formatWeight(given: number, low: number): string {
  const top = 5 + low
  const bottom = 5 + given
  if (Number.isInteger(top) && Number.isInteger(bottom)) {
    const d = gcd(top, bottom)
    return bottom / d === 1 ? String(top / d) : `${top / d}/${bottom / d}`
  }
  return String(Math.round((top / bottom) * 100) / 100)
}

/** The lowest N on a sheet, which every weight on it is scaled by. */
export function lowestGiven(sheet: BallotSheet): number {
  return Math.min(...sheet.ballots.map((b) => b.given ?? 0))
}
