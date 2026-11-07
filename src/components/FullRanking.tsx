import { useEffect, useState } from 'react'
import { Badge, Group, Stack, Text } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { countBadge } from '../lib/badgeColors'
import { relabelRanking } from '../lib/schedule'
import { parseAnswer, rankingSchema } from '../lib/rpcSchemas'
import { use24HourTime } from '../lib/clock'
import { CHOICE_NUMBER, cutTo } from '../lib/choices'
import type { PollResults, RankingEntry, Tiebreak } from '../lib/types'
import { ChoiceCount } from './ChoiceCount'
import { ChoiceModal } from './ChoiceBlurb'
import { NameList } from './NameList'
import { RankingSkeleton } from './Skeletons'
import { count, stars, voters } from '../lib/plural'
import { SCORING_ROWS_MAX } from '../lib/resultsRows'
import { splitAdvanced } from '../lib/tiebreak'

/**
 * Which ranking endpoint to read. Same split as ResultsSource and
 * BallotsSource, and for the same reason: a session proves the caller's
 * right to an invite poll, the link proves it for an open one.
 */
export type RankingSource = { kind: 'poll'; pollId: string } | { kind: 'open'; pollId: string }

/**
 * The whole field in placed order, opened from the result's *More results*
 * menu (`MoreResults`), or drawn on the results page itself where the
 * question chose it (`ChosenResult`).
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
 * nobody should pay for it — unless the poll chose the ranking, when the tally
 * carries it. See AGENTS.md, "Results and the option ranking".
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
  return (
    <ChoiceModal kind="ranking" opened={opened} onClose={onClose}>
      {/* Mounted only while open, so the read is made on the press. */}
      <RankingBody source={source} results={results} />
    </ChoiceModal>
  )
}

/**
 * The ranking itself, in the modal or, on a question that chose it, on the
 * results page (`ChosenResult`), handed the ranking the tally carried
 * (`initial`) so it asks for nothing. Only the results page offers a number
 * of places (`counted`), opening on the poll's own; the modal shows them all,
 * since a reader who went looking for the ranking wants the whole of it.
 */
export function RankingBody({
  source,
  results,
  initial = null,
  counted = false,
}: {
  source: RankingSource
  results: PollResults
  initial?: RankingEntry[] | null
  counted?: boolean
}) {
  const h24 = use24HourTime()

  // Flattened to primitives so the dependency list is complete without
  // depending on a fresh object identity every render.
  const kind = source.kind
  const key = source.pollId
  const given = initial !== null

  const [ranking, setRanking] = useState<RankingEntry[] | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const [places, setPlaces] = useState(
    counted && results.kind === 'ranking' ? results.kind_value : null,
  )

  useEffect(() => {
    // The whole point of the split: nothing is asked for until somebody
    // asks for it, and a ranking the tally carried is not asked for again.
    if (given) return

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
  }, [given, kind, key])

  const shown = ranking && cutTo(ranking, places)

  return (
    <Stack gap="md">
      {counted && (
        <ChoiceCount
          label={CHOICE_NUMBER.ranking!.label}
          value={places}
          optionCount={results.option_count}
          onChange={setPlaces}
        />
      )}

      {error && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}

      {!error && !shown && (
        <RankingSkeleton places={Math.min(results.option_count, places ?? SCORING_ROWS_MAX)} />
      )}

      {shown && <Places ranking={relabelRanking(shown, h24)} />}

      {shown && unplaced(shown, results.option_count) > 0 && (
        <Text size="sm" c="dimmed">
          {count(unplaced(shown, results.option_count), 'more option')} not placed.
        </Text>
      )}
    </Stack>
  )
}

/** How many options the ladder stopped before reaching (`poll_results_rows()`). */
const unplaced = (ranking: RankingEntry[], optionCount: number) =>
  optionCount - ranking.reduce((sum, entry) => sum + entry.options.length, 0)

function Places({ ranking }: { ranking: RankingEntry[] }) {
  return (
    <Stack gap="md">
      {ranking.map((entry) => (
        <Place key={entry.place} entry={entry} />
      ))}
    </Stack>
  )
}

function Place({ entry }: { entry: RankingEntry }) {
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
          {decision(entry)}
        </Text>

        {entry.tiebreaks.map((tb, i) => (
          <Text
            key={i}
            size="sm"
            c={tb.resolved_by === 'random' ? 'var(--mantine-color-orange-light-color)' : 'dimmed'}
          >
            <TiebreakNote tiebreak={tb} />
          </Text>
        ))}
      </Stack>
    </Group>
  )
}

/** How this place was settled, in one line. */
function decision(entry: RankingEntry) {
  const { runoff, finalists, finalist_names, options } = entry

  if (!runoff || finalists.length < 2) {
    return 'The last option standing.'
  }

  if (runoff.resolved_by === 'unresolved') {
    return (
      <>Genuinely tied: {voters(runoff.prefers_a)} preferred each, on identical score totals.</>
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
export function TiebreakNote({ tiebreak: tb }: { tiebreak: Tiebreak }) {
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
