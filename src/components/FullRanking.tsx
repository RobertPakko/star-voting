import { useEffect, useState } from 'react'
import { Badge, Button, Group, Modal, Stack, Text } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { supabase } from '../lib/supabase'
import { openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { countBadge } from '../lib/badgeColors'
import { recall, remember } from '../lib/settled'
import type { PollResults, RankingEntry, Tiebreak } from '../lib/types'
import { RankingSkeleton } from './Skeletons'
import { voters } from '../lib/plural'

/**
 * Which ranking endpoint to read. Same split as ResultsSource and
 * BallotsSource, and for the same reason: a session proves the caller's
 * right to an invite poll, the share token proves it for an open one.
 */
export type RankingSource = { kind: 'poll'; pollId: string } | { kind: 'token'; token: string }

/**
 * The whole field in placed order, behind a button.
 *
 * Kept out of the results page proper because most polls only ever need
 * their winner; but "what were the top three" is a real question, and the
 * score round on its own doesn't answer it: the score order ignores the
 * runoffs, which is exactly the part STAR adds.
 *
 * **Fetched when the button is pressed, not with the tally that drew it.**
 * STAR names one winner in one round; ordering the rest takes a round per
 * place, each one re-reading every ballot, and it is far and away the most
 * expensive thing this app asks a database for -- a tally that took 48ms on
 * ten options and a hundred voters takes 8ms without it, and one that took
 * 527ms on fifty options takes 19ms. Almost nobody presses the button, so
 * almost nobody should pay for it. The cost of the split is that whoever does
 * press it waits, and pays for the head round twice: first place is part of
 * the ranking, so `poll_ranking` runs it again rather than being handed it.
 * See AGENTS.md, "Results and the full ranking", for the measurements.
 *
 * The answer is cached for the life of the tab like the tally is -- a poll
 * whose results are out has taken its last vote -- so the wait is once per
 * reader, not once per opening.
 */
export function FullRanking({ source, results }: { source: RankingSource; results: PollResults }) {
  const [opened, modal] = useDisclosure(false)

  // Flattened to primitives so the dependency list is complete without
  // depending on a fresh object identity every render.
  const kind = source.kind
  const key = source.kind === 'poll' ? source.pollId : source.token
  const rpc = kind === 'poll' ? 'get_poll_ranking' : 'open_poll_ranking'

  const [ranking, setRanking] = useState<RankingEntry[] | null>(
    () => recall<RankingEntry[]>(rpc, key) ?? null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // The whole point of the split: nothing is asked for until somebody
    // asks for it.
    if (!opened) return

    const cached = recall<RankingEntry[]>(rpc, key)
    if (cached) {
      setRanking(cached)
      return
    }

    // Cleared rather than left standing, so closing a failed modal and
    // opening it again is a retry rather than a replay.
    setError(null)

    let cancelled = false

    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_ranking', { p_poll_id: key })
        : openPollRpc('open_poll_ranking', { p_token: key })

    request.then(({ data, error: rpcError }) => {
      // Remembered whether or not this component still wants it: the answer
      // is about the poll, not about who asked.
      if (!rpcError) remember(rpc, key, data)
      if (cancelled) return
      if (rpcError) setError(rpcError.message)
      else setRanking(data as RankingEntry[])
    })

    return () => {
      cancelled = true
    }
  }, [opened, kind, key, rpc])

  // With two options the ranking is the winner and the option it beat, both
  // already on screen; with one there is nothing to order. Decided from the
  // options the tally already carries, so the button never waits on a
  // request to find out whether it should exist.
  if (results.options.length < 3) return null

  return (
    <>
      <Group justify="center">
        <Button variant="subtle" size="compact-sm" onClick={modal.open}>
          See the full ranking
        </Button>
      </Group>

      <Modal opened={opened} onClose={modal.close} title="Full ranking" size="lg" centered>
        <Stack gap="lg">
          <Text size="sm" c="dimmed">
            STAR names one winner. To order the rest, the method runs again on the options left
            standing: the winner steps out, the two highest scorers remaining go to a runoff for the
            next place, and so on down the list.
          </Text>

          {error && (
            <Text c="red" size="sm">
              {error}
            </Text>
          )}

          {!error && !ranking && <RankingSkeleton places={results.options.length} />}

          {ranking && <Places ranking={ranking} results={results} />}
        </Stack>
      </Modal>
    </>
  )
}

function Places({ ranking, results }: { ranking: RankingEntry[]; results: PollResults }) {
  const nameById = new Map(results.options.map((o) => [o.id, o.name]))

  return (
    <Stack gap="md">
      {ranking.map((entry) => (
        <Place key={entry.place} entry={entry} results={results} nameById={nameById} />
      ))}
    </Stack>
  )
}

function Place({
  entry,
  results,
  nameById,
}: {
  entry: RankingEntry
  results: PollResults
  nameById: Map<string, string>
}) {
  const total = entry.options[0].total_score

  // Standard competition rank on score alone, so options level on points
  // share a number. Shown only where it disagrees with the placing; which
  // is the whole reason this ranking isn't just the score round re-sorted.
  const scoreRank = 1 + results.options.filter((o) => o.total_score > total).length

  return (
    <Group align="flex-start" wrap="nowrap" gap="sm">
      <Badge {...countBadge} size="lg">
        {entry.place}
      </Badge>
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Group gap="xs" wrap="nowrap">
          <Text fw={600} truncate>
            {entry.options.map((o) => o.name).join(' and ')}
          </Text>
          <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {total} pts
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
  const rule =
    tb.resolved_by === 'head_to_head'
      ? 'head-to-head preference'
      : tb.resolved_by === 'five_star_votes'
        ? 'five-star votes'
        : 'a random draw'

  return (
    <>
      {tb.tied.map((t, index) => (
        <span key={t.id}>
          {index > 0 && ' and '}
          <strong>{t.name}</strong>
        </span>
      ))}{' '}
      tied at {tb.tied_at} pts for the runoff;{' '}
      {tb.advanced.map((a, index) => (
        <span key={a.id}>
          {index > 0 && ', '}
          <strong>{a.name}</strong>
        </span>
      ))}{' '}
      advanced on {rule}.
    </>
  )
}
