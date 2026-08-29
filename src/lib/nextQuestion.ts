/**
 * Where a voter goes once they have answered the question in front of them:
 * the next question they still owe, not simply the next one along.
 *
 * The two are the same thing for anybody working front to back. They come
 * apart for the voter who jumped into the middle from the question strip, and
 * for them "the next one" is a question already answered — a page saying
 * *your vote is in* that nobody asked to see.
 *
 * **It rounds.** The search runs forward and then wraps, so a voter who
 * started at question 3 is taken back to question 1 rather than left on the
 * last question with two unanswered ones behind them. **Nothing owed returns
 * null**, and the page then stays put and re-reads itself into *your vote is
 * in*, as a single-question poll always has.
 *
 * It takes the same list the strip is drawn from, so the voter is only ever
 * sent to a question the strip in front of them shows as outstanding.
 *
 * **"Answered" is whatever the poll's stage is asking for**, which is how this
 * serves the option-collecting stage without knowing there is one: while a
 * poll is collecting, the list is marked by whose lists this reader has
 * confirmed, so *Confirm options* carries them on exactly as a ballot does.
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
