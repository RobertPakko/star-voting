import { useMemo, useState } from 'react'
import { Group, SegmentedControl, Select, Stack, Switch, Text } from '@mantine/core'
import type { ScheduleEventData, ScheduleViewLevel } from '@mantine/schedule'
import { PaintCalendar } from './PaintCalendar'
import { HoursFields } from './HoursFields'
import {
  axisFor,
  cellsInHours,
  daysOf,
  describeLength,
  describeOffset,
  granularityFor,
  isDaily,
  MEETING_LENGTHS,
  meetingMinutes,
  paintingRuns,
  runBounds,
  todayIn,
  formatTimeRange,
  type Bounds,
  type GranuleKey,
} from '../lib/schedule'
import { use24HourTime } from '../lib/clock'
import { offsetChoices } from '../lib/timezones'
import type { DailyWindow, PollSchedule } from '../lib/types'

/**
 * What a creator says instead of writing a list of options: how long the
 * meeting is, which days it could be on, and -- by painting them -- which
 * hours of those days are in bounds.
 *
 * **The creator paints the same calendar the voter does**, which is the whole
 * shape of this form. It used to ask for one pair of times for the poll and
 * then, behind a switch, a row of two dropdowns per day: fourteen rows of
 * `Fri 4 Sep [18:00] to [22:00]` to say something a fortnight of drags says
 * faster and more exactly. Anything a row of dropdowns could express, a
 * painting can; a painting can also express a Wednesday free from nine to
 * eleven and again after three, which the rows could not.
 *
 * **And it is the only calendar.** There used to be a second one above it -- a
 * month picker whose whole job was to hand back a list of dates, after which
 * those dates were painted on the calendar below. Two calendars for one
 * answer, and the first of them asked a question the second could not help
 * with and could not disagree with either, since a day picked and then left
 * unpainted was a day the poll did not ask about. So the picker is gone and
 * the days are simply the days with something on them: mark a Thursday and
 * Thursday is in the poll, rub it out and it is not. `daysOf` says which they
 * are, which is the same function the ballot reads them back with.
 *
 * **What is painted is the poll.** The cells become windows (`enumerateWindows`)
 * and the windows become the options, and nothing about which days or hours
 * are in bounds is stored beside them -- the ballot reads them back off the
 * option list with `boundsOf`. So there is no second copy of the answer to
 * disagree with the first.
 *
 * **The two time selects stay, and say which part of the day this poll is
 * about**: the hours a day's heading lays down and the hours the grid is drawn
 * between, with the drag there for the days that differ. They are
 * `HoursFields`, which the card that collects times from a group draws too and
 * which says what they are and are not; `axisFor` and `cellsInHours` are the
 * two things they decide.
 *
 * **Granularity is not asked about**, which it used to be. It is a
 * consequence of how long the meeting is -- half an hour under a day, a whole
 * day at or above one; see `granularityFor` -- and the one thing a creator
 * could do with the question was pick a combination the enumeration then had
 * to refuse.
 */

const LENGTHS = MEETING_LENGTHS.map((minutes) => ({
  value: String(minutes),
  label: describeLength(minutes),
}))

/** What a marked cell is drawn in, and so what hovering one previews. */
const MARKED = 'teal.6'

/** The marked set as a painting, which is the shape `PaintCalendar` speaks. */
function paintingOf(marked: Bounds): Record<GranuleKey, number> {
  const painting: Record<GranuleKey, number> = {}
  for (const key of marked) painting[key] = 1
  return painting
}

/**
 * The day picker hands back whatever order the clicks came in; everything
 * below reads them in date order, and so does the ballot.
 */
function inOrder(days: string[]): string[] {
  return [...days].sort()
}

