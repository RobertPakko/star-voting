import { useEffect, useState } from 'react'
import { ActionIcon, Button, Group, NumberInput, Select, Stack, Text, Tooltip } from '@mantine/core'
import { CalculatorIcon, PencilSimpleIcon, XIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { isSampleId, openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { assignmentSchema, parseAnswer } from '../lib/rpcSchemas'
import { amountError } from '../lib/pollForm'
import { AMOUNT_MAX } from '../lib/limits'
import { CHOICE_NUMBER, PER_VOTER_NUMBERS } from '../lib/choices'
import { count, stars, voters } from '../lib/plural'
import { SCORING_ROWS_MAX } from '../lib/resultsRows'
import type { AssignmentResult, PollResults } from '../lib/types'
import { ChoiceModal } from './ChoiceBlurb'
import { RankingSkeleton } from './Skeletons'
import type { RankingSource } from './FullRanking'
import { useEveryOption } from '../lib/useEveryOption'
import { RemovedOptions, type LeftOut } from './RemovedOptions'
import { useAssignmentInputs, useLeftOut, type AssignmentInputs } from '../lib/useLeftOut'

/**
 * *Option assignment*, opened from the result's *More results* menu
 * (`MoreResults`), or drawn on the results page where the question chose it
 * (`ChosenResult`): every voter given at most a number of options (one unless
 * the question says otherwise), every option to at most its places, handed
 * out a round at a time so the product of every voter's stars grows as much
 * as it can each round. `/choices` explains it, and `poll_assignment` counts
 * it.
 *
 * **It names who gets what**, so it is offered only on a poll that shows who
 * voted (`offers`). Each voter's stars for their own options are shown only
 * where the poll publishes its ballots; otherwise the count says only how
 * many options went to a voter who gave them each number of stars.
 *
 * **Places and the cap can be given after the fact.** An assignment question
 * has its own (one place, and one option each, where it says nothing); on any
 * other list every option starts with one place and every voter with one
 * option, and the reader can change either and count again. Like removals,
 * they are the reader's alone, never stored, and kept while this poll's
 * results stay on screen.
 *
 * **The sample cannot recount**: it answers from a recording, which holds the
 * count with the question's own places and nothing removed.
 */
export function OptionAssignment({
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
  // Held here rather than in the body, which is mounted only while open.
  const [leftOut, setLeftOut] = useLeftOut(source.pollId)
  const [inputs, setInputs] = useAssignmentInputs(source.pollId)

  return (
    <ChoiceModal kind="assignment" opened={opened} onClose={onClose}>
      <OptionAssignmentBody
        source={source}
        results={results}
        leftOut={leftOut}
        onLeftOut={setLeftOut}
        inputs={inputs}
        onInputs={setInputs}
      />
    </ChoiceModal>
  )
}

/**
 * The count itself, in the modal or on the results page. Handed the count the
 * tally carried (`initial`), it asks for nothing until an option is removed
 * or the places or cap are changed.
 */
export function OptionAssignmentBody({
  source,
  results,
  initial = null,
  leftOut,
  onLeftOut,
  inputs,
  onInputs,
}: {
  source: RankingSource
  results: PollResults
  initial?: AssignmentResult | null
  leftOut: LeftOut[]
  onLeftOut: (next: LeftOut[]) => void
  inputs: AssignmentInputs | null
  onInputs: (next: AssignmentInputs | null) => void
}) {
  const kind = source.kind
  const key = source.pollId
  const sample = isSampleId(key)

  const [result, setResult] = useState<AssignmentResult | null>(
    leftOut.length === 0 && !inputs ? initial : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)

  // Sorted, so the same set asked for twice is the same request.
  const excludedKey = leftOut
    .map((o) => o.id)
    .sort()
    .join(',')
  const inputsKey = inputs ? JSON.stringify(inputs) : ''

  useEffect(() => {
    setError(null)
    // The question's own places with nothing removed: the tally carried it.
    if (!excludedKey && !inputsKey && initial) {
      setResult(initial)
      setLoading(false)
      return
    }

    setLoading(true)
    let cancelled = false

    const typed = inputsKey ? (JSON.parse(inputsKey) as AssignmentInputs) : null
    const args = {
      p_poll_id: key,
      p_excluded: excludedKey ? excludedKey.split(',') : [],
      p_places: typed?.places,
      p_per_voter: typed?.perVoter,
    }
    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_assignment', args)
        : openPollRpc('open_poll_assignment', args)

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      setLoading(false)
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(assignmentSchema, 'the assignment', data)
      if (value) setResult(value)
      else setError(shape)
    })

    return () => {
      cancelled = true
    }
  }, [kind, key, excludedKey, inputsKey, initial])

  const remaining = results.option_count - leftOut.length
  const canRemove = !sample && remaining > 1

  const remove = (option: LeftOut) => onLeftOut([...leftOut, option])
  const restore = (id: string) => onLeftOut(leftOut.filter((o) => o.id !== id))

  const placed = result ? result.voter_count - result.unplaced.length : 0
  // Voters given as many options as they could be.
  const full = result ? placed - result.short.length : 0

  return (
    <Stack gap="md">
      {!sample && !editing && (
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
          <Text size="sm" c="dimmed">
            If an option is not available, remove it and everyone is assigned again without it.
          </Text>
          <Button
            variant="default"
            size="compact-sm"
            leftSection={<PencilSimpleIcon size={14} aria-hidden />}
            onClick={() => setEditing(true)}
            style={{ flexShrink: 0 }}
          >
            Edit places
          </Button>
        </Group>
      )}

      {editing && (
        <PlacesEditor
          source={source}
          results={results}
          leftOut={leftOut}
          start={
            inputs ?? {
              places: Object.fromEntries(
                (result?.options ?? []).map((o) => [o.id, o.places] as const),
              ),
              perVoter: result?.per_voter ?? 1,
            }
          }
          onCount={(next) => {
            onInputs(next)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      {!editing && (
        <RemovedOptions leftOut={leftOut} onRestore={restore} onRestoreAll={() => onLeftOut([])} />
      )}

      {error && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}

      {!editing && !error && !result && (
        <RankingSkeleton places={Math.min(remaining, SCORING_ROWS_MAX)} />
      )}

      {!editing && result && (
        <Stack
          gap="md"
          aria-busy={loading}
          style={{ opacity: loading ? 0.5 : 1, transition: 'opacity var(--motion-fast)' }}
        >
          <Stack gap={2}>
            <Text fw={600}>{summary(result, full)}</Text>
            {placed > 0 && (
              <Text size="sm" c="dimmed">
                {received(result.received, result.per_voter)}
              </Text>
            )}
          </Stack>

          {result.options.map((option) => (
            <Group key={option.id} align="flex-start" wrap="nowrap" gap="sm">
              <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Group gap="xs" wrap="nowrap" align="center">
                  <Text fw={600} style={{ overflowWrap: 'anywhere' }}>
                    {option.name}
                  </Text>
                  <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                    {option.voters.length} of {count(option.places, 'place')}
                  </Text>
                  {canRemove && !loading && (
                    <Tooltip label="Remove and assign again">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        ml="auto"
                        aria-label={`Remove ${option.name}`}
                        onClick={() => remove({ id: option.id, name: option.name })}
                      >
                        <XIcon size={14} aria-hidden />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
                <Text size="sm" c={option.voters.length === 0 ? 'dimmed' : undefined}>
                  {option.voters.length === 0
                    ? 'Nobody'
                    : option.voters
                        .map((v) => (v.stars === undefined ? v.name : `${v.name} (${v.stars})`))
                        .join(', ')}
                </Text>
              </Stack>
            </Group>
          ))}

          {result.short.length > 0 && (
            <Stack gap={2}>
              <Text size="sm" fw={600}>
                Fewer than {count(result.per_voter, 'option')}
              </Text>
              <Text size="sm" c="dimmed">
                {result.short.map((v) => `${v.name} (${v.count})`).join(', ')}
              </Text>
            </Stack>
          )}

          {result.unplaced.length > 0 && (
            <Stack gap={2}>
              <Text size="sm" fw={600}>
                No option
              </Text>
              <Text size="sm" c="dimmed">
                {result.unplaced.map((v) => v.name).join(', ')}
              </Text>
            </Stack>
          )}

          {result.stars_shown && placed > 0 && (
            <Text size="xs" c="dimmed">
              {result.per_voter === 1
                ? 'In brackets, the stars each voter gave their own option.'
                : 'In brackets, the stars each voter gave that option.'}
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  )
}

/**
 * The headline: how many voters have all they could be given, and in how
 * many places. "Every voter has 2 options, in 20 places."
 */
function summary(result: AssignmentResult, full: number) {
  const each = result.per_voter === 1 ? 'an option' : count(result.per_voter, 'option')
  const where = `in ${count(result.places, 'place')}`
  return full === result.voter_count
    ? `Every voter has ${each}, ${where}.`
    : `${full} of ${voters(result.voter_count)} have ${each}, ${where}.`
}

/**
 * How many options went to a voter who gave them each number of stars, best
 * first: "4 voters got an option they gave 5 stars and 2 one they gave 3", or
 * with several each, "12 options went to voters who gave them 5 stars and 6
 * to voters who gave them 4". All a private ballot gives away about how well
 * the assignment went.
 */
function received(counts: Record<string, number>, perVoter: number) {
  const levels = Object.entries(counts)
    .map(([given, n]) => [Number(given), n] as const)
    .sort(([a], [b]) => b - a)
  const parts = levels.map(([given, n], i) =>
    perVoter === 1
      ? i === 0
        ? `${voters(n)} got an option they gave ${stars(given)}`
        : `${n} one they gave ${given}`
      : i === 0
        ? `${count(n, 'option')} went to voters who gave ${n === 1 ? 'it' : 'them'} ${stars(given)}`
        : `${n} to voters who gave ${n === 1 ? 'it' : 'them'} ${given}`,
  )
  const joined =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
  return `${joined}.`
}

/**
 * The reader's places and cap: every option on the ballot (less any
 * removed), a number beside each, the most options a voter is given, and
 * *Count*. A blank box is one place. Nothing typed here is saved.
 */
function PlacesEditor({
  source,
  results,
  leftOut,
  start,
  onCount,
  onCancel,
}: {
  source: RankingSource
  results: PollResults
  leftOut: LeftOut[]
  start: AssignmentInputs
  onCount: (next: AssignmentInputs) => void
  onCancel: () => void
}) {
  const options = useEveryOption(source, results)
  const [typed, setTyped] = useState<Record<string, number | string>>(() =>
    Object.fromEntries(Object.entries(start.places).map(([id, n]) => [id, n ?? ''])),
  )
  const [perVoter, setPerVoter] = useState(start.perVoter)
  const [tried, setTried] = useState(false)

  const shown = options?.filter((o) => !leftOut.some((l) => l.id === o.id)) ?? null
  const problems = new Map(
    (shown ?? []).flatMap((o) => {
      const value = typed[o.id] ?? ''
      const problem = value === '' ? null : amountError(value)
      return problem ? [[o.id, problem] as const] : []
    }),
  )

  function submit() {
    setTried(true)
    if (!shown || problems.size > 0) return
    onCount({
      places: Object.fromEntries(
        shown.map((o) => {
          const value = typed[o.id] ?? ''
          return [o.id, value === '' ? null : Number(value)]
        }),
      ),
      perVoter,
    })
  }

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Give each option as many places as voters it can go to. An option left blank has one place,
        and nothing you change here is saved.
      </Text>

      <Select
        label={CHOICE_NUMBER.assignment!.label}
        allowDeselect={false}
        w={200}
        value={String(perVoter)}
        onChange={(v) => v && setPerVoter(Number(v))}
        data={PER_VOTER_NUMBERS.map((n) => String(n))}
      />

      {!shown && <RankingSkeleton places={Math.min(results.option_count, SCORING_ROWS_MAX)} />}

      {shown && (
        <Stack gap={6}>
          <Text size="sm" fw={500}>
            Places
          </Text>
          {shown.map((option) => (
            <Group key={option.id} gap="sm" wrap="nowrap" align="flex-start">
              <Text size="sm" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }} pt={6}>
                {option.name}
              </Text>
              <NumberInput
                w={120}
                size="sm"
                aria-label={`Places for ${option.name}`}
                placeholder="1"
                value={typed[option.id] ?? ''}
                onChange={(v) => setTyped((prev) => ({ ...prev, [option.id]: v }))}
                min={1}
                max={AMOUNT_MAX}
                allowDecimal={false}
                allowNegative={false}
                thousandSeparator=","
                hideControls
                error={tried ? problems.get(option.id) : null}
              />
            </Group>
          ))}
        </Stack>
      )}

      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          onClick={submit}
          disabled={!shown}
          leftSection={<CalculatorIcon size={16} aria-hidden />}
        >
          Count
        </Button>
      </Group>
    </Stack>
  )
}
