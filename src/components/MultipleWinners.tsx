import { useEffect, useState } from 'react'
import { ActionIcon, Anchor, Badge, Group, Modal, Stack, Text, Tooltip } from '@mantine/core'
import { XIcon } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { isSampleId, openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { countBadge } from '../lib/badgeColors'
import { relabelRanking } from '../lib/schedule'
import { parseAnswer, rankingSchema } from '../lib/rpcSchemas'
import { use24HourTime } from '../lib/clock'
import type { PollResults, RankingEntry } from '../lib/types'
import { RankingSkeleton } from './Skeletons'
import { count } from '../lib/plural'
import { SCORING_ROWS_MAX } from '../lib/resultsRows'
import { TiebreakNote, type RankingSource } from './FullRanking'
import { RemovedOptions, type LeftOut } from './RemovedOptions'

/**
 * Several winners from one set of ballots, opened from the result's *More
 * results* menu (`MoreResults`): a ranking of its own, a STAR election per
 * spot, with each ballot counting at 1 ÷ (1 + SUM ÷ 5) for the stars SUM it
 * gave the winners before (runoffs included). The first spot is the STAR
 * winner; take as many from the top as are needed. `/choices` explains it,
 * and `poll_multiple_winners` counts it.
 *
 * **An option can be taken out**, as many as the reader likes, one after
 * another: the place that is shut, the film nobody can stream. Each removal
 * asks the database to count again as though that option had never been on
 * the ballot, since the browser does not hold the ballots. Removals are the
 * reader's alone, never stored, and kept while this poll's results stay on
 * screen, so closing the modal by accident loses nothing.
 *
 * Fetched when opened, and the answer is not held, for the same reason as
 * `FullRanking`: the count is a STAR round per spot, and the votes under it
 * can move unannounced.
 *
 * **The sample cannot remove**: it answers from a recording
 * (`samplePollData.ts`), which holds the count with nothing taken out.
 */
export function MultipleWinners({
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
  const h24 = use24HourTime()
  const kind = source.kind
  const key = source.pollId
  const sample = isSampleId(key)

  const [leftOut, setLeftOut] = useState<LeftOut[]>([])
  const [spots, setSpots] = useState<RankingEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Another poll's removals mean nothing here.
  const [leftOutFor, setLeftOutFor] = useState(key)
  if (leftOutFor !== key) {
    setLeftOutFor(key)
    setLeftOut([])
    setSpots(null)
  }

  // Sorted, so the same set asked for twice is the same request.
  const excludedKey = leftOut
    .map((o) => o.id)
    .sort()
    .join(',')

  useEffect(() => {
    if (!opened) return

    setError(null)
    setLoading(true)
    let cancelled = false

    const excluded = excludedKey ? excludedKey.split(',') : []
    const args = { p_poll_id: key, p_excluded: excluded }
    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_multiple_winners', args)
        : openPollRpc('open_poll_multiple_winners', args)

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      setLoading(false)
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(rankingSchema, 'the winners', data)
      if (value) setSpots(value)
      else setError(shape)
    })

    return () => {
      cancelled = true
    }
  }, [opened, kind, key, excludedKey])

  const remaining = results.option_count - leftOut.length
  // Below two there is nothing left to choose several of.
  const canRemove = !sample && remaining > 2

  const remove = (option: LeftOut) => setLeftOut((list) => [...list, option])
  const restore = (id: string) => setLeftOut((list) => list.filter((o) => o.id !== id))

  const shown = spots && relabelRanking(spots, h24)
  const placed = shown ? shown.reduce((sum, spot) => sum + spot.options.length, 0) : 0

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      centered
      title={<Text fw={600}>Multiple winners</Text>}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          For choosing several options at once, so that different groups of voters each get one they
          like. Take as many from the top as you need.{' '}
          <Anchor component={Link} to="/choices?section=multiple-winners" inherit>
            How it works
          </Anchor>
        </Text>

        {!sample && (
          <Text size="sm" c="dimmed">
            If an option is not available, remove it and the winners are counted again without it.
          </Text>
        )}

        <RemovedOptions leftOut={leftOut} onRestore={restore} onRestoreAll={() => setLeftOut([])} />

        {error && (
          <Text role="alert" c="red" size="sm">
            {error}
          </Text>
        )}

        {!error && !shown && (
          <RankingSkeleton places={Math.min(results.option_count, SCORING_ROWS_MAX)} />
        )}

        {shown && (
          <Stack
            gap="md"
            aria-busy={loading}
            style={{
              opacity: loading ? 0.5 : 1,
              transition: 'opacity var(--motion-fast)',
            }}
          >
            {shown.map((spot) => (
              <Spot
                key={spot.place}
                spot={spot}
                removable={canRemove && !loading}
                onRemove={remove}
              />
            ))}
          </Stack>
        )}

        {shown && !loading && remaining - placed > 0 && (
          <Text size="sm" c="dimmed">
            {count(remaining - placed, 'more option')} not placed.
          </Text>
        )}
      </Stack>
    </Modal>
  )
}

