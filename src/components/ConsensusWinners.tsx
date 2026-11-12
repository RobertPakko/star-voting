import { useEffect, useId, useState } from 'react'
import { ActionIcon, Group, Select, Stack, Text, Tooltip } from '@mantine/core'
import { XIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { isSampleId, openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { formatWindow } from '../lib/schedule'
import { consensusWinnersSchema, parseAnswer } from '../lib/rpcSchemas'
import { use24HourTime } from '../lib/clock'
import { count, stars } from '../lib/plural'
import { CHOICE_NUMBER, CHOICE_NUMBERS, consensusWinnersFor, toolKind } from '../lib/choices'
import { ChoiceModal } from './ChoiceBlurb'
import type { MeetingEvent } from '../lib/calendarEvent'
import type { ConsensusWinnersResult, PollResults } from '../lib/types'
import type { RankingSource } from './FullRanking'
import { RemovedOptions, type LeftOut } from './RemovedOptions'
import { AddToCalendar } from './AddToCalendar'
import { useLeftOut, useWinnerCount } from '../lib/useLeftOut'
import { RankingSkeleton } from './Skeletons'

/**
 * Consensus winners (or times), opened from the result's *More results* menu
 * (`MoreResults`), or drawn on the results page where the question chose them
 * (`ChosenResult`): several options chosen together so that the voter they
 * serve worst is served as well as possible, each voter served by the option
 * in the set they gave the most stars. `/choices` explains it, and
 * `poll_consensus_winners` works it out.
 *
 * **A different number is a request of its own.** Unlike multiple winners,
 * the best three need not include the best two, so the answer on screen
 * cannot be cut to another number; each number is counted afresh.
 *
 * **An option can be taken out**, as in `Consensus`, and the count runs again
 * as though it had never been on the ballot. Removals and the number are the
 * reader's alone and never stored. **The sample can do neither**: it answers
 * from a recording made at one number with nothing removed.
 */
export function ConsensusWinners({
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
  const [winners, setWinners] = useWinnerCount(source.pollId, consensusWinnersFor(results))

  return (
    <ChoiceModal
      kind={toolKind('consensus_winners', results.kind)}
      opened={opened}
      onClose={onClose}
    >
      <ConsensusWinnersBody
        source={source}
        results={results}
        leftOut={leftOut}
        onLeftOut={setLeftOut}
        winners={winners}
        onWinners={setWinners}
      />
    </ChoiceModal>
  )
}

/**
 * The winners themselves, in the modal or on the results page. Handed the
 * answer the tally carried (`initial`, counted at the question's own number),
 * it asks for nothing until the number changes or an option is removed.
 * `eventFor` turns a time poll's winner into a calendar event.
 */
export function ConsensusWinnersBody({
  source,
  results,
  initial = null,
  leftOut,
  onLeftOut,
  winners,
  onWinners,
  eventFor,
}: {
  source: RankingSource
  results: PollResults
  initial?: ConsensusWinnersResult | null
  leftOut: LeftOut[]
  onLeftOut: (next: LeftOut[]) => void
  /** How many to choose. */
  winners: number
  onWinners: (next: number) => void
  eventFor?: (id: string) => MeetingEvent | null
}) {
  const h24 = use24HourTime()
  const kind = source.kind
  const key = source.pollId
  const sample = isSampleId(key)
  // The tally's answer stands only for the number it was counted at.
  const carried = initial && initial.winner_count === winners ? initial : null

  const [answer, setAnswer] = useState<ConsensusWinnersResult | null>(
    leftOut.length === 0 ? carried : null,
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
    // Nothing removed, at the question's own number: the tally's answer.
    if (!excludedKey && carried) {
      setAnswer(carried)
      setLoading(false)
      return
    }

    setLoading(true)
    let cancelled = false

    const excluded = excludedKey ? excludedKey.split(',') : []
    const args = { p_poll_id: key, p_excluded: excluded, p_winners: winners }
    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_consensus_winners', args)
        : openPollRpc('open_poll_consensus_winners', args)

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      setLoading(false)
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(
        consensusWinnersSchema,
        'the consensus winners',
        data,
      )
      if (value) setAnswer(value)
      else setError(shape)
    })

    return () => {
      cancelled = true
    }
  }, [kind, key, excludedKey, winners, carried])

  const remaining = results.option_count - leftOut.length
  // Choosing two of three is still a choice; two of two is not.
  const canRemove = !sample && remaining > 3

  const remove = (option: LeftOut) => onLeftOut([...leftOut, option])
  const restore = (id: string) => onLeftOut(leftOut.filter((o) => o.id !== id))

  return (
    <Stack gap="md">
      {!sample && (
        <Text size="sm" c="dimmed">
          If an option is not available, remove it and the winners are chosen again without it.
        </Text>
      )}

      {!sample && (
        <WinnerCount
          label={CHOICE_NUMBER[toolKindOf(results)]!.label}
          value={winners}
          optionCount={remaining}
          onChange={onWinners}
        />
      )}

      <RemovedOptions leftOut={leftOut} onRestore={restore} onRestoreAll={() => onLeftOut([])} />

      {error && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}

      {!error && !answer && <RankingSkeleton places={Math.min(winners, remaining)} />}

      {answer && !error && (
        <Stack
          gap="md"
          aria-busy={loading}
          style={{
            opacity: loading ? 0.5 : 1,
            transition: 'opacity var(--motion-fast)',
          }}
        >
          <Answer
            answer={answer}
            h24={h24}
            removable={canRemove && !loading}
            onRemove={remove}
            eventFor={eventFor}
          />
        </Stack>
      )}
    </Stack>
  )
}

