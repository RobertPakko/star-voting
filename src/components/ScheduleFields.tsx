import { useMemo, useState } from 'react'
import { Alert, Group, SegmentedControl, Select, Stack, Text } from '@mantine/core'
import { DatePicker } from '@mantine/dates'
// With the day picker, in the create form's own chunk; see PaintCalendar.
import '@mantine/dates/styles.css'
import type { ScheduleEventData, ScheduleViewLevel } from '@mantine/schedule'
import { PaintCalendar } from './PaintCalendar'
import {
  countWindows,
  DAY_MINUTES,
  describeLength,
  describeOffset,
  formatDay,
  granularityFor,
  granuleKey,
  isDaily,
  MEETING_LENGTHS,
  meetingMinutes,
  paintingRuns,
  runBounds,
  toMinutes,
  toTimeOfDay,
  type Bounds,
  type GranuleKey,
  type ScheduleDay,
} from '../lib/schedule'
import { offsetChoices, offsetDrift } from '../lib/timezones'
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
 * **What is painted is the poll.** The cells become windows (`enumerateWindows`)
 * and the windows become the options, and nothing about which days or hours
 * are in bounds is stored beside them -- the ballot reads them back off the
 * option list with `boundsOf`. So there is no second copy of the answer to
 * disagree with the first.
 *
 * **The two time selects stay, as the default a whole day is filled with.**
 * Nobody wants to drag out 09:00 to 17:00 on each of ten days, and "the
 * working day, except Friday which is only the afternoon" is the common
 * answer. So clicking a day's heading lays down these hours, and the drag is
 * there for the days that differ. They are not stored and they are not the
 * poll: what is painted is.
 *
 * **Granularity is not asked about**, which it used to be. It is a
 * consequence of how long the meeting is -- half an hour under a day, a whole
 * day at or above one; see `granularityFor` -- and the one thing a creator
 * could do with the question was pick a combination the enumeration then had
 * to refuse.
 */

/** Times of day for the two ends of the default window, at half-hour steps. */
function timesOfDay(from: number, to: number): { value: string; label: string }[] {
  const all: { value: string; label: string }[] = []
  for (let minutes = from; minutes <= to; minutes += 30) {
    all.push({ value: toTimeOfDay(minutes), label: toTimeOfDay(minutes) })
  }
  return all
}

const STARTS = timesOfDay(0, 23 * 60 + 30)
// Offered from half an hour after midnight so the list can never contain a
// time at or before the earliest start; 24:00 is midnight at the end of the
// day, which '00:00' would read as the start of it.
const ENDS = [...timesOfDay(30, 23 * 60 + 30), { value: '24:00', label: '24:00' }]

const LENGTHS = MEETING_LENGTHS.map((minutes) => ({
  value: String(minutes),
  label: describeLength(minutes),
}))

/** The whole of a day, which is what the create form's grid is drawn between. */
const WHOLE_DAY: DailyWindow = { start: '00:00', end: '24:00' }

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

/**
 * Every cell of a day the creator may paint: the whole of it.
 *
 * Wider than what a day-fill lays down on purpose -- the two selects are a
 * default and the drag is the exception to it, so an evening outside them has
 * to be reachable. A poll answered in whole days has one cell per day, which
 * is the day itself.
 */
function cellsOnDay(day: ScheduleDay, granularity: number): GranuleKey[] {
  const keys: GranuleKey[] = []
  for (let at = 0; at + granularity <= DAY_MINUTES; at += granularity)
    keys.push(granuleKey(day, at))
  return keys
}

/** And the cells one pair of times covers, which is what a day-fill writes. */
function cellsInHours(day: ScheduleDay, hours: DailyWindow, granularity: number): GranuleKey[] {
  if (granularity >= DAY_MINUTES) return [granuleKey(day, 0)]
  const last = toMinutes(hours.end)
  const keys: GranuleKey[] = []
  for (let at = toMinutes(hours.start); at + granularity <= last; at += granularity) {
    keys.push(granuleKey(day, at))
  }
  return keys
}

