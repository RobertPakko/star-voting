/**
 * Counts read back to people in prose, so they have to agree with
 * themselves: "1 voters preferred" reads as a bug in the tally even when the
 * arithmetic is right, and these lines are exactly the ones a voter checks a
 * close result against.
 */

export const voters = (n: number) => `${n} ${n === 1 ? 'voter' : 'voters'}`

/**
 * "1 option", "23 pairs" -- a count and the thing it counts, agreeing.
 *
 * For the lines that say what a list left out, where the number is whatever
 * the poll happened to have and the singular is reachable: a tally of
 * twenty-one options hides exactly one of them.
 */
export const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`
