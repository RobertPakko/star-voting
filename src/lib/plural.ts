/**
 * Counts read back to people in prose, so they have to agree with
 * themselves: "1 voters preferred" reads as a bug in the tally even when the
 * arithmetic is right, and these lines are exactly the ones a voter checks a
 * close result against.
 */

/**
 * A count as written: whole, or to two places where ballots carry weights
 * (a sequential poll), where "2.5 voters" is what the runoff counted.
 */
export const figure = (n: number) => String(Math.round(n * 100) / 100)

export const voters = (n: number) => `${figure(n)} ${n === 1 ? 'voter' : 'voters'}`

/**
 * A score, as the stars it is made of rather than "points", so a reader can
 * see that an option's total is the stars its ballots gave it.
 */
export const stars = (n: number) => `${figure(n)} ${n === 1 ? 'star' : 'stars'}`

/**
 * "1 option", "23 pairs" -- a count and the thing it counts, agreeing.
 *
 * For the lines that say what a list left out, where the number is whatever
 * the poll happened to have and the singular is reachable: a tally of
 * twenty-one options hides exactly one of them.
 */
export const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`