export function ScheduleFields({
  schedule,
  days,
  hours,
  marked,
  onScheduleChange,
  onDaysChange,
  onHoursChange,
  onMarkedChange,
  onOffsetChange,
  error,
}: {
  schedule: PollSchedule
  /** The days on the calendar, as `YYYY-MM-DD`. Not stored: see PollSchedule. */
  days: string[]
  /** The hours a whole-day fill lays down. Not stored either. */
  hours: DailyWindow
  /** The cells painted in bounds, which become the options. */
  marked: Bounds
  onScheduleChange: (schedule: PollSchedule) => void
  /**
   * Days, with the painting that goes with them: a day added arrives already
   * marked and a day removed takes its cells with it, so the two move
   * together or the form has a moment where they disagree.
   */
  onDaysChange: (days: string[], marked: Set<GranuleKey>) => void
  onHoursChange: (hours: DailyWindow) => void
  onMarkedChange: (marked: Set<GranuleKey>) => void
  /**
   * Picking an offset, which the form handles rather than this component
   * because a poll's dates decide which offset this browser is guessing on --
   * see `CreatePoll`'s `pickOffset`.
   */
  onOffsetChange: (offset: string) => void
  /** Wrong with the schedule as a whole -- nothing painted, or too many windows. */
  error?: string
}) {
  const ordered = inOrder(days)
  const daily = isDaily(schedule)
  const total = countWindows(schedule, marked)
  const [brush, setBrush] = useState(1)

  // The two facts about the chosen days that the offset answers depend on, as
  // scalars: a memo keyed on an array rebuilds on every render, since the array
  // is a new one each time even when the days in it have not moved.
  const firstDay = ordered[0] ?? ''
  const everyDay = ordered.join(',')

  /**
   * One list, in order: every offset, each captioned with what people on it
   * call it -- `UTC-07:00 · Pacific Time` -- where anybody is on it at all.
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
   * A poll about to run across a clock change where its offset is kept. It
   * cannot be fixed -- one poll, one offset -- so it is said.
   */
  const drift = useMemo(
    () => offsetDrift(schedule.timezone, everyDay ? everyDay.split(',') : []),
    [schedule.timezone, everyDay],
  )

  /** Every cell the creator may paint: all of every day they picked. */
  const paintable = useMemo(() => {
    const cells = new Set<GranuleKey>()
    for (const day of everyDay ? everyDay.split(',') : []) {
      for (const key of cellsOnDay(day, schedule.granularity)) cells.add(key)
    }
    return cells
  }, [everyDay, schedule.granularity])

  /**
   * Changing how long the meeting is, which decides the resolution with it.
   *
   * When the resolution moves between half-hours and whole days the painting
   * has to move with it, because a cell means something different on each side
   * of that line. Going up to days, a day with anything marked on it becomes a
   * day that is in; coming back down, a day that was in gets the default hours
   * -- which is the same thing picking it in the calendar would have done, and
   * the nearest thing to the answer they had.
   */
  function setLength(minutes: number) {
    const granularity = granularityFor(minutes)
    const next = { ...schedule, granularity, desired_slots: minutes / granularity }
    if (granularity === schedule.granularity) {
      onScheduleChange(next)
      return
    }

    const wasOn = new Set([...marked].map((key) => key.slice(0, 10)))
    const moved = new Set<GranuleKey>()
    for (const day of ordered) {
      if (!wasOn.has(day)) continue
      for (const key of cellsInHours(day, hours, granularity)) moved.add(key)
    }
    onScheduleChange(next)
    onMarkedChange(moved)
  }

  /**
   * Choosing days, with the painting kept in step: a day added arrives already
   * marked with the default hours -- which is what somebody picking a day
   * meant -- and a day removed takes its cells with it. Anything else leaves
   * cells on a day nobody is asking about, which would quietly become options.
   */
  function setDays(next: string[]) {
    const asked = new Set(next)
    const kept = new Set<GranuleKey>()
    for (const key of marked) {
      if (asked.has(key.slice(0, 10))) kept.add(key)
    }
    for (const day of next) {
      if ([...marked].some((key) => key.startsWith(day))) continue
      for (const key of cellsInHours(day, hours, schedule.granularity)) kept.add(key)
    }
    onDaysChange(next, kept)
  }

  /**
   * Moving the default hours, which re-fills the days that are still on the
   * default and leaves the ones that are not.
   *
   * A day whose painting is exactly the old default is a day nobody has
   * touched, and moving the default is how somebody says "the working day
   * starts at eight" -- they should not then have to re-drag nine days. A day
   * painted into something else is an answer, and answers are not moved.
   */
  function setHours(next: DailyWindow) {
    const before = hours
    const moved = new Set(marked)
    for (const day of ordered) {
      const was = cellsInHours(day, before, schedule.granularity)
      const untouched =
        was.length > 0 &&
        was.every((key) => marked.has(key)) &&
        [...marked].filter((key) => key.startsWith(day)).length === was.length
      if (!untouched) continue
      for (const key of was) moved.delete(key)
      for (const key of cellsInHours(day, next, schedule.granularity)) moved.add(key)
    }
    onHoursChange(next)
    onMarkedChange(moved)
  }

  function paint(keys: GranuleKey[], value: number) {
    const next = new Set(marked)
    for (const key of keys) {
      if (value === 0) next.delete(key)
      else next.add(key)
    }
    onMarkedChange(next)
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
      title:
        view !== 'month'
          ? ''
          : daily
            ? 'In bounds'
            : `${toTimeOfDay(run.from)}–${toTimeOfDay(run.to)}`,
      ...runBounds(run),
      color: 'teal.6',
      display: view === 'month' ? 'default' : 'background',
    }))
  }

  const blank = ordered.filter(
    (day) =>
      countWindows(schedule, new Set([...marked].filter((key) => key.startsWith(day)))) === 0,
  )

  return (
    <Stack gap="sm">
      <Select
        label="How long is it?"
        description="Every option is a window this long"
        data={LENGTHS}
        value={String(meetingMinutes(schedule))}
        onChange={(v) => v && setLength(Number(v))}
        allowDeselect={false}
        comboboxProps={{ withinPortal: false }}
      />

      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Which days?
        </Text>
        <DatePicker
          type="multiple"
          value={days}
          onChange={setDays}
          size="sm"
          // The picker is the only field here whose width is not the form's,
          // and centring it stops it sitting oddly against the select above.
          mx="auto"
        />
      </Stack>

      {/* Hidden on a poll answered in whole days, where there are no hours to
          be earliest or latest: a day is either in or out. */}
      {!daily && (
        <Group grow align="flex-start" wrap="wrap">
          <Select
            label="Earliest start"
            description="What clicking a whole day fills in"
            data={STARTS}
            value={hours.start}
            onChange={(v) =>
              v &&
              setHours({
                start: v,
                end: ENDS.some((end) => end.value > v && end.value === hours.end)
                  ? hours.end
                  : (ENDS.find((end) => end.value > v)?.value ?? hours.end),
              })
            }
            allowDeselect={false}
            comboboxProps={{ withinPortal: false }}
          />
          <Select
            label="Latest end"
            description="Drag on the calendar for the days that differ"
            data={ENDS.filter((end) => end.value > hours.start)}
            value={hours.end}
            onChange={(v) => v && setHours({ ...hours, end: v })}
            allowDeselect={false}
            comboboxProps={{ withinPortal: false }}
          />
        </Group>
      )}

      {ordered.length > 0 && (
        <Stack gap={6}>
          <Group gap="sm" wrap="wrap" align="center">
            {/* Two values rather than the ballot's six: the question here is
                whether the poll is asking about a time at all. The eraser is
                what a drag needs and a day-click does not -- clicking a day
                that is already exactly the default takes it back, which is the
                same toggle the ballot's day-fill has. */}
            <SegmentedControl
              size="xs"
              value={String(brush)}
              onChange={(v) => setBrush(Number(v))}
              data={[
                { value: '1', label: 'Mark' },
                { value: '0', label: 'Erase' },
              ]}
            />
            <Text size="sm" c="dimmed">
              {daily
                ? 'Click a day to put it in or take it out, or drag across several.'
                : 'Drag to mark the hours people can choose from; click a day’s heading to fill it with the hours above.'}
            </Text>
          </Group>
          <PaintCalendar
            schedule={schedule}
            bounds={paintable}
            axis={WHOLE_DAY}
            painting={paintingOf(marked)}
            brush={brush}
            onPaint={paint}
            buildEvents={buildEvents}
            fillOnDay={(day) => cellsInHours(day, hours, schedule.granularity)}
            // A whole day of half-hours is forty-eight rows, and at the
            // ballot's row height that is a form nobody can see the bottom of.
            slotHeight={daily ? undefined : 22}
          />
        </Stack>
      )}

      {/* One list of offsets, in order, each captioned with what people on it
          call it. The offset is what is being chosen and what the poll is held
          at; the name is there so that a creator who does not know they are on
          -07:00 can recognise Pacific Time and pick it. */}
      <Select
        label="Times are in"
        description="Everybody sees the same grid, at this offset, wherever they are"
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

      {/* A poll that runs across a clock change where its offset is kept. One
          poll is one offset -- the whole reason an offset is what is stored --
          so this cannot be corrected here. It can be chosen, which needs it
          said. */}
      {drift && (
        <Alert color="yellow" title="The clocks change during these dates">
          {drift.name} moves to UTC{drift.becomes} on {formatDay(drift.day)}. This poll is held at
          UTC{schedule.timezone} throughout, so times from then on will read an hour off the wall
          there. Either is a fine answer — everybody sees the same grid — but the later days are the
          ones to check before you send it.
        </Alert>
      )}

      {/* What the answers above actually add up to. The creator is writing a
          ballot without seeing one, and this is the only place the size of it
          is visible before the poll exists. A day with nothing long enough on
          it is named rather than left to vanish, since a silently absent day
          looks exactly like the form having dropped it. */}
      <Text size="xs" c={error ? 'var(--mantine-color-error)' : 'dimmed'}>
        {error ??
          (ordered.length === 0
            ? 'Pick the days people can choose between.'
            : `${total} ${total === 1 ? 'window' : 'windows'} to score across ${ordered.length} ${ordered.length === 1 ? 'day' : 'days'}.` +
              (blank.length > 0
                ? ` Nothing on ${listDays(blank)} is ${describeLength(meetingMinutes(schedule))} long.`
                : ''))}
      </Text>
    </Stack>
  )
}

/**
 * A handful of days in a sentence: `Sat 5 Sep`, `Fri 4 Sep and Sat 5 Sep`,
 * `Fri 4 Sep, Sat 5 Sep and 3 others`.
 */
function listDays(days: string[]): string {
  const named = days.slice(0, 3).map(formatDay)
  const rest = days.length - named.length
  if (rest > 0) return `${named.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`
  if (named.length === 1) return named[0]
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
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
