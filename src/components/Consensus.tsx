import { useEffect, useState, type ReactNode } from 'react'
import { ActionIcon, Group, Stack, Text, Tooltip } from '@mantine/core'
import { XIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { isSampleId, openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { formatWindow, relabelScores } from '../lib/schedule'
import { consensusSchema, parseAnswer } from '../lib/rpcSchemas'
import { use24HourTime } from '../lib/clock'
import { count, stars, voters } from '../lib/plural'
import { toolKind } from '../lib/choices'
import { ChoiceModal } from './ChoiceBlurb'
import { SCORING_ROWS_MAX } from '../lib/resultsRows'
import type { MeetingEvent } from '../lib/calendarEvent'
import type { ConsensusResult, PollResults } from '../lib/types'
import type { RankingSource } from './FullRanking'
import { RemovedOptions, type LeftOut } from './RemovedOptions'
import { AddToCalendar } from './AddToCalendar'
import { useLeftOut } from '../lib/useLeftOut'
import { ScoresSkeleton } from './Skeletons'

/**
 * The consensus option (or time), opened from the result's *More results*
 * menu (`MoreResults`), or drawn on the results page where the question chose
 * it (`ChosenResult`): the option whose lowest score is highest, with STAR
 * between the options that share it. For a choice everyone has to live
 * with. `/choices` explains it, and `poll_consensus` works it out.
 *
 * **A ballot giving every option 0 is left out**, and the card says how many
 * were: kept in, it would hold every option's lowest score at 0.
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
    <ChoiceModal kind={toolKind('consensus', results.kind)} opened={opened} onClose={onClose}>
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
          />
        </Stack>
      )}
    </Stack>
  )
}

/** The winner, how it was reached, and every option's lowest score. */
function Answer({
  consensus,
  h24,
  removable,
  onRemove,
  eventFor,
  named,
}: {
  consensus: ConsensusResult
  h24: boolean
  removable: boolean
  onRemove: (option: LeftOut) => void
  eventFor?: (id: string) => MeetingEvent | null
  named: boolean
}) {
  const options = relabelScores(consensus.options, h24)
  const [a, b] = consensus.finalist_names.map((name) => formatWindow(name, h24))
  const { winner_id: winnerId, floor, tied_count: tied } = consensus
  const winner = options.find((o) => o.id === winnerId)
  const event = winnerId && eventFor ? eventFor(winnerId) : null
  const everyone = floor === 0 && tied === consensus.option_count
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
        <Text fw={700} size="lg">
          No winner
        </Text>
      )}

      <Stack gap={4}>
        {tied === 1 && winner && (
          <Text size="sm">
            Nobody gave it fewer than {stars(floor)}, and every other option was given fewer by
            somebody.
          </Text>
        )}
        {tied > 1 && (
          <Text size="sm">
            {everyone
              ? 'Every option was given 0 stars by somebody, so STAR was run between them all.'
              : `${count(tied, 'option')} were given at least ${stars(floor)} by everyone, so STAR was run between them.`}
          </Text>
        )}
        {tied > 1 && a && b && consensus.runoff && (
          <StarSteps consensus={consensus} names={[a, b]} />
        )}
        {consensus.blank_ballots > 0 && (
          <Text size="sm" c="dimmed">
            {count(consensus.blank_ballots, 'ballot')} gave every option 0 stars and{' '}
            {consensus.blank_ballots === 1 ? 'was' : 'were'} left out.
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

/**
 * STAR between the options sharing the floor, told as the option ranking
 * tells a place (`FullRanking`'s `decision`): which two had the most stars,
 * and how the runoff between them was settled.
 */
function StarSteps({
  consensus,
  names: [a, b],
}: {
  consensus: ConsensusResult
  /** The finalists' readable names, in `finalists` order. */
  names: [string, string]
}) {
  const runoff = consensus.runoff!
  const totalOf = (id: string) => consensus.options.find((o) => o.id === id)?.total_score
  const [ta, tb] = consensus.finalists.map(totalOf)
  const aWon = consensus.winner_id === consensus.finalists[0]
  const [won, lost] = aWon ? [a, b] : [b, a]
  const [forWon, forLost] = aWon
    ? [runoff.prefers_a, runoff.prefers_b]
    : [runoff.prefers_b, runoff.prefers_a]
  const [fiveWon, fiveLost] = aWon
    ? [runoff.five_stars_a, runoff.five_stars_b]
    : [runoff.five_stars_b, runoff.five_stars_a]

  let settled: ReactNode
  if (runoff.resolved_by === 'unresolved') {
    settled = (
      <>
        Level at {voters(runoff.prefers_a)} each, on identical score totals and five-star votes, so
        there is no winner.
      </>
    )
  } else if (runoff.resolved_by === 'higher_score') {
    settled = (
      <>
        Level at {voters(forWon)} each; <strong>{won}</strong> won on the higher score total.
      </>
    )
  } else if (runoff.resolved_by === 'five_star_votes') {
    settled = (
      <>
        Level at {voters(forWon)} each and on score; <strong>{won}</strong> won on five-star votes,{' '}
        {fiveWon} to {fiveLost}.
      </>
    )
  } else {
    settled = (
      <>
        <strong>{won}</strong> was preferred over <strong>{lost}</strong> by {voters(forWon)} to{' '}
        {forLost}.
      </>
    )
  }

  return (
    <Stack gap={2}>
      <Text size="sm">
        <strong>Scoring:</strong> {a}
        {ta !== undefined && <> ({stars(ta)})</>} and {b}
        {tb !== undefined && <> ({stars(tb)})</>} had the most stars among them, so they went to the
        runoff.
      </Text>
      <Text size="sm">
        <strong>Runoff:</strong> {settled}
        {runoff.ties > 0 && <> {count(runoff.ties, 'voter')} scored them equally.</>}
      </Text>
    </Stack>
  )
}