/** A weighted count as the page writes it: whole, or to `places` decimal places. */
const figure = (n: number, places = 1) => String(Math.round(n * 10 ** places) / 10 ** places)

/**
 * The fewest decimal places (from one) at which a runoff's two sides read
 * differently, so a close win is never written as "2.5 to 2.5" — which reads
 * as a tie with no tie-break. The database rounds weighted counts to six
 * places, so sides that differ do so by then.
 */
function placesApart(a: number, b: number) {
  let places = 1
  while (places < 6 && figure(a, places) === figure(b, places)) places++
  return places
}

const weightedStars = (n: number) => `${figure(n)} ${n === 1 ? 'star' : 'stars'}`
const weightedVotes = (n: number, places = 1) =>
  `${figure(n, places)} ${n === 1 ? 'vote' : 'votes'}`

function Spot({
  spot,
  removable,
  onRemove,
}: {
  spot: RankingEntry
  removable: boolean
  onRemove: (option: LeftOut) => void
}) {
  return (
    <Group align="flex-start" wrap="nowrap" gap="sm">
      <Badge {...countBadge} size="lg">
        {spot.place}
      </Badge>
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        {spot.options.map((option) => (
          <Group key={option.id} gap="xs" wrap="nowrap" align="center">
            <Text fw={600} style={{ overflowWrap: 'anywhere' }}>
              {option.name}
            </Text>
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {weightedStars(option.total_score)}
            </Text>
            {removable && (
              <Tooltip label="Remove and count again">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  ml="auto"
                  aria-label={`Remove ${option.name}`}
                  onClick={() => onRemove({ id: option.id, name: option.name })}
                >
                  <XIcon size={14} aria-hidden />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        ))}

        <Text size="sm" c="dimmed">
          {decision(spot)}
        </Text>

        {spot.tiebreaks.map((tb, i) => (
          <Text key={i} size="sm" c={tb.resolved_by === 'random' ? 'orange' : 'dimmed'}>
            <TiebreakNote tiebreak={{ ...tb, tied_at: Math.round(tb.tied_at * 10) / 10 }} />
          </Text>
        ))}
      </Stack>
    </Group>
  )
}

/** How this spot was settled, in one line, in weighted votes. */
function decision(spot: RankingEntry) {
  const { runoff, finalists, finalist_names, options } = spot

  if (!runoff || finalists.length < 2) return 'The last option standing.'

  if (runoff.resolved_by === 'unresolved') {
    return (
      <>Tied: {weightedVotes(runoff.prefers_a)} each way, on identical scores. They share it.</>
    )
  }

  const placed = options[0].id
  const other = (placed === finalists[0] ? finalist_names[1] : finalist_names[0]) ?? 'the other'
  const [won, lost] =
    placed === finalists[0]
      ? [runoff.prefers_a, runoff.prefers_b]
      : [runoff.prefers_b, runoff.prefers_a]

  if (runoff.resolved_by === 'higher_score') {
    return (
      <>
        Level with <strong>{other}</strong> at {weightedVotes(won)} each; placed above it on the
        higher score.
      </>
    )
  }

  if (runoff.resolved_by === 'five_star_votes') {
    return (
      <>
        Level with <strong>{other}</strong> at {weightedVotes(won)} each and on score; placed above
        it on five-star votes.
      </>
    )
  }

  const places = placesApart(won, lost)
  return (
    <>
      Preferred over <strong>{other}</strong> by {weightedVotes(won, places)} to{' '}
      {figure(lost, places)}.
    </>
  )
}
