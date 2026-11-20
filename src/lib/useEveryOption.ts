import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { openPollRpc } from './samplePoll'
import { countFor, groupFromKey, groupKeyOf, type CountSource } from './groupCount'
import { optionScoresSchema, parseAnswer } from './rpcSchemas'
import type { PollResults } from './types'

/**
 * Every option on the ballot, for the cost editor (and the assignment's
 * places). The tally holds the top `SCORING_ROWS_MAX`; a longer list is read
 * whole from *All scores*' door, once, when the editor opens.
 */
export function useEveryOption(source: CountSource, results: PollResults) {
  const whole = results.options.length >= results.option_count
  const group = groupKeyOf(source)
  const { kind, pollId } = source
  const [read, setRead] = useState<{ id: string; name: string }[] | null>(null)

  useEffect(() => {
    if (whole) return
    let cancelled = false
    // A group's options are the poll's; read through the group's door all the
    // same, since that is the one a group's card is entitled to.
    const request = countFor({ kind, pollId, group: groupFromKey(group) }, 'scores', {}, () =>
      kind === 'poll'
        ? supabase.rpc('get_poll_scores', { p_poll_id: pollId })
        : openPollRpc('open_poll_scores', { p_poll_id: pollId }),
    )
    request.then(({ data, error }) => {
      if (cancelled || error) return
      const { value } = parseAnswer(optionScoresSchema, 'the scores', data)
      if (value) setRead(value.map(({ id, name }) => ({ id, name })))
    })
    return () => {
      cancelled = true
    }
  }, [whole, kind, pollId, group])

  return whole ? results.options.map(({ id, name }) => ({ id, name })) : read
}
