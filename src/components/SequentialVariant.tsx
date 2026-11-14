import { useEffect, useState } from 'react'
import { Button, Group, NumberInput, SegmentedControl, Stack, Text } from '@mantine/core'
import { CalculatorIcon, PencilSimpleIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { ballotSheetSchema, parseAnswer, rankingSchema } from '../lib/rpcSchemas'
import { GIVEN_MAX } from '../lib/limits'
import { CHOICES } from '../lib/choices'
import { SCORING_ROWS_MAX } from '../lib/resultsRows'
import type { BallotSheet, PollResults, RankingEntry } from '../lib/types'
import { VariantModal } from './ChoiceBlurb'
import { RankingSkeleton } from './Skeletons'
import type { RankingSource } from './FullRanking'
import { Spot } from './MultipleWinners'

/** What STAR decides that a sequential count can answer, as `poll_sequential` takes it. */
type SequentialKind = 'option' | 'ranking' | 'multiple'

const KINDS: SequentialKind[] = ['option', 'ranking', 'multiple']

/**
 * The *Sequential variant*, opened from the result's *More results* menu: the
 * finished question counted as though it had been a sequential poll, with
 * every ballot weighed by the stars its voter gave earlier winners, which the
 * reader types beside each name. `/variants` explains it and `poll_sequential`
 * counts it.
 *
 * **It starts from the published sheet**, one row per ballot in the sheet's
 * order, which is the order the stars are sent in; the sheet names every
 * ballot already, which is why the menu offers this only where ballots are
 * published with names on them, and why weighing one discloses nothing. Two
 * voters who typed one name are two rows. Nothing typed here is stored, and
 * it is held only while the modal is mounted.
 */
export function SequentialVariant({
  source,
  results,
  opened,
  onClose,
}: {
  source: RankingSource
  results: PollResults
  opened: boolean
  onClose: () => void
}) {
  return (
    <VariantModal variant="sequential" opened={opened} onClose={onClose}>
      <SequentialBody source={source} results={results} />
    </VariantModal>
  )
}

function SequentialBody({ source, results }: { source: RankingSource; results: PollResults }) {
  const { kind: door, pollId } = source
  const [sheet, setSheet] = useState<BallotSheet | null>(null)
  const [given, setGiven] = useState<(number | string)[]>([])
  const [kind, setKind] = useState<SequentialKind>('option')
  const [editing, setEditing] = useState(true)
  const [tried, setTried] = useState(false)
  const [counted, setCounted] = useState<RankingEntry[] | null>(null)
  const [countedKind, setCountedKind] = useState<SequentialKind>('option')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const request: PromiseLike<RpcAnswer> =
      door === 'poll'
        ? supabase.rpc('poll_ballots', { p_poll_id: pollId })
        : openPollRpc('open_poll_ballots', { p_poll_id: pollId })
    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(ballotSheetSchema, 'the ballots', data)
      if (!value) return setError(shape)
      setSheet(value)
      // A question that was sequential starts from the stars it was cast with.
      setGiven(value.ballots.map((b) => b.given ?? ''))
    })
    return () => {
      cancelled = true
    }
  }, [door, pollId])

  const problems = given.map((g) => {
    if (g === '') return null
    const n = Number(g)
    return Number.isFinite(n) && n >= 0 && n <= GIVEN_MAX
      ? null
      : `From 0 to ${GIVEN_MAX.toLocaleString('en-US')}.`
  })

  function count() {
    setTried(true)
    if (!sheet || problems.some(Boolean)) return
    const args = {
      p_poll_id: pollId,
      p_kind: kind,
      // A box left empty is a voter who gave earlier winners nothing.
      p_given: given.map((g) => (g === '' ? 0 : Number(g))),
    }
    setEditing(false)
    setLoading(true)
    setError(null)
    const request: PromiseLike<RpcAnswer> =
      door === 'poll'
        ? supabase.rpc('get_poll_sequential', args)
        : openPollRpc('open_poll_sequential', args)
    request.then(({ data, error: rpcError }) => {
      setLoading(false)
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(rankingSchema, 'the sequential count', data)
      if (!value) return setError(shape)
      setCounted(value)
      setCountedKind(kind)
    })
  }

  if (!sheet) {
    return error ? (
      <Text role="alert" c="red" size="sm">
        {error}
      </Text>
    ) : (
      <RankingSkeleton places={Math.min(results.option_count, SCORING_ROWS_MAX)} />
    )
  }

  // The best option is the ranking's first place.
  const shown = counted && countedKind === 'option' ? counted.slice(0, 1) : counted

  return (
    <Stack gap="md">
      {editing ? (
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Type in how many stars each voter gave the winners of earlier polls. The more they gave,
            the less their ballot counts here. Nothing you type is saved.
          </Text>

          <SegmentedControl
            fullWidth
            aria-label="Count as"
            value={kind}
            onChange={(v) => setKind(v as SequentialKind)}
            data={KINDS.map((k) => ({ value: k, label: CHOICES[k].label }))}
          />

          <Stack gap={6}>
            <Text size="sm" fw={500}>
              Stars given to earlier winners
            </Text>
            {sheet.ballots.map((ballot, i) => (
              <Group key={i} gap="sm" wrap="nowrap" align="flex-start">
                <Text size="sm" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }} pt={6}>
                  {ballot.voter ?? `Ballot ${i + 1}`}
                </Text>
                <NumberInput
                  w={120}
                  size="sm"
                  aria-label={`Stars ${ballot.voter ?? `ballot ${i + 1}`} gave earlier winners`}
                  placeholder="0"
                  value={given[i] ?? ''}
                  onChange={(v) => setGiven((prev) => prev.map((g, j) => (j === i ? v : g)))}
                  min={0}
                  max={GIVEN_MAX}
                  allowNegative={false}
                  hideControls
                  error={tried ? problems[i] : null}
                />
              </Group>
            ))}
          </Stack>

          <Group justify="flex-end" gap="xs">
            {counted && (
              <Button variant="default" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
            <Button onClick={count} leftSection={<CalculatorIcon size={16} aria-hidden />}>
              Count
            </Button>
          </Group>
        </Stack>
      ) : (
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
          <Text size="sm" c="dimmed">
            Counted as {CHOICES[countedKind].label.toLowerCase()}, every ballot weighed by the stars
            its voter gave earlier winners.
          </Text>
          <Button
            variant="default"
            size="compact-sm"
            leftSection={<PencilSimpleIcon size={14} aria-hidden />}
            onClick={() => setEditing(true)}
            style={{ flexShrink: 0 }}
          >
            Edit stars
          </Button>
        </Group>
      )}

      {error && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}

      {!editing && !error && !shown && (
        <RankingSkeleton places={Math.min(results.option_count, SCORING_ROWS_MAX)} />
      )}

      {!editing && shown && (
        <Stack
          gap="md"
          aria-busy={loading}
          style={{ opacity: loading ? 0.5 : 1, transition: 'opacity var(--motion-fast)' }}
        >
          {shown.map((spot) => (
            <Spot key={spot.place} spot={spot} removable={false} onRemove={() => {}} />
          ))}
        </Stack>
      )}
    </Stack>
  )
}
