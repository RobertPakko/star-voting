import { useEffect, useState } from 'react'
import { Anchor, Badge, Group, Modal, Stack, Text } from '@mantine/core'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { countBadge } from '../lib/badgeColors'
import { relabelRanking } from '../lib/schedule'
import { parseAnswer, rankingSchema } from '../lib/rpcSchemas'
import { use24HourTime } from '../lib/clock'
import type { PollResults, RankingEntry, Tiebreak } from '../lib/types'
import { NameList } from './NameList'
import { RankingSkeleton } from './Skeletons'
import { stars, voters } from '../lib/plural'
import { splitAdvanced } from '../lib/tiebreak'

/**
 * Which ranking endpoint to read. Same split as ResultsSource and
 * BallotsSource, and for the same reason: a session proves the caller's
 * right to an invite poll, the link proves it for an open one.
 */
type RankingSource = { kind: 'poll'; pollId: string } | { kind: 'open'; pollId: string }

/**
 * The whole field in placed order, opened from the result's *More results*
 * menu (`MoreResults`).
 *
 * Kept out of the results page proper because most polls only ever need
 * their winner; but "who do we go with if the winner falls through" is a real
 * question, and the score round on its own doesn't answer it: the score order
 * ignores the runoffs, which is exactly the part STAR adds.
 *
 * **Fetched when the button is pressed, not with the tally that drew it.**
 * STAR names one winner in one round; ordering the rest takes a round per
 * place, each re-reading every ballot, and it is far and away the most
 * expensive thing this app asks a database for — a tally that took 48ms on ten
 * options and a hundred voters takes 8ms without it, and one that took 527ms
 * on fifty options takes 19ms. Almost nobody presses the button, so almost
 * nobody should pay for it. See AGENTS.md, "Results and the full ranking".
 *
 * The answer is not held on to, because the votes under it can move: a
 * creator can open a closed poll again, or correct its options over the votes
 * already in it, and neither is announced to whoever is reading the ranking.
 * So the wait is once per opening rather than once per reader.
 */
export function FullRanking({
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

  // Flattened to primitives so the dependency list is complete without
  // depending on a fresh object identity every render.
  const kind = source.kind
  const key = source.pollId

  const [ranking, setRanking] = useState<RankingEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // The whole point of the split: nothing is asked for until somebody
    // asks for it.
    if (!opened) return

    // Cleared rather than left standing, so closing a failed modal and
    // opening it again is a retry rather than a replay.
    setError(null)

    let cancelled = false

    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_ranking', { p_poll_id: key })
        : openPollRpc('open_poll_ranking', { p_poll_id: key })

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(rankingSchema, 'the ranking', data)
      if (value) setRanking(value)
      else setError(shape)
    })

    return () => {
      cancelled = true
    }
  }, [opened, kind, key])

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      centered
      title={<Text fw={600}>Full ranking</Text>}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Every option in order, for when the winner falls through.{' '}
          <Anchor component={Link} to="/extensions?section=full-ranking" inherit>
            How it works
          </Anchor>
        </Text>

        {error && (
          <Text role="alert" c="red" size="sm">
            {error}
          </Text>
        )}

        {!error && !ranking && <RankingSkeleton places={results.options.length} />}

        {ranking && <Places ranking={relabelRanking(ranking, h24)} results={results} />}
      </Stack>
    </Modal>
  )
}

function Places({ ranking, results }: { ranking: RankingEntry[]; results: PollResults }) {
  const nameById = new Map(results.options.map((o) => [o.id, o.name]))

  return (
    <Stack gap="md">
      {ranking.map((entry) => (
        <Place key={entry.place} entry={entry} nameById={nameById} />
      ))}
    </Stack>
  )
}

function Place({ entry, nameById }: { entry: RankingEntry; nameById: Map<string, string> }) {
  const total = entry.options[0].total_score

  return (
    <Group align="flex-start" wrap="nowrap" gap="sm">
      <Badge {...countBadge} size="lg">
        {entry.place}
      </Badge>
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        {/* Wrapped, never cut short: a shared place names every option in it,
            and the second name is the one a reader opened this to learn. */}
        <Group gap="xs" wrap="nowrap" align="baseline">
          <Text fw={600} style={{ overflowWrap: 'anywhere' }}>
            {entry.options.map((o) => o.name).join(' and ')}
          </Text>
          <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {stars(total)}
          </Text>
        </Group>

        <Text size="sm" c="dimmed">
          {decision(entry, nameById)}
        </Text>

        {entry.tiebreaks.map((tb, i) => (
          <Text key={i} size="sm" c={tb.resolved_by === 'random' ? 'orange' : 'dimmed'}>
            {tiebreakNote(tb)}
          </Text>
        ))}
      </Stack>
    </Group>
  )
}

/** How this place was settled, in one line. */
function decision(entry: RankingEntry, nameById: Map<string, string>) {
  const { runoff, finalists, options } = entry

  if (!runoff || finalists.length < 2) {
    return 'The last option standing.'
  }

  if (runoff.resolved_by === 'unresolved') {
    return (
      <>Genuinely tied: {voters(runoff.prefers_a)} preferred each, on identical score totals.</>
    )
  }

  const placed = options[0].id
  const other = nameById.get(placed === finalists[0] ? finalists[1] : finalists[0]) ?? 'the other'
  const [won, lost] =
    placed === finalists[0]
      ? [runoff.prefers_a, runoff.prefers_b]
      : [runoff.prefers_b, runoff.prefers_a]

  if (runoff.resolved_by === 'higher_score') {
    return (
      <>
        Level with <strong>{other}</strong> at {voters(won)} each; placed above it on the higher
        score total.
      </>
    )
  }

  if (runoff.resolved_by === 'five_star_votes') {
    return (
      <>
        Level with <strong>{other}</strong> at {voters(won)} each and on score; placed above it on
        five-star votes.
      </>
    )
  }

  return (
    <>
      Preferred over <strong>{other}</strong> by {voters(won)} to {lost}.
    </>
  )
}

/** A tie for this place's runoff slots, and what broke it. */
function tiebreakNote(tb: Tiebreak) {
  const tied = (
    <>
      <NameList names={tb.tied} /> tied at {stars(tb.tied_at)} for the runoff;{' '}
    </>
  )

  if (tb.resolved_by !== 'random') {
    const rule = tb.resolved_by === 'head_to_head' ? 'head-to-head preference' : 'five-star votes'
    return (
      <>
        {tied}
        <NameList names={tb.advanced} /> advanced on {rule}.
      </>
    )
  }

  const { earned, drawn } = splitAdvanced(tb)
  return (
    <>
      {tied}
      {earned.length > 0 && (
        <>
          <NameList names={earned} /> advanced on five-star votes and{' '}
        </>
      )}
      <NameList names={drawn} /> {earned.length > 0 ? 'on' : 'advanced on'} a random draw.
    </>
  )
}