export function ScheduleFields({
  schedule,
  overlap,
  several,
  count,
  onLengthChange,
  onOverlapChange,
  days,
  hours,
  marked,
  onDaysChange,
  onHoursChange,
  onOffsetChange,
  error,
}: {
  schedule: PollSchedule
  /** Whether the times may overlap; see `overlapOf`. */
  overlap: boolean
  /** Whether the question picks several times, so overlapping times are a warning. */
  several: boolean
  /** How many windows the painting makes, for the line under the calendar. */
  count: number
  /** A new meeting length; the form carries the painting onto its grid (`reconcileGrid`). */
  onLengthChange: (minutes: number) => void
  onOverlapChange: (overlap: boolean) => void
  /**
   * The days the poll asks about, as `YYYY-MM-DD`. Not stored: see
   * PollSchedule. Exactly `daysOf(marked)` -- a day is on the calendar because
   * something is painted on it, and there is no other way to put one there.
   */
  days: string[]
  /** The hours a whole-day fill lays down. Not stored either. */
  hours: DailyWindow
  /** The cells painted in bounds, which become the options. */
  marked: Bounds
  /**
   * The painting, and the days it puts the poll on, together.
   *
   * One callback rather than two because the two cannot move apart: a day is
   * in the poll exactly while something is painted on it.
   */
  onDaysChange: (days: string[], marked: Set<GranuleKey>) => void
  onHoursChange: (hours: DailyWindow) => void
  /**
   * Picking an offset, which the form handles rather than this component
   * because a poll's dates decide which offset this browser is guessing on --
   * see `CreatePoll`'s `pickOffset`.
   */
  onOffsetChange: (offset: string) => void
  /** Wrong with the schedule as a whole -- nothing painted, or too many windows. */
  error?: string
}) {
  const h24 = use24HourTime()
  const ordered = inOrder(days)
  const daily = isDaily(schedule)
  const length = meetingMinutes(schedule)
  const [brush, setBrush] = useState(1)

  /**
   * The first day this poll may ask about: today, on the poll's own clock.
   *
   * **A meeting cannot be held in the past**, and a calendar that lets one be
   * marked there is offering a ballot whose best answer is a day that has
   * already gone. Nothing downstream would catch it -- the enumeration is
   * arithmetic and does not read a clock, and a window in the past is a
   * perfectly well-formed window -- so the floor belongs on the gesture that
   * puts a day in the poll.
   *
   * The whole of today is in, rather than the rest of it. A creator marking
   * this afternoon at two is answering a question about their own diary, and a
   * floor that moved through the day would rub out what they had marked while
   * they were still typing the title.
   *
   * Read on the poll's offset rather than on this browser's, which is the
   * point of `todayIn`: a creator in Auckland arranging a meeting held at
   * -07:00 is a day ahead of the grid they are painting, and their own
   * calendar would grey out a day the poll can use. Recomputed on each render
   * rather than held, so a form left open across midnight is right afterwards.
   */
  const floor = todayIn(schedule.timezone)

  // The fact about the chosen days the offset captions depend on, as a scalar:
  // a memo keyed on an array rebuilds on every render, since the array is a new
  // one each time even when the days in it have not moved.
  const firstDay = ordered[0] ?? ''

  /**
   * One list, in order: every offset, each captioned with what people on it
   * call it -- `UTC-07:00 (Pacific Time)` -- where anybody is on it at all.
   *
   * The caption is worked out for the poll's own first day, which is what lets
   * there be one per offset: `-07:00` is Pacific Time in July and Mountain
   * Time in January, and the poll only needs the one that is true while it is
   * running. `keep` is the offset the schedule already holds, so a poll stored
   * at something the list would not otherwise offer still shows what it is
   * held at.
   *
   * Rebuilt when the first day moves and not on every keystroke in the search
   * box, because building it asks `Intl` about thirty-odd zones.
   */
  const offsets = useMemo(
    () => offsetChoices(firstDay || today(), schedule.timezone),
    [firstDay, schedule.timezone],
  )

  /**
   * A stroke, and the days it leaves the poll asking about.
   *
   * Painting is the only thing that adds or removes a day now, so the day list
   * is re-derived from the painting here rather than kept beside it -- the two
   * are one answer and are reported as one. A Thursday marked for the first
   * time puts Thursday in the poll; rubbing the last cell off it takes it out
   * again, with no orphaned day left behind for the enumeration to find.
   */
  function paint(keys: GranuleKey[], value: number) {
    const next = new Set(marked)
    for (const key of keys) {
      if (value === 0) next.delete(key)
      else next.add(key)
    }
    onDaysChange(daysOf(next), next)
  }

  /**
   * The painting, drawn back. One colour: the question here has two answers
   * rather than six, and a cell either is in bounds or is not.
   */
  function buildEvents(view: ScheduleViewLevel): ScheduleEventData[] {
    const asPainting: Record<GranuleKey, number> = {}
    for (const key of marked) asPainting[key] = 1
    return paintingRuns(asPainting, schedule).map((run) => ({
      id: `${run.day} ${run.from}`,
      title: view !== 'month' ? '' : daily ? '' : formatTimeRange(run.from, run.to, h24),
      ...runBounds(run),
      color: MARKED,
      display: view === 'month' ? 'default' : 'background',
      // A month chip's label, in a colour the calendar would pick badly; see
      // `eventBody` in PaintCalendar.
      payload: { ink: 'var(--mantine-color-white)' },
    }))
  }

  return (
    <Stack gap="sm">
      <Group grow align="flex-start" wrap="wrap">
        <Select
          label="Length"
          // A length no longer offered (a duplicate of an older poll) is kept.
          data={
            LENGTHS.some((choice) => choice.value === String(length))
              ? LENGTHS
              : [...LENGTHS, { value: String(length), label: describeLength(length) }].sort(
                  (a, b) => Number(a.value) - Number(b.value),
                )
          }
          value={String(length)}
          onChange={(v) => v && onLengthChange(Number(v))}
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
        />
        {/* One list of offsets, in order, each captioned with what people on it
          call it. The offset is what is being chosen and what the poll is held
          at; the name is there so that a creator who does not know they are on
          -07:00 can recognise Pacific Time and pick it. */}
        <Select
          label="Timezone"
          data={offsets.map((choice) => ({
            value: choice.offset,
            label: describeOffset(choice.offset, choice.name),
          }))}
          value={schedule.timezone}
          onChange={(v) => v && onOffsetChange(v)}
          searchable
          nothingFoundMessage="No offset like that — try the number, or the name of a zone"
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
        />
      </Group>

      {/* Whether the times overlap. A meeting of one cell (half an hour, a
          day) cannot, so the switch is not drawn for one. */}
      {length > granularityFor(length) && (
        <Switch
          checked={overlap}
          onChange={(e) => onOverlapChange(e.currentTarget.checked)}
          label="Times can overlap"
          description={
            !overlap
              ? 'Times run back to back, so each is a separate meeting.'
              : several
                ? `A time starts every ${daily ? 'day' : 'half hour'}, so two of the winners may be nearly the same time.`
                : `A time starts every ${daily ? 'day' : 'half hour'}, so voters can find the start that suits everyone.`
          }
        />
      )}

      {/* Hidden on a poll answered in whole days, where there are no hours to
          be earliest or latest: a day is either in or out. */}
      {!daily && <HoursFields hours={hours} cell={schedule.granularity} onChange={onHoursChange} />}

      {/* The calendar, which is where every day and every hour of this poll is
          said. Always on screen, and not only once a day has been picked
          somewhere else: there is nowhere else. */}
      <Stack gap={6}>
        <Group gap="sm" wrap="nowrap" align="center" justify="space-between">
          <Text size="sm" c="dimmed">
            {daily
              ? 'Define which dates voters are choosing between.'
              : 'Define what dates and times voters can choose from.'}
          </Text>
          <SegmentedControl
            size="xs"
            miw={100}
            value={String(brush)}
            onChange={(v) => setBrush(Number(v))}
            data={[
              { value: '1', label: 'Mark' },
              { value: '0', label: 'Erase' },
            ]}
          />
        </Group>
        <PaintCalendar
          schedule={schedule}
          // What is painted, which is also which days the poll is on and so
          // where the calendar opens. Nothing ahead is out of bounds: the two
          // below say that every cell of every day still to come may be
          // marked, because marking one is how a day joins the poll in the
          // first place. Days that have gone are the one exception; see
          // `floor`.
          bounds={marked}
          canPaint={(key) => key.slice(0, 10) >= floor}
          dayInBounds={(day) => day >= floor}
          // And no walking back into the months that are entirely behind the
          // floor, which are screens of greyed cells with nothing to say.
          earliest={floor}
          // The two selects, widened to hold whatever is painted outside
          // them; see `axisFor`. A poll about the working day is drawn on the
          // working day rather than on all forty-eight half hours of a day.
          axis={axisFor(hours, marked, schedule)}
          painting={paintingOf(marked)}
          brush={brush}
          brushColor={brush ? MARKED : undefined}
          onPaint={paint}
          buildEvents={buildEvents}
          fillOnDay={(day) => cellsInHours(day, hours, schedule.granularity)}
        />
        {error ? (
          <Text role="alert" size="sm" c="red" fw={500}>
            {error}
          </Text>
        ) : (
          count > 0 && (
            <Text size="sm" c="dimmed">
              {count === 1 ? '1 time' : `${count} times`} to choose from.
            </Text>
          )
        )}
      </Stack>
    </Stack>
  )
}

/**
 * Today, as the date the offsets are captioned against before any day has been
 * picked. Only ever used to *label* the picker; what a poll is held at is the
 * creator's own answer, and the guess behind it is `CreatePoll`'s.
 */
function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
