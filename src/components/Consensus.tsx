import { useEffect, useState } from 'react'
import { ActionIcon, Group, Stack, Text, Tooltip } from '@mantine/core'
import { XIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { isSampleId, openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { formatWindow, relabelScores } from '../lib/schedule'
import { consensusSchema, parseAnswer } from '../lib/rpcSchemas'
import { use24HourTime } from '../lib/clock'
import { count, stars } from '../lib/plural'
import { ChoiceModal } from './ChoiceBlurb'
import { SCORING_ROWS_MAX } from '../lib/resultsRows'
import type { MeetingEvent } from '../lib/calendarEvent'
import type { ConsensusResult, PollResults } from '../lib/types'
import type { RankingSource } from './FullRanking'
import { RemovedOptions, type LeftOut } from './RemovedOptions'
import { AddToCalendar } from './AddToCalendar'
import { CoinFlip } from './CoinFlip'
import { levelOptions } from '../lib/consensus'
import { useLeftOut } from '../lib/useLeftOut'
import { ScoresSkeleton } from './Skeletons'

/**
 * The consensus option (or time), opened from the result's *More results*
 * menu (`MoreResults`), or drawn on the results page where the question chose
 * it (`ChosenResult`): the option whose lowest score is highest, options
 * sharing it compared on their next-lowest score, then the next. For a
 * choice everyone has to live with. `/choices` explains it, and
 * `poll_consensus` works it out.
 *
 * **Options level on every score leave no winner**, and the card offers the
 * coin (`CoinFlip`) between them, as STAR's *No winner* does.
 *
 * **An option can be taken out**, as in `MultipleWinners`: each removal asks
 * the database to count again as though that option had never been on the
 * ballot. Removals are the reader's alone and never stored. **The sample
 * cannot remove**: it answers from a recording.
 */
export function Consensus({
  source,
  results,
  opened,
  onClose,
}: {
  source: RankingSource
  /** Already relabelled by Results on a time poll; see relabelResults. */
  results: PollResults
  opened: boolean
  onClose: () => void
}) {
  // Held here rather than in the body, which is mounted only while open.
  const [leftOut, setLeftOut] = useLeftOut(source.pollId)

  return (
    <ChoiceModal kind="consensus" calendar={results.calendar} opened={opened} onClose={onClose}>
      <ConsensusBody source={source} results={results} leftOut={leftOut} onLeftOut={setLeftOut} />
    </ChoiceModal>
  )
}

/**
 * The consensus itself, in the modal or on the results page. Handed the
 * answer the tally carried (`initial`), it asks for nothing until an option
 * is removed. `eventFor` turns a time poll's winner into a calendar event.
 */
export function ConsensusBody({
  source,
  results,
  initial = null,
  leftOut,
  onLeftOut,
  eventFor,
  bannered = false,
}: {
  source: RankingSource
  results: PollResults
  initial?: ConsensusResult | null
  leftOut: LeftOut[]
  onLeftOut: (next: LeftOut[]) => void
  eventFor?: (id: string) => MeetingEvent | null
  /**
   * Drawn under the results page's bar, which already names the winner the
   * tally carried: the body names one only once an option is removed.
   */
  bannered?: boolean
}) {
  const h24 = use24HourTime()
  const kind = source.kind
  const key = source.pollId
  const sample = isSampleId(key)

  const [consensus, setConsensus] = useState<ConsensusResult | null>(
    leftOut.length === 0 ? initial : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Sorted, so the same set asked for twice is the same request.
  const excludedKey = leftOut
    .map((o) => o.id)
    .sort()
    .join(',')

  useEffect(() => {
    setError(null)
    // Nothing removed: the answer the tally carried is the answer.
    if (!excludedKey && initial) {
      setConsensus(initial)
      setLoading(false)
      return
    }

    setLoading(true)
    let cancelled = false

    const excluded = excludedKey ? excludedKey.split(',') : []
    const args = { p_poll_id: key, p_excluded: excluded }
    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_consensus', args)
        : openPollRpc('open_poll_consensus', args)

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      setLoading(false)
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(consensusSchema, 'the consensus', data)
      if (value) setConsensus(value)
      else setError(shape)
    })

    return () => {
      cancelled = true
    }
  }, [kind, key, excludedKey, initial])

  const remaining = results.option_count - leftOut.length
  // With two left there is still a choice; below that there is none.
  const canRemove = !sample && remaining > 2

  const remove = (option: LeftOut) => onLeftOut([...leftOut, option])
  const restore = (id: string) => onLeftOut(leftOut.filter((o) => o.id !== id))

  return (
    <Stack gap="md">
      {!sample && (
        <Text size="sm" c="dimmed">
          If an option is not available then remove the option to see the recalculated result.
        </Text>
      )}

      <RemovedOptions leftOut={leftOut} onRestore={restore} onRestoreAll={() => onLeftOut([])} />

      {error && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}

      {!error && !consensus && (
        <ScoresSkeleton rows={Math.min(results.option_count, SCORING_ROWS_MAX)} />
      )}

      {consensus && (
        <Stack
          gap="md"
          aria-busy={loading}
          style={{
            opacity: loading ? 0.5 : 1,
            transition: 'opacity var(--motion-fast)',
          }}
        >
          <Answer
            consensus={consensus}
            h24={h24}
            removable={canRemove && !loading}
            onRemove={remove}
            eventFor={eventFor}
            named={!bannered || leftOut.length > 0}
            pollId={key}
          />
        </Stack>
      )}
    </Stack>
  )
}

const ORDINALS = ['second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth']

/** Lowest, second-lowest, third-lowest, … 10th-lowest, 21st-lowest. */
function lowest(position: number): string {
  if (position === 1) return 'lowest'
  if (position < 10) return `${ORDINALS[position - 2]}-lowest`
  const teen = position % 100 >= 11 && position % 100 <= 13
  const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][position % 10] ?? 'th')
  return `${position}${suffix}-lowest`
}

