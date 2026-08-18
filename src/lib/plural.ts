/**
 * Vote counts read back to people in prose, so they have to agree with
 * themselves: "1 voters preferred" reads as a bug in the tally even when the
 * arithmetic is right, and these lines are exactly the ones a voter checks a
 * close result against.
 */

export const voters = (n: number) => `${n} ${n === 1 ? 'voter' : 'voters'}`
