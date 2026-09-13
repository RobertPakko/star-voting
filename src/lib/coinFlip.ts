/**
 * The draw a tied poll is settled by, and why every reader gets the same one.
 *
 * STAR can elect nobody. Two finalists level on preference, on points and on
 * five-star ballots come back as `resolved_by: 'unresolved'` — the app reports
 * the tie rather than inventing a result, which is the only honest thing a
 * tally can do and no help whatsoever to six people deciding where to eat. The
 * coin is for them. It is not a rule of the method, it does not give the poll
 * a winner, and nothing about it is written down; see AGENTS.md, "Settling a
 * tie with a coin".
 *
 * **The one thing it has to be is the same coin for everybody.** A draw made
 * in each browser is a different answer per reader, which is worse than no
 * answer at all: two people leave the page believing two different options
 * won, and neither has any way to know the other saw something else. So
 * nothing here is random at the moment of asking. The side is a function of
 * the poll's own identity — its id and its two finalists' — mixed down to one
 * bit, so every reader on every device computes the same side from the tally
 * they are already holding, tonight and next week.
 *
 * That is the shape the score round's own last resort already has: it reports
 * `resolved_by: 'random'` and in fact orders by candidate id, arbitrary and
 * stable. What deriving it buys over storing a flip is all of the
 * coordination. Nobody has to have flipped first, there is no race over who
 * did, no write and no new grant on either read path, a reader opening the
 * results a week later gets the side the group saw on the night, and the About
 * page's sample poll — a recording, with no rows behind it — can draw it like
 * anything else.
 *
 * **Arbitrary is not riggable.** Every id in the seed is a uuid Postgres
 * minted: the poll's when it was created, an option's when it was inserted. No
 * one picks them, and the creator cannot touch the option list at all once a
 * ballot is in (see AGENTS.md, "The creator can correct the options until
 * somebody votes"), which is well before anyone could know a tie was coming.
 */

/**
 * Which of two finalists the coin gives it to. Returns one of the two ids.
 *
 * **The pair is sorted before it is hashed**, so the answer cannot depend on
 * the order the tally happened to list them in. `finalists` is an array out of
 * `star_round` and every caller is free to read it either way round; one tie
 * has to mean one seed however it is presented.
 */
export function coinFlip(pollId: string, a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a]
  return heads(`${pollId}:${first}:${second}`) ? first : second
}

/**
 * One bit out of a string, as even as a coin.
 *
 * FNV-1a over the seed, then murmur3's final avalanche over what comes out.
 * The avalanche is not decoration. A raw FNV hash is barely mixed at the
 * bottom — its last step multiplies by an odd constant, which leaves the
 * lowest bit as nothing more than the parity of the bytes that went in — and
 * one bit is the entire answer here. Mixing first is what makes the bit read
 * off the end depend on all of the seed rather than on a corner of it.
 *
 * `Math.imul` rather than `*` because both are 32-bit multiplications that
 * overflow on purpose, and JavaScript's `*` would carry them into floats and
 * lose the low bits that are the whole point.
 */
function heads(seed: string): boolean {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193)
  }

  h ^= h >>> 16
  h = Math.imul(h, 0x21f0aaad)
  h ^= h >>> 15
  h = Math.imul(h, 0x735a2d97)
  h ^= h >>> 15

  return h >>> 31 === 1
}
