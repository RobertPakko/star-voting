import { useEffect, useState } from 'react'
import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core'
import { CalculatorIcon, PencilSimpleIcon, XIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { isSampleId, openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { assignmentSchema, parseAnswer } from '../lib/rpcSchemas'
import { amountError } from '../lib/pollForm'
import { AMOUNT_MAX } from '../lib/limits'
import { choiceNumberLabel, PER_VOTER_NUMBERS } from '../lib/choices'
import { use24HourTime } from '../lib/clock'
import { formatWindow } from '../lib/schedule'
import { count } from '../lib/plural'
import { SCORING_ROWS_MAX } from '../lib/resultsRows'
import type { AssignmentResult, PollResults } from '../lib/types'
import { ChoiceModal } from './ChoiceBlurb'
import { RankingSkeleton } from './Skeletons'
import type { RankingSource } from './FullRanking'
import { useEveryOption } from '../lib/useEveryOption'
import { RemovedOptions, type LeftOut } from './RemovedOptions'
import { useAssignmentInputs, useLeftOut, type AssignmentInputs } from '../lib/useLeftOut'
import { OptionNote } from './OptionNote'

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
 * voted (`offers`). It says nothing of anybody's stars: beside who got what,
 * even a count of options by the stars they were given could say how a
 * named voter scored on a poll whose ballots are private.
 *
 * **Capacities and the cap can be given after the fact.** An assignment
 * question has its own (a capacity of one, and one option each, where it says
 * nothing); on any other list every option starts with a capacity of one and every voter with one
 * option, and the reader can change either and count again. Like removals,
 * they are the reader's alone, never stored, and kept while this poll's
 * results stay on screen.
 *
 * **The sample cannot recount**: it answers from a recording, which holds the
 * count with the question's own capacities and nothing removed.
 *
 * **Two views of one answer**: by option (who fills each option's slots) and
 * by voter (what each voter was given, and how many of the most they could
 * be). The database calls a capacity `places`; on screen it is a *capacity*
 * where it is set and *slots* where they are filled.
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
    <ChoiceModal kind="assignment" calendar={results.calendar} opened={opened} onClose={onClose}>
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
 * or the capacities or cap are changed.
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
  // An assignment of times names its windows as times; anything else passes through.
  const h24 = use24HourTime()

  const [result, setResult] = useState<AssignmentResult | null>(
    leftOut.length === 0 && !inputs ? initial : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [view, setView] = useState<'options' | 'voters'>('options')

  // Sorted, so the same set asked for twice is the same request.
  const excludedKey = leftOut
    .map((o) => o.id)
    .sort()
    .join(',')
  const inputsKey = inputs ? JSON.stringify(inputs) : ''

  useEffect(() => {
    setError(null)
    // The question's own capacities with nothing removed: the tally carried it.
    if (!excludedKey && !inputsKey && initial) {
      setResult(initial)
      setLoading(false)
      return
    }

    setLoading(true)
    let cancelled = false

    const typed = inputsKey ? (JSON.parse(inputsKey) as AssignmentInputs) : null
    // An option given a capacity of 0 goes to nobody, which is the count
    // without it: it is sent as left out, since a stored capacity is at
    // least one (`validate_amount`).
    const placed = Object.entries(typed?.places ?? {})
    const unplaced = placed.filter(([, n]) => n === 0).map(([id]) => id)
    const args = {
      p_poll_id: key,
      p_excluded: [...(excludedKey ? excludedKey.split(',') : []), ...unplaced],
      p_places: typed ? Object.fromEntries(placed.filter(([, n]) => n !== 0)) : undefined,
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

  const optionWord = results.calendar ? 'Time' : 'Option'

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
            Edit capacity
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
          <SegmentedControl
            value={view}
            onChange={(v) => setView(v as 'options' | 'voters')}
            data={[
              { label: `${optionWord} view`, value: 'options' },
              { label: 'Voter view', value: 'voters' },
            ]}
            style={{ alignSelf: 'flex-start' }}
          />

          {view === 'voters' && (
            <VoterView result={result} h24={h24} word={optionWord.toLowerCase()} />
          )}

          {view === 'options' &&
            result.options.map((option) => (
              <Group key={option.id} align="flex-start" wrap="nowrap" gap="sm">
                <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Group gap="xs" wrap="nowrap" align="center">
                    <Text fw={600} style={{ overflowWrap: 'anywhere' }}>
                      {formatWindow(option.name, h24)}
                    </Text>
                    <OptionNote id={option.id} name={formatWindow(option.name, h24)} />
                    <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                      {option.voters.length} of {count(option.places, 'slot')}
                    </Text>
                    {canRemove && !loading && (
                      <Tooltip label="Remove and assign again">
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="sm"
                          ml="auto"
                          aria-label={`Remove ${formatWindow(option.name, h24)}`}
                          onClick={() =>
                            remove({ id: option.id, name: formatWindow(option.name, h24) })
                          }
                        >
                          <XIcon size={14} aria-hidden />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                  <Text size="sm" c={option.voters.length === 0 ? 'dimmed' : undefined}>
                    {option.voters.length === 0
                      ? 'Nobody'
                      : option.voters.map((v) => v.name).join(', ')}
                  </Text>
                </Stack>
              </Group>
            ))}

          {view === 'options' && result.unplaced.length > 0 && (
            <Stack gap={2}>
              <Text size="sm" fw={600}>
                No option
              </Text>
              <Text size="sm" c="dimmed">
                {result.unplaced.map((v) => v.name).join(', ')}
              </Text>
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  )
}

/**
 * Every voter, alphabetically, with how many options they were given out of
 * the most they could be (as the option view counts slots) and which. The
 * answer names voters as the roster does, so two open-poll voters who typed
 * one name are listed as one.
 */
function VoterView({
  result,
  h24,
  word,
}: {
  result: AssignmentResult
  h24: boolean
  word: string
}) {
  const given = new Map<string, string[]>()
  for (const option of result.options)
    for (const voter of option.voters) {
      const held = given.get(voter.name) ?? []
      held.push(formatWindow(option.name, h24))
      given.set(voter.name, held)
    }
  for (const voter of result.unplaced) if (!given.has(voter.name)) given.set(voter.name, [])
  const rows = [...given].sort(([a], [b]) => a.localeCompare(b))

  return (
    <Stack gap="sm">
      {rows.map(([name, held]) => (
        <Stack key={name} gap={2}>
          <Group gap="xs" wrap="nowrap" align="center">
            <Text fw={600} style={{ overflowWrap: 'anywhere' }}>
              {name}
            </Text>
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {held.length} of {count(result.per_voter, word)}
            </Text>
          </Group>
          <Text size="sm" c={held.length === 0 ? 'dimmed' : undefined}>
            {held.length === 0 ? `No ${word}` : held.join(', ')}
          </Text>
        </Stack>
      ))}
    </Stack>
  )
}

/**
 * The reader's capacities and cap: every option on the ballot (less any
 * removed), a capacity beside each, the most options a voter is given, and
 * *Count*. A blank box is a capacity of one, and 0 none, which is quicker than
 * removing options one at a time. Nothing typed here is saved.
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
  const h24 = use24HourTime()
  const [typed, setTyped] = useState<Record<string, number | string>>(() =>
    Object.fromEntries(Object.entries(start.places).map(([id, n]) => [id, n ?? ''])),
  )
  const [perVoter, setPerVoter] = useState(start.perVoter)
  const [tried, setTried] = useState(false)

  const shown = options?.filter((o) => !leftOut.some((l) => l.id === o.id)) ?? null
  const problems = new Map(
    (shown ?? []).flatMap((o) => {
      const value = typed[o.id] ?? ''
      // 0 is allowed here, unlike on a stored option: it takes the option
      // out of this count without removing it from the list.
      const problem =
        value === '' || Number(value) === 0
          ? null
          : amountError(value) && `A whole number from 0 to ${AMOUNT_MAX.toLocaleString('en-US')}.`
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
        Give each option a capacity: how many voters it can go to. An option left blank has a
        capacity of 1, an option given 0 goes to nobody, and nothing you change here is saved.
      </Text>

      <Select
        label={choiceNumberLabel('assignment', results.calendar)}
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
            Capacity
          </Text>
          {shown.map((option) => (
            <Group key={option.id} gap="sm" wrap="nowrap" align="flex-start">
              <Text size="sm" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }} pt={6}>
                {formatWindow(option.name, h24)}
              </Text>
              <NumberInput
                w={120}
                size="sm"
                aria-label={`Capacity of ${formatWindow(option.name, h24)}`}
                placeholder="1"
                value={typed[option.id] ?? ''}
                onChange={(v) => setTyped((prev) => ({ ...prev, [option.id]: v }))}
                min={0}
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
