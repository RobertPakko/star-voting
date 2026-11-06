/**
 * Shares of a whole as the app writes them: whole percentages that add up to
 * exactly 100. Used by *Fractional winners* on a result and by its card on
 * `/choices`, so the page and the modal round the same way.
 */

/**
 * Each share rounded down, and the points left over handed to the largest
 * remainders (ties to the earlier key). Shares that sum to nothing stay at 0:
 * there is no whole to divide.
 */
export function percentagesOf(shares: Record<string, number>): Record<string, number> {
  const options = Object.keys(shares)
  const whole = Object.fromEntries(options.map((o) => [o, Math.floor(shares[o] * 100)]))
  const total = options.reduce((sum, o) => sum + shares[o], 0)
  if (total <= 0) return whole

  const spare = 100 - options.reduce((sum, o) => sum + whole[o], 0)
  const byRemainder = [...options].sort(
    (x, y) => shares[y] * 100 - whole[y] - (shares[x] * 100 - whole[x]),
  )
  for (const option of byRemainder.slice(0, Math.max(0, spare))) whole[option] += 1
  return whole
}
