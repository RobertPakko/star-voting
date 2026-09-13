/**
 * How much of a long tally the results page draws before it stops.
 *
 * A poll's results are a page of lists, and two of those lists have no
 * natural ceiling. The score round is one row per option, and an option is a
 * half-hour window on a schedule poll -- a working week of them is over a
 * hundred rows (see `MAX_OPTIONS`, which allows five hundred). A
 * head-to-head tie-break is one row per *pair* in the tied group, which is
 * quadratic: thirty windows tied at the top score is four hundred and
 * thirty-five lines. Either one turns the answer to "when should we meet"
 * into a document nobody scrolls to the end of, and the winner card at the
 * top is the part almost every reader came for.
 *
 * So both stop at twenty rows and say what they left out. Twenty is a screen
 * and a bit on a phone: long enough that the shape of the field is still
 * legible -- where the scores fall away, how far ahead the winner was -- and
 * short enough that the runoff card underneath is reachable by scrolling
 * rather than by hunting.
 *
 * **Nothing is hidden by it.** The whole field in placed order is one button
 * away (see `FullRanking`), and a poll long enough to be cut short always has
 * that button: it appears from three options up. The cut is about what the
 * page opens with, not about what a reader is allowed to see.
 *
 * **The cut is here rather than in `poll_tally`.** The tally's option list is
 * not only the score round: `Results` and `FullRanking` both read names out
 * of it, and the full ranking names every option down to last place, so a
 * payload that stopped at twenty would leave the modal drawing places it
 * could not label. The rows are already in the browser and the saving would
 * be bytes; the length that was the problem is the page's.
 */
export const RESULTS_ROWS_MAX = 20

/**
 * The first `max` of a list, and how many that leaves unsaid.
 *
 * `hidden` is zero on nearly every poll ever run, which is the case the two
 * callers of this are written around: no note, no wording about a remainder,
 * the list exactly as it was.
 */
export function capRows<T>(
  rows: T[],
  max: number = RESULTS_ROWS_MAX,
): {
  rows: T[]
  hidden: number
} {
  if (rows.length <= max) return { rows, hidden: 0 }

  return { rows: rows.slice(0, max), hidden: rows.length - max }
}
