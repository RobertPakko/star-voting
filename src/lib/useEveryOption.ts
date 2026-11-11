import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { openPollRpc, type RpcAnswer } from './samplePoll'
import { optionScoresSchema, parseAnswer } from './rpcSchemas'
import type { PollResults } from './types'

/** Which door a results card reads through: an account's, or a link's. */
type Source = { kind: 'poll' | 'open'; pollId: string }

/**
 * Every option on the ballot, for the cost editor (and the assignment's
 * places). The tally holds the top `SCORING_ROWS_MAX`; a longer list is read
 * whole from *All scores*' door, once, when the editor opens.
 */
export function useEveryOption(source: Source, results: PollResults) {
  const whole = results.options.length >= results.option_count
  const [read, setRead] = useState<{ id: string; name: string }[] | null>(null)

  useEffect(() => {
    if (whole) return
    let cancelled = false
    const request: PromiseLike<RpcAnswer> =
      source.kind === 'poll'
        ? supabase.rpc('get_poll_scores', { p_poll_id: source.pollId })
        : openPollRpc('open_poll_scores', { p_poll_id: source.pollId })
    request.then(({ data, error }) => {
      if (cancelled || error) return
      const { value } = parseAnswer(optionScoresSchema, 'the scores', data)
      if (value) setRead(value.map(({ id, name }) => ({ id, name })))
    })
    return () => {
      cancelled = true
    }
  }, [whole, source.kind, source.pollId])

  return whole ? results.options.map(({ id, name }) => ({ id, name })) : read
}
