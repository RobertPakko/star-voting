import { useMemo, useState, type ReactNode } from 'react'
import { Alert, Box, Group, SegmentedControl, Stack, Text } from '@mantine/core'
import { WeekView, type ScheduleEventData } from '@mantine/schedule'
// Imported here rather than in main.tsx so it travels in this component's own
// chunk: Vite splits a lazy chunk's CSS with it, so a poll that chooses an
// option never fetches the calendar's stylesheet. See components/deferred.ts.
import '@mantine/schedule/styles.css'
import dayjs from 'dayjs'
import { BallotFrame, type BallotScore } from './BallotFrame'
import {
  daysOf,
  formatDay,
  meetingMinutes,
  paintingFromScores,
  saysNothing,
  scoresFromPainting,
  toMinutes,
  toTimeOfDay,
  type GranuleKey,
} from '../lib/schedule'
import type { PollOption, PollSchedule } from '../lib/types'

/**
 * The ballot for a poll that finds a time: a calendar somebody paints.
 *
 * A voter never sees an option here, and that is the point. They mark when
 * they are free, at whatever rating; this flattens the painting into a score
 * per window on the way out and inflates the scores back into a painting on
 * the way in. Both directions are `lib/schedule.ts`, which is where the rules
 * are written down and where they are tested. Everything in this file is the
 * gesture.
 *
 * **The grid is the poll's, not the reader's.** Every time on screen is wall
 * clock in the offset the creator declared, and no `Date` built from a voter's
 * own clock is ever compared against it -- see `lib/schedule.ts`. A voter in
 * Berlin and a voter in Denver paint the same grid with the same labels, which
 * is the whole of what "one timezone per poll" buys, and why the offset is
 * written above the calendar rather than silently converted away.
 *
 * `useBallotOrder` does not apply. It shuffles the option list per browser
 * because position on a list is worth points; a calendar is scanned rather
 * than read top to bottom, and its order is chronological and load-bearing --
 * shuffling it would produce a week with Thursday in the middle. That is a
 * deliberate exception to the rule that file argues for, and the only one.
 */

/**
 * What `@mantine/schedule` is and is not, since building on it looks stranger
 * than it is: it is an event calendar in the Google Calendar mould, whose
 * primitive is an event with a start, an end and a colour. It has no notion of
 * a rated cell and no availability grid.
 *
 * The adaptation is three of its props. `withDragSlotSelect` with
 * `onSlotDragEnd` gives the drag gesture, `onTimeSlotClick` covers a single
 * tap, and every painted region is rendered back as a *background* event
 * coloured by its rating. The rating itself -- which of the six levels a drag
 * applies -- is the app's own control, because a calendar has nowhere to put
 * one.
 */
const RATINGS = [
  { value: '0', label: "Can't", color: 'gray.5' },
  { value: '1', label: '1', color: 'blue.2' },
  { value: '2', label: '2', color: 'blue.4' },
  { value: '3', label: '3', color: 'blue.5' },
  { value: '4', label: '4', color: 'blue.7' },
  { value: '5', label: '5', color: 'blue.9' },
]

function colorFor(rating: number): string {
  return RATINGS[rating]?.color ?? 'gray.5'
}

/**
 * The painting, as the calendar wants it: one background event per run of
 * neighbouring granules sharing a rating.
 *
 * Merged rather than one event per cell, because a week of quarter-hours is
 * four hundred cells and a run of them is one block to look at. A 0 draws
 * nothing at all -- an unpainted granule already means unavailable, so a grey
 * block over the whole calendar would be an answer the voter never gave.
 */
function paintingToEvents(
  painting: Record<GranuleKey, number>,
  schedule: PollSchedule,
): ScheduleEventData[] {
  const cells = Object.entries(painting)
    .filter(([, rating]) => rating > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))

  const events: ScheduleEventData[] = []
  for (const [key, rating] of cells) {
    const [day, timeOfDay] = key.split(' ')
    const from = toMinutes(timeOfDay)
    const last = events[events.length - 1]
    const runsOn =
      last &&
      last.payload?.rating === rating &&
      last.payload?.day === day &&
      last.payload?.until === from

    if (runsOn) {
      last.end = `${day} ${toTimeOfDay(from + schedule.granularity)}:00`
      last.payload!.until = from + schedule.granularity
      continue
    }

    events.push({
      id: key,
      title: '',
      start: `${day} ${timeOfDay}:00`,
      end: `${day} ${toTimeOfDay(from + schedule.granularity)}:00`,
      color: colorFor(rating),
      display: 'background',
      payload: { rating, day, until: from + schedule.granularity },
    })
  }
  return events
}

