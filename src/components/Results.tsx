import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActionIcon, Card, Group, Popover, Stack, Text } from '@mantine/core'
import { InfoIcon, WarningIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { parseAnswer, pollResultsSchema } from '../lib/rpcSchemas'
import { describeLength, formatWindow, meetingMinutes, relabelResults } from '../lib/schedule'
import type { MeetingEvent } from '../lib/calendarEvent'
import { shareLinkFor } from '../lib/shareLink'
import { use24HourTime } from '../lib/clock'
import type { PollKind, PollResults, PollSchedule } from '../lib/types'
import { AddToCalendar } from './AddToCalendar'
import { ChosenResult } from './ChosenResult'
import { CoinFlip, type Finalist } from './CoinFlip'
import { levelOptions } from '../lib/consensus'
import { MoreResults } from './MoreResults'
import { Reveal } from './Reveal'
import { ResultsSkeleton } from './Skeletons'
import { StarRounds } from './StarRounds'
import { choiceLabel, chosenResult } from '../lib/choices'
import { ChoiceBlurb } from './ChoiceBlurb'
import classes from './Results.module.css'

/** Which tally endpoint to read: a session for invite polls, the link for open ones. */
export type ResultsSource = { kind: 'poll'; pollId: string } | { kind: 'open'; pollId: string }

/**
 * A question's result, opening on what the question asked for (`polls.kind`):
 * a bar naming the kind and, where it has one, its winner; under it that
 * kind's own answer — STAR's two rounds for the best option or time, the
 * chosen result's body otherwise. Every other result is in *More results*,
 * STAR's included.
 */
export function Results({
  source,
  initial = null,
  meeting = null,
}: {
  source: ResultsSource
  /** A time poll's title and schedule, for *Add to calendar*. Null otherwise. */
  meeting?: { title: string; schedule: PollSchedule } | null
  /** The tally `poll_page` already carried; null means read it here. */
  initial?: PollResults | null
}) {
  const h24 = use24HourTime()
  const kind = source.kind
  const key = source.pollId

  // Read on every draw, never cached: a closed poll can be reopened or have
  // its options corrected, unannounced to a tally held here.
  const [results, setResults] = useState<PollResults | null>(initial)
  const [error, setError] = useState<string | null>(null)
  // The handed-over tally, used once; a later re-read must not reuse it.
  const handoff = useRef(initial)

  useEffect(() => {
    const given = handoff.current
    handoff.current = null
    if (given) return

    let cancelled = false
    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_results', { p_poll_id: key })
        : openPollRpc('open_poll_results', { p_poll_id: key })

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(pollResultsSchema, 'the tally', data)
      if (value) setResults(value)
      else setError(shape)
    })

    return () => {
      cancelled = true
    }
  }, [kind, key])

  if (error) {
    return (
      <Text role="alert" c="red" size="sm">
        {error}
      </Text>
    )
  }

  if (!results) return <ResultsSkeleton />

  // Time-poll names become readable; ordinary names pass through.
  const shown = relabelResults(results, h24)
  const nameById = new Map(shown.options.map((o) => [o.id, o.name]))

  // A calendar event from the *raw* option name, which is the actual instant.
  const startById = new Map(results.options.map((o) => [o.id, o.name]))
  const eventFor = (id: string): MeetingEvent | null => {
    const start = startById.get(id)
    if (!meeting || !start) return null
    return {
      title: meeting.title,
      start,
      minutes: meetingMinutes(meeting.schedule),
      details: shareLinkFor({ id: key }),
      uid: `${key}-${start}@choicelab.app`,
    }
  }

  // The result the question asked for, where it is more than STAR's winner.
  // Where the poll is too small for its kind the tally carries none, and the
  // page is the best option's.
  const chosen = chosenResult(results)
  const tool = chosen?.kind ?? 'option'
  const calendar = shown.calendar

  // What a reader can do with the answer, in the bar that gives it.
  const answers = <MoreResults source={source} results={shown} shown={tool} />

  let bar: ReactNode
  if (chosen?.kind === 'consensus') {
    const { winner_id: winnerId, options } = chosen.consensus
    // The consensus answers with raw names; the tally's map may not hold a
    // winner outside its top rows.
    const raw = options.find((o) => o.id === winnerId)?.name
    const event = winnerId ? eventFor(winnerId) : null
    const level = levelOptions(chosen.consensus, h24)
    bar = (
      <AnswerBar
        kind={tool}
        calendar={calendar}
        name={raw ? formatWindow(raw, h24) : null}
        event={event}
      >
        {answers}
        {event && <AddToCalendar event={event} />}
        {level.length >= 2 && (
          <CoinFlip pollId={key} finalists={level} eventFor={meeting ? eventFor : undefined} />
        )}
      </AnswerBar>
    )
  } else if (chosen) {
    // Several options are the answer, so the bar names only the kind.
    bar = (
      <AnswerBar kind={tool} calendar={calendar}>
        {answers}
      </AnswerBar>
    )
  } else if (shown.winner_id) {
    const event = eventFor(shown.winner_id)
    bar = (
      <AnswerBar
        kind={tool}
        calendar={calendar}
        name={nameById.get(shown.winner_id) ?? null}
        event={event}
      >
        {answers}
        {event && <AddToCalendar event={event} />}
      </AnswerBar>
    )
  } else {
    bar = (
      <AnswerBar kind={tool} calendar={calendar} name={null}>
        {answers}
        {shown.finalists.length === 2 && (
          <CoinFlip
            pollId={key}
            finalists={tiedPair(shown, nameById)}
            eventFor={meeting ? eventFor : undefined}
          />
        )}
      </AnswerBar>
    )
  }

  return (
    <Reveal>
      <Stack gap="md">
        {/* Its own entrance, since a poll that finishes while watched grows
            this card without the rest remounting. */}
        <Reveal rise={false}>{bar}</Reveal>

        {chosen && (
          <Card withBorder>
            <ChosenResult
              source={source}
              results={shown}
              chosen={chosen}
              eventFor={meeting ? eventFor : undefined}
            />
          </Card>
        )}

        {shown.options_edited_after_votes && (
          <Caveat>
            The options for this poll were edited after votes had been cast; so the integrity of
            this poll is a little suspect.
          </Caveat>
        )}
        {shown.votes_after_reveal && (
          <Caveat>
            Votes were added or changed after the results were revealed; so the integrity of this
            poll is a little suspect.
          </Caveat>
        )}

        {!chosen && <StarRounds source={source} results={shown} />}
      </Stack>
    </Reveal>
  )
}