/** Which kind's wording the number takes: winners on a list, times on a calendar. */
const toolKindOf = (results: PollResults) => toolKind('consensus_winners', results.kind)

/**
 * How many to choose. No *All*, unlike `ChoiceCount`: every option is no
 * choice at all. Offered up to one fewer than the options.
 */
function WinnerCount({
  label,
  value,
  optionCount,
  onChange,
}: {
  label: string
  value: number
  optionCount: number
  onChange: (next: number) => void
}) {
  const id = useId()
  const numbers = CHOICE_NUMBERS.filter((n) => n < optionCount || n === value)
  if (numbers.length < 2) return null

  return (
    <Group gap="xs" wrap="nowrap">
      <Text component="label" htmlFor={id} size="sm" c="dimmed">
        {label}
      </Text>
      <Select
        id={id}
        size="xs"
        w={80}
        allowDeselect={false}
        value={String(value)}
        onChange={(next) => next !== null && onChange(Number(next))}
        data={numbers.map((n) => ({ value: String(n), label: String(n) }))}
        comboboxProps={{ withinPortal: true }}
      />
    </Group>
  )
}

/** The winners, who each serves, and how well the worst-served voter does. */
function Answer({
  answer,
  h24,
  removable,
  onRemove,
  eventFor,
}: {
  answer: ConsensusWinnersResult
  h24: boolean
  removable: boolean
  onRemove: (option: LeftOut) => void
  eventFor?: (id: string) => MeetingEvent | null
}) {
  const { floor, served, single_floor: single, voter_count: total } = answer
  const blank = served[0] ?? 0
  // Best served first: "3 voters get an option they gave 5 stars".
  const levels = served
    .map((voters, level) => ({ level, voters }))
    .filter((row) => row.level > 0 && row.voters > 0)
    .reverse()

  return (
    <>
      <Stack component="ul" gap="xs" m={0} p={0} style={{ listStyle: 'none' }}>
        {answer.winners.map((w) => {
          const name = formatWindow(w.name, h24)
          const event = eventFor ? eventFor(w.id) : null
          return (
            <Group component="li" key={w.id} gap="sm" wrap="nowrap" align="center">
              <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                <Text fw={600} style={{ overflowWrap: 'anywhere' }}>
                  {name}
                </Text>
                <Text size="sm" c="dimmed">
                  Best for {count(w.best_for, 'voter')} · {stars(w.total_score)}
                </Text>
              </Stack>
              {event && <AddToCalendar event={event} />}
              {removable && (
                <Tooltip label="Remove and count again">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label={`Remove ${name}`}
                    onClick={() => onRemove({ id: w.id, name })}
                  >
                    <XIcon size={14} aria-hidden />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          )
        })}
      </Stack>

      <Stack gap={4}>
        {floor > 0 ? (
          <Text size="sm">
            Everyone gave at least one of these {stars(floor)} or more.
            {single < floor && (
              <> No single option was given more than {stars(single)} by everyone.</>
            )}
          </Text>
        ) : (
          <Text size="sm">
            {blank === total
              ? 'Nobody gave any of these a star.'
              : `${count(blank, 'voter')} gave none of these a star; no set of ${answer.winner_count} could do better.`}
          </Text>
        )}
      </Stack>

      {levels.length > 0 && (
        <Stack gap={4}>
          <Group gap="sm" wrap="nowrap">
            <Text size="xs" c="dimmed" style={{ flex: 1 }}>
              Their best winner has
            </Text>
            <Text size="xs" c="dimmed">
              Voters
            </Text>
          </Group>
          <Stack component="ul" gap={4} m={0} p={0} style={{ listStyle: 'none' }}>
            {levels.map(({ level, voters }) => (
              <Group component="li" key={level} gap="sm" wrap="nowrap">
                <Text size="sm" style={{ flex: 1 }}>
                  {stars(level)}
                </Text>
                <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {voters}
                </Text>
              </Group>
            ))}
          </Stack>
        </Stack>
      )}
    </>
  )
}
