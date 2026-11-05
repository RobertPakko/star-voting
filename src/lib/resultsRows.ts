/**
 * How much of a long tally the results page draws before it stops.
 *
 * A poll's results are a page of lists, and two of those lists have no
 * natural ceiling. The score round is one row per option, and an option is a
 * half-hour window on a schedule poll -- a working week of them is over a
 * hundred rows (see `MAX_OPTIONS`, which allows five hundred). A tie-break
 * lists every option in the tied group, and a calendar ties dozens of windows
 * as a matter of course. Either one turns the answer to "when should we meet"
 * into a document nobody scrolls to the end of, and the winner card at the
 * top is the part almost every reader came for.
 *
 * So both stop and say what they left out: the scoring round at ten (see
 * `SCORING_ROWS_MAX` below), and the lists inside a tie-break at twenty, which
 * is also the cap on every other long list on the page. Twenty is a screen
 * and a bit on a phone: long enough that the shape of the field is still
 * legible, and short enough that the runoff card is reachable by scrolling
 * rather than by hunting.
 */
export const RESULTS_ROWS_MAX = 20

/**
 * The scoring round's ceiling, and the full ranking's: the ten highest.
 *
 * **This one is cut in the database** (`poll_results_rows()`), not here:
 * `poll_tally` sends only the top ten with `option_count` beside them, and
 * `poll_ranking` stops once ten places are filled, so a poll of hundreds of
 * windows does not send them all to every reader of its result, nor run a
 * STAR round for every place. The browser's copy is for the skeletons and the
 * wording; `limits.test.ts` holds the two numbers together.
 *
 * It cannot leave out a finalist: `poll_tally` orders by total and lifts a
 * tie-break winner above the options it tied with, so the two finalists are
 * always the first two rows.
 *
 * **Nothing is hidden by it.** Every option's score is one button away
 * (*All scores*, `AllScores`), read when pressed.
 */
export const SCORING_ROWS_MAX = 10

/**
 * The first `max` of a list, and how many that leaves unsaid.
 *
 * `hidden` is zero on nearly every poll ever run, which is the case the
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