export function TimeBallotCard({
  options,
  schedule,
  initial,
  nameField,
  questionStrip,
  note,
  beforeSubmit,
  onSubmit,
  onVoted,
  onCancel,
}: {
  /** The windows, as ordinary options: each one's name is its start time. */
  options: PollOption[]
  schedule: PollSchedule
  /** The scores already on this voter's ballot; absent when casting a new one. */
  initial?: Record<string, number>
  nameField?: ReactNode
  questionStrip?: ReactNode
  note: ReactNode
  beforeSubmit?: () => boolean
  onSubmit: (scores: BallotScore[]) => Promise<void>
  onVoted: () => void
  onCancel?: () => void
}) {
  const windows = useMemo(() => options.map((option) => option.name), [options])
  const days = useMemo(() => daysOf(windows), [windows])

  const [painting, setPainting] = useState<Record<GranuleKey, number>>(() => {
    if (!initial) return {}
    // `initial` is keyed by option id and the derivation works in window
    // starts, because a window start is the only thing both sides agree on.
    const byName: Record<string, number> = {}
    for (const option of options) byName[option.name] = initial[option.id] ?? 0
    return paintingFromScores(windows, byName, schedule)
  })

  const [rating, setRating] = useState('5')
  // Which week is on screen. A poll can span more than one, and the calendar
  // opens on the first day it is asking about rather than on today -- which
  // may be months away from the poll and is never where the answer is.
  const [week, setWeek] = useState(() => days[0] ?? dayjs().format('YYYY-MM-DD'))

  const inBounds = useMemo(() => new Set(days), [days])
  const events = useMemo(() => paintingToEvents(painting, schedule), [painting, schedule])

  const scores = useMemo(
    () => scoresFromPainting(windows, painting, schedule),
    [windows, painting, schedule],
  )
  const nothingFits = saysNothing(scores)
  const painted = Object.values(painting).some((value) => value > 0)

  /** Set every granule in a half-open range to the rating on the brush. */
  function paint(fromSlot: string, toSlot: string) {
    // `YYYY-MM-DD HH:mm:ss` on the way in, and the grid is keyed to the
    // minute; the end is the end of the last slot dragged over, so the range
    // is half-open.
    const day = fromSlot.slice(0, 10)
    if (!inBounds.has(day)) return

    const from = toMinutes(fromSlot.slice(11, 16))
    const to = toMinutes(toSlot.slice(11, 16))
    const value = Number(rating)

    setPainting((prev) => {
      const next = { ...prev }
      for (let at = from; at < to; at += schedule.granularity) {
        const key = `${day} ${toTimeOfDay(at)}`
        // A 0 is stored as an absence rather than as a zero, so that the two
        // ways of saying "not then" -- painting it grey and never touching it
        // -- are one state rather than two that look alike.
        if (value === 0) delete next[key]
        else next[key] = value
      }
      return next
    })
  }

  function collect(): BallotScore[] {
    return options.map((option) => ({
      candidate_id: option.id,
      score: scores[option.name] ?? 0,
    }))
  }

  const length = meetingMinutes(schedule)

  return (
    <BallotFrame
      revising={initial !== undefined}
      nameField={nameField}
      questionStrip={questionStrip}
      note={note}
      beforeSubmit={beforeSubmit}
      collect={collect}
      onSubmit={onSubmit}
      onVoted={onVoted}
      onCancel={onCancel}
    >
      <Stack gap="xs">
        <Text size="sm">
          Mark when you could meet for {describe(length)}. Drag across the calendar to paint, and
          use <b>Can&apos;t</b> to rub something out.
        </Text>

        <Group gap="sm" wrap="wrap" align="center">
          <SegmentedControl
            size="xs"
            value={rating}
            onChange={setRating}
            data={RATINGS.map((level) => ({
              value: level.value,
              label: (
                <Group gap={6} wrap="nowrap" justify="center">
                  <Box
                    w={10}
                    h={10}
                    style={{
                      borderRadius: 2,
                      background:
                        level.value === '0'
                          ? 'var(--mantine-color-default-border)'
                          : `var(--mantine-color-${level.color.replace('.', '-')})`,
                    }}
                  />
                  <span>{level.label}</span>
                </Group>
              ),
            }))}
          />
          <Text size="xs" c="dimmed">
            5 is the best time for you; 1 is the worst you would still accept.
          </Text>
        </Group>

        {/* The offset is stated rather than converted, because converting it
            is the one thing this poll promised not to do: everybody is looking
            at the same grid, and a voter elsewhere needs to be told which. */}
        <Text size="xs" c="dimmed">
          All times are UTC{schedule.timezone}
          {days.length > 0 && ` · ${formatDay(days[0])} to ${formatDay(days[days.length - 1])}`}
        </Text>

        <WeekView
          date={week}
          onDateChange={setWeek}
          startTime={`${schedule.window.start}:00`}
          // 24:00 is midnight at the end of the day, which the calendar cannot
          // draw as a time of day; a second before it is the same last row.
          endTime={schedule.window.end === '24:00' ? '23:59:59' : `${schedule.window.end}:00`}
          intervalMinutes={schedule.granularity}
          events={events}
          withDragSlotSelect
          onSlotDragEnd={paint}
          onTimeSlotClick={({ slotStart, slotEnd }) => paint(slotStart, slotEnd)}
          // A day the poll is not asking about is not a day to paint. Disabled
          // rather than hidden: which days are in bounds is part of what the
          // poll is asking, and a week with holes in it says it plainly.
          getTimeSlotProps={({ start }) =>
            inBounds.has(start.slice(0, 10))
              ? undefined
              : {
                  disabled: true,
                  style: {
                    background: 'var(--mantine-color-gray-light)',
                    cursor: 'not-allowed',
                  },
                }
          }
          withAllDaySlots={false}
          withWeekNumber={false}
          // The header keeps the week arrows, which a poll spanning two weeks
          // needs, and loses the rest of what a calendar's header usually
          // offers. Switching to a month view is a view with nothing to paint
          // on it, and "Today" is a week the poll is probably not asking
          // about -- both are ways out of the only screen that answers the
          // question.
          viewSelectProps={{ style: { display: 'none' } }}
          todayControlProps={{ style: { display: 'none' } }}
          // The clock says nothing here: "now" is in the reader's own zone and
          // the grid is in the poll's, so a line across it would be wrong by
          // however far apart the two are.
          withCurrentTimeIndicator={false}
          withAgenda={false}
          slotHeight={schedule.granularity < 30 ? 28 : 40}
        />

        {/* The one way a voter can do everything right and send nothing: mark
            two separate hours on a poll looking for a three-hour block, and
            every window contains something unmarked, so every window is 0.
            That is the correct answer to the question and it looks exactly
            like the app having eaten the vote -- so it is said before the
            vote goes in rather than discovered afterwards. */}
        {nothingFits && painted && (
          <Alert color="yellow" title={`No ${spanning(length)} block yet`}>
            Nothing you have marked is {describe(length)} long without a gap, so every option would
            score zero and your ballot would not count towards any of them. Paint a longer stretch,
            or send it as it stands if none of these times work.
          </Alert>
        )}
      </Stack>
    </BallotFrame>
  )
}

/** "90 minutes", "an hour", "3 hours" -- how long the meeting is, in a sentence. */
function describe(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  if (minutes === 60) return 'an hour'
  const hours = minutes / 60
  return Number.isInteger(hours) ? `${hours} hours` : `${minutes} minutes`
}

/** The same length in front of a noun: a "2-hour block", a "90-minute block". */
function spanning(minutes: number): string {
  const hours = minutes / 60
  return Number.isInteger(hours) ? `${hours}-hour` : `${minutes}-minute`
}
