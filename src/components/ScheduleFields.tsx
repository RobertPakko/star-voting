import { useMemo, useState } from 'react'
import { Alert, Group, SegmentedControl, Select, Stack, Text } from '@mantine/core'
import type { ScheduleEventData, ScheduleViewLevel } from '@mantine/schedule'
import { PaintCalendar } from './PaintCalendar'
import {
  DAY_MINUTES,
  daysOf,
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
  spanOf,
  todayIn,
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
 * about.** Nobody wants to drag out 09:00 to 17:00 on each of ten days, and
 * "the working day, except Friday which is only the afternoon" is the common
 * answer. So clicking a day's heading lays down these hours, and the drag is
 * there for the days that differ. They are also the hours the grid is drawn
 * between (`axisFor`), which is what keeps a week of it on a phone: it used to
 * be drawn on all forty-eight half hours of a day whatever the poll was asking
 * about. They are not stored and they are not the poll: what is painted is.
 *
 * **And they do not touch what is already painted.** Moving them used to
 * re-fill every day whose painting was still exactly the old default, on the
 * grounds that such a day was a day nobody had touched. It was a guess about
 * intent, and it was wrong as often as not -- a day filled from its heading
 * and then deliberately left alone is an answer, and it looks identical to one
 * nobody has reached yet. So the selects are a default and nothing more: they
 * decide what the *next* whole-day fill lays down, and the painting changes
 * only when somebody paints.
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

/**
 * The hours the create form's grid is drawn between: the two selects, widened
 * to hold anything painted outside them.
 *
 * **It used to be the whole of the day, every time.** Forty-eight rows of half
 * hours, of which the poll was usually asking about sixteen -- a form whose
 * bottom nobody could see, mostly so that the small hours could be greyed out
 * in it. The selects already say which part of the day this poll is about, so
 * that is the part it is drawn on, and a week of it fits on a phone.
 *
 * **Widened rather than clipped**, which is the half that has to be right: a
 * cell painted at seven in the evening and then left off the axis would be an
 * answer nobody can see and nobody can rub out, still generating windows on
 * the ballot. So narrowing the selects under what is painted narrows the grid
 * as far as the painting and no further, and the way to reach an hour outside
 * them is to move the select that excludes it.
 *
 * With nothing painted there is nothing to hold, and the selects stand alone.
 * `spanOf` answers `00:00`-`24:00` in that case, which would make this the
 * whole day again -- hence the first line rather than a union of three things.
 */
function axisFor(hours: DailyWindow, marked: Bounds, schedule: PollSchedule): DailyWindow {
  if (marked.size === 0) return hours
  const painted = spanOf(marked, schedule)
  // Both ends are `HH:mm`, fixed width, so they compare as plain strings --
  // `24:00` included, which is the latest of them and sorts as the latest.
  return {
    start: painted.start < hours.start ? painted.start : hours.start,
    end: painted.end > hours.end ? painted.end : hours.end,
  }
}

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
 * The cells one pair of times covers, which is what a day-fill writes.
 *
 * Usually the whole of the drawn column, since the grid is drawn between the
 * same two times (`axisFor`) -- and less than it where something painted
 * elsewhere has widened the axis past them, which is the one case the two
 * differ. The drag is there for the days that want less than the default, and
 * an hour outside it is reached by moving the select that excludes it. A poll
 * answered in whole days has one cell per day, which is the day itself.
 */
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
  onScheduleChange: (schedule: PollSchedule) => void
  /**
   * The painting, and the days it puts the poll on, together.
   *
   * One callback rather than two because the two cannot move apart: a day is
   * in the poll exactly while something is painted on it. `onMarkedChange`
   * below is for the changes that cannot add or remove a day -- moving the
   * default hours, changing how long the meeting is -- and this is for the
   * gesture that can.
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

  // The two facts about the chosen days that the offset answers depend on, as
  // scalars: a memo keyed on an array rebuilds on every render, since the array
  // is a new one each time even when the days in it have not moved.
  const firstDay = ordered[0] ?? ''
  const everyDay = ordered.join(',')

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
   * A poll about to run across a clock change where its offset is kept. It
   * cannot be fixed -- one poll, one offset -- so it is said.
   */
  const drift = useMemo(
    () => offsetDrift(schedule.timezone, everyDay ? everyDay.split(',') : []),
    [schedule.timezone, everyDay],
  )

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
      title: view !== 'month' ? '' : daily ? '' : `${toTimeOfDay(run.from)}–${toTimeOfDay(run.to)}`,
      ...runBounds(run),
      color: 'teal.6',
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
          data={LENGTHS}
          value={String(meetingMinutes(schedule))}
          onChange={(v) => v && setLength(Number(v))}
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

      {/* Hidden on a poll answered in whole days, where there are no hours to
          be earliest or latest: a day is either in or out. */}
      {!daily && (
        <Group grow align="flex-start" wrap="wrap">
          <Select
            label="Default earliest start"
            data={STARTS}
            value={hours.start}
            onChange={(v) =>
              v &&
              onHoursChange({
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
            label="Default latest end"
            data={ENDS.filter((end) => end.value > hours.start)}
            value={hours.end}
            onChange={(v) => v && onHoursChange({ ...hours, end: v })}
            allowDeselect={false}
            comboboxProps={{ withinPortal: false }}
          />
        </Group>
      )}

      {/* The calendar, which is where every day and every hour of this poll is
          said. Always on screen, and not only once a day has been picked
          somewhere else: there is nowhere else. */}
      <Stack gap={6}>
        <Group gap="sm" wrap="nowrap" align="center" justify="space-between">
          <Text size="sm" c="dimmed">
            {daily
              ? 'Define which dates voters are choosing between.'
              : 'Define what dates and times voters can choose from. Use the day or week view to paint times manually.'}
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
          onPaint={paint}
          buildEvents={buildEvents}
          fillOnDay={(day) => cellsInHours(day, hours, schedule.granularity)}
          // Shorter rows than the ballot's, which the axis above no longer
          // makes urgent and has not made pointless: a creator who opens the
          // selects to the whole day is back to forty-eight rows, and this is
          // a form with a poll's worth of other fields under it either way.
          slotHeight={daily ? undefined : 26}
          defaultView={'month'}
        />
        {error && (
          <Text size="sm" c="red" fw={500}>
            {error}
          </Text>
        )}
      </Stack>

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