/** The winner, how it was reached, and every option's lowest score. */
function Answer({
  consensus,
  h24,
  removable,
  onRemove,
  eventFor,
  named,
  pollId,
}: {
  consensus: ConsensusResult
  h24: boolean
  removable: boolean
  onRemove: (option: LeftOut) => void
  eventFor?: (id: string) => MeetingEvent | null
  named: boolean
  /** What the coin is seeded on, where options are level; see coinFlip. */
  pollId: string
}) {
  const options = relabelScores(consensus.options, h24)
  const { winner_id: winnerId, floor, tied_count: tied, decided_at: at } = consensus
  const winner = options.find((o) => o.id === winnerId)
  const event = winnerId && eventFor ? eventFor(winnerId) : null
  const level = levelOptions(consensus, h24)
  const runnerUp = consensus.runner_up
  const unshown = consensus.option_count - options.length

  return (
    <>
      {!named ? null : winner ? (
        <Group justify="space-between" align="center" gap="sm">
          <Text fw={700} size="lg" style={{ overflowWrap: 'anywhere' }}>
            {winner.name}
          </Text>
          {event && <AddToCalendar event={event} />}
        </Group>
      ) : (
        <Group justify="space-between" align="center" gap="sm">
          <Text fw={700} size="lg">
            No winner
          </Text>
          {level.length >= 2 && <CoinFlip pollId={pollId} finalists={level} eventFor={eventFor} />}
        </Group>
      )}

      <Stack gap={4}>
        {tied === 1 && winner && (
          <Text size="sm">
            <strong>{winner.name}</strong> had the highest minimum score at {stars(floor)}.
          </Text>
        )}
        {tied > 1 && (
          <Text size="sm">
            {tied === consensus.option_count
              ? `Every option was given at least ${stars(floor)} by everyone`
              : `${count(tied, 'option')} were given at least ${stars(floor)} by everyone`}
            , so their next-lowest scores were compared.
          </Text>
        )}
        {winner && at !== null && at > 1 && runnerUp && consensus.winner_score !== null && (
          <Text size="sm">
            <strong>{winner.name}</strong> pulled ahead on its {lowest(at)} score:{' '}
            {stars(consensus.winner_score)} to {formatWindow(runnerUp.name, h24)}&rsquo;s{' '}
            {runnerUp.score}.
          </Text>
        )}
        {level.length >= 2 && (
          <Text size="sm">
            {level.length === consensus.option_count
              ? 'Every option was'
              : `${count(level.length, 'option')} were`}{' '}
            given exactly the same scores, so there is no winner.
          </Text>
        )}
      </Stack>

      <Stack gap={4}>
        <Group gap="sm" wrap="nowrap">
          <Text size="xs" c="dimmed" style={{ flex: 1 }}>
            Option
          </Text>
          <Text size="xs" c="dimmed">
            Fewest stars
          </Text>
          {/* Keeps the column over the numbers when rows carry a remove button. */}
          {removable && <span style={{ width: 22, flexShrink: 0 }} />}
        </Group>
        <Stack component="ul" gap={4} m={0} p={0} style={{ listStyle: 'none' }}>
          {options.map((o) => (
            <Group component="li" key={o.id} gap="sm" wrap="nowrap" align="center">
              <Text
                fw={o.id === winnerId ? 700 : 400}
                style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
              >
                {o.name}
              </Text>
              <Text size="sm" style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                {o.floor}
              </Text>
              {removable && (
                <Tooltip label="Remove and count again">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label={`Remove ${o.name}`}
                    onClick={() => onRemove({ id: o.id, name: o.name })}
                  >
                    <XIcon size={14} aria-hidden />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          ))}
        </Stack>
        {unshown > 0 && (
          <Text size="sm" c="dimmed">
            The top {options.length} of {consensus.option_count} options.
          </Text>
        )}
      </Stack>
    </>
  )
}