/**
 * The answer, under the name of what the question asked for, with an info
 * mark opening that kind's one sentence (`ChoiceBlurb`), which leads on to
 * where `/choices` explains it. Green where there is
 * an answer, orange where the kind names one winner and found none (`name`
 * null); `name` left out is a kind whose answer is several options.
 *
 * The buttons sit beside a short title and drop to a row of their own under a
 * long one; a long name wraps before it pushes them off.
 */
function AnswerBar({
  kind,
  calendar,
  name,
  event = null,
  children,
}: {
  kind: PollKind
  /** Whether the options are a calendar's, which names the kind as times. */
  calendar: boolean
  name?: string | null
  /** A time poll's winner, whose meeting length the title carries. */
  event?: MeetingEvent | null
  children: ReactNode
}) {
  const label = choiceLabel(kind, calendar)
  const none = name === null

  return (
    <Card
      withBorder
      bg={none ? 'var(--mantine-color-orange-light)' : 'var(--mantine-color-green-light)'}
      className={classes.landed}
      style={
        none
          ? ({ '--landed-ring': 'var(--mantine-color-orange-filled)' } as React.CSSProperties)
          : undefined
      }
    >
      <Group justify="space-between" align="center" gap="sm">
        <Group gap={4} wrap="nowrap" align="center" style={{ minWidth: 0 }}>
          <Text fw={700} size="lg" style={{ overflowWrap: 'anywhere' }}>
            {label}
            {name !== undefined && <>: {name ?? 'no winner'}</>}
            {/* A time poll's meeting length, kept on one line. */}
            {event && (
              <>
                {' '}
                <span style={{ whiteSpace: 'nowrap' }}>({describeLength(event.minutes)})</span>
              </>
            )}
          </Text>
          {/* Focus moves in, so the link is reachable by keyboard and Escape closes it. */}
          <Popover width={280} position="bottom" withArrow shadow="md" trapFocus>
            <Popover.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                radius="xl"
                aria-label={`What ${label.toLowerCase()} means`}
                style={{ flexShrink: 0 }}
              >
                <InfoIcon size={18} aria-hidden />
              </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown>
              <ChoiceBlurb kind={kind} calendar={calendar} />
            </Popover.Dropdown>
          </Popover>
        </Group>
        {/* `ml="auto"` keeps the buttons right-aligned when they drop below the name. */}
        <Group gap="xs" ml="auto">
          {children}
        </Group>
      </Group>
    </Card>
  )
}

/**
 * A caveat on the result (options edited after votes, or votes after the
 * reveal). Yellow: not an error, and distinct from the no-winner orange.
 * The database records only that it happened, not what.
 */
function Caveat({ children }: { children: ReactNode }) {
  return (
    <Card withBorder bg="var(--mantine-color-yellow-light)" p="sm">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        {/* Aligned with the first line, since the text wraps on a phone. */}
        <WarningIcon size={18} weight="fill" style={{ flexShrink: 0, marginTop: 2 }} />
        <Text size="sm">{children}</Text>
      </Group>
    </Card>
  )
}

/** The two tied finalists, as `CoinFlip` takes them. */
function tiedPair(results: PollResults, nameById: Map<string, string>): Finalist[] {
  const named = (id: string): Finalist => ({ id, name: nameById.get(id) ?? id })

  return [named(results.finalists[0]), named(results.finalists[1])]
}
