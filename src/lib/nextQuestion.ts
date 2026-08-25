/**
 * Where a voter goes once they have answered the question in front of them.
 *
 * A poll of several questions moves the voter on by itself — see the pages
 * that call this — and the question it moves them to is the next one they
 * still owe, not simply the next one along. The two are the same thing for
 * anybody working a poll front to back, which is nearly everybody; they come
 * apart for the voter who jumped into the middle from the question strip, and
 * for that voter "the next one" would be a question they have already
 * answered. Being carried to a ballot that is already cast is not progress,
 * it is a page saying *your vote is in* that nobody asked to see.
 *
 * **It rounds.** The search runs forward from the question just answered and
 * then wraps to the ones before it, so a voter who started at question 3 is
 * taken back to question 1 rather than left standing on the last question
 * with two unanswered ones behind them. Stopping at the end would be a dead
 * end: the card that used to offer the way on is gone, and what remains is
 * the strip, which says which questions are outstanding but does not act. If
 * a poll still has an unanswered question in it, there is somewhere to go.
 *
 * **Nothing is left when there is nothing owed.** Every other question
 * answered returns null, and the page then does what a single-question poll
 * has always done: stays where it is and re-reads itself into *your vote is
 * in*. The question just answered is excluded by key rather than by its flag,
 * because this is asked at the moment the ballot goes in and no read has yet
 * come back to say so.
 *
 * It takes the same list the strip is drawn from, deliberately: the voter is
 * only ever sent to a question the strip in front of them shows as
 * outstanding, and one list is what makes that true rather than a promise.
 */
export function nextUnansweredKey(
  questions: { key: string; answered?: boolean }[],
  current: string,
): string | null {
  const here = questions.findIndex((question) => question.key === current)
  // A poll that asks one question has an empty list and no next anything.
  if (here < 0) return null

  const onwards = [...questions.slice(here + 1), ...questions.slice(0, here)]
  return onwards.find((question) => !question.answered)?.key ?? null
}
