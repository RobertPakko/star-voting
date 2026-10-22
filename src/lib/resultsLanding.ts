import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { pollPath } from './pollId'

/**
 * A poll of several questions whose results come out while it is on screen
 * goes back to question 1.
 *
 * The results usually come out on the last ballot of the last question --
 * often this reader's own -- so without this they land on question 3's tally
 * with no sign that questions 1 and 2 have results too. Only the moment of
 * the reveal moves anybody: a reader who opens a finished poll at question 3,
 * or walks to it afterwards, is left where they asked to be.
 *
 * `group` is the poll's group id (null for a single question, which never
 * moves); `questions` the group's questions, in any order.
 */
export function useFirstQuestionOnResults(
  pollId: string | undefined,
  group: string | null | undefined,
  resultsAvailable: boolean | undefined,
  questions: readonly { id: string; question_position: number }[],
): void {
  const navigate = useNavigate()
  const seen = useRef<{ group: string; available: boolean } | null>(null)

  useEffect(() => {
    if (!group || resultsAvailable === undefined) return
    const was = seen.current
    seen.current = { group, available: resultsAvailable }
    if (!was || was.group !== group || was.available || !resultsAvailable) return

    const first = [...questions].sort((a, b) => a.question_position - b.question_position)[0]
    if (first && first.id !== pollId) navigate(pollPath(first.id), { replace: true })
  }, [group, resultsAvailable, questions, pollId, navigate])
}
