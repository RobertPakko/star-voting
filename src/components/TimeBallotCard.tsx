import { useMemo, useState, type ReactNode } from 'react'
import { ActionIcon, Alert, Anchor, Box, Group, SegmentedControl, Stack, Text } from '@mantine/core'
import {
  DayView,
  MonthView,
  WeekView,
  type ScheduleEventData,
  type ScheduleViewLevel,
} from '@mantine/schedule'
// Imported here rather than in main.tsx so it travels in this component's own
// chunk: Vite splits a lazy chunk's CSS with it, so a poll that chooses an
// option never fetches the calendar's stylesheet. See components/deferred.ts.
import '@mantine/schedule/styles.css'
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react'
import dayjs from 'dayjs'
import { BallotFrame, type BallotScore } from './BallotFrame'
import {
  clock,
  daysOf,
  describeOffset,
  formatDay,
  granulesInBounds,
  meetingMinutes,
  offsetFromViewer,
  paintable,
  paintingFromScores,
  saysNothing,
  scoresFromPainting,
  toMinutes,
  toTimeOfDay,
  type GranuleKey,
  type ScheduleDay,
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
 * written above the calendar rather than silently converted away. The one
 * thing the reader's own zone is used for is the sentence saying how far from
 * it they are, which moves nothing.
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
 * The adaptation is a handful of its props, and each one is a gesture:
 *
 * - `withDragSlotSelect` with `onSlotDragEnd` gives the drag, and
 *   `onTimeSlotClick` covers a single tap -- a plain click is not a drag of
 *   length zero to that hook, it is nothing at all, so both are wired.
 * - Every painted region is rendered back as a *background* event coloured by
 *   its rating.
 * - **A day's column heading fills that day**, through `onDateChange`.
 * - In the month view, which has no time grid at all, a day *is* the unit:
 *   `onDayClick` fills one and a drag across several fills those.
 *
 * The rating itself -- which of the six levels a gesture applies -- is the
 * app's own control, because a calendar has nowhere to put one.
 *
 * **The header is ours, and that is what makes the heading gesture honest.**
 * `onDateChange` is fired by four things in a week grid -- the previous and
 * next controls, Today, and the day heading -- and by two in a month. Turning
 * the library's header off (`withHeader={false}`) leaves exactly one caller in
 * each view: the day heading in the week grid, and nothing at all in the other
 * two. So the callback means one thing, and the code reads as what it is
 * rather than as a guess about which control fired.
 *
 * That header was already half turned off -- Today hidden because "today" is a
 * week the poll is probably not asking about, Agenda and the current-time line
 * off -- and what it wants instead is a brush, a way back to the poll's own
 * dates, and a Clear. Four controls of somebody else's next to four of ours
 * was the arrangement worth ending.
 */
const RATINGS = [
  { value: '0', label: "Can't", color: 'gray.5', ink: 'black' },
  { value: '1', label: '1', color: 'blue.2', ink: 'black' },
  { value: '2', label: '2', color: 'blue.4', ink: 'black' },
  { value: '3', label: '3', color: 'blue.5', ink: 'black' },
  { value: '4', label: '4', color: 'blue.7', ink: 'white' },
  { value: '5', label: '5', color: 'blue.9', ink: 'white' },
]

function colorFor(rating: number): string {
  return RATINGS[rating]?.color ?? 'gray.5'
}

/**
 * The colour to write a day's summary in, which has to be chosen here rather
 * than left to the calendar.
 *
 * A background event takes its text colour from Mantine's variant resolver,
 * and for a shade this saturated that comes back equal to the background --
 * dark blue on dark blue, which is a legible label everywhere except on
 * screen. The runs have no text so it never showed; the day lines do. Picked
 * against the six swatches above rather than computed, because there are six
 * of them and they do not change.
 */
function inkFor(rating: number): string {
  return `var(--mantine-color-${RATINGS[rating]?.ink ?? 'black'})`
}

/**
 * The views offered, which is the library's four minus the year: a year of
 * months is a screen with nothing on it to paint, and no poll spans one.
 */
const VIEWS: ScheduleViewLevel[] = ['day', 'week', 'month']

const VIEW_LABELS: Record<string, string> = { day: 'Day', week: 'Week', month: 'Month' }

/**
 * The painting, as the time grid wants it: one background event per run of
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

/**
 * One line per day saying what is marked on it, for the month grid.
 *
 * The month is the one view with nothing else to show: it has no rows to paint
 * an hour onto, so a day either says what is on it or says nothing. The week
 * and day grids draw the hours themselves and get none of these.
 *
 * Shaped as an all-day event -- midnight to a second before the next -- which
 * is what puts it across the whole of the day's cell.
 *
 * Only days with something on them get one. An untouched day is drawn as an
 * ordinary empty cell -- there is nothing to summarise, and the thing to click
 * is the day itself rather than a chip sitting on it. A day the poll is not
 * asking about is greyed and disabled instead; see `getDayProps`.
 */
function daySummaryEvents(
  painting: Record<GranuleKey, number>,
  schedule: PollSchedule,
  days: ScheduleDay[],
): ScheduleEventData[] {
  const lines: ScheduleEventData[] = []
  for (const day of days) {
    const cells = granulesInBounds(schedule, day)
    const marked = cells.filter((key) => (painting[key] ?? 0) > 0)
    if (marked.length === 0) continue

    const best = marked.reduce((top, key) => Math.max(top, painting[key] ?? 0), 0)
    lines.push({
      id: `day-${day}`,
      title: describeDay(marked, cells.length, schedule),
      start: `${day} 00:00:00`,
      end: `${day} 23:59:59`,
      color: colorFor(best),
      display: 'background',
      payload: { ink: inkFor(best) },
    })
  }
  return lines
}

/**
 * What that line says: `Whole day`, `6–10pm`, `4h in 2 blocks`.
 *
 * Short on purpose. It has a month cell to fit inside on the narrowest screen
 * the app supports, and the exact hours are readable in the week view a tap
 * away; what it is for here is telling a scanned month apart at a glance.
 */
function describeDay(marked: GranuleKey[], total: number, schedule: PollSchedule): string {
  if (marked.length === total) return 'Whole day'

  const minutes = marked.map((key) => toMinutes(key.slice(11)))
  const runs = minutes.reduce(
    (count, at, i) => (i > 0 && at === minutes[i - 1] + schedule.granularity ? count : count + 1),
    0,
  )
  if (runs === 1) {
    const from = minutes[0]
    const to = minutes[minutes.length - 1] + schedule.granularity
    return `${shortClock(from)}–${shortClock(to)}`
  }
  return `${describe(marked.length * schedule.granularity)} in ${runs} blocks`
}

/** `6pm`, `9:30am` -- the clock with the part nobody needs left off. */
function shortClock(minutes: number): string {
  return clock(minutes).replace(':00', '')
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
  // Which date is on screen, and at what zoom. A poll can span more than one
  // week, and the calendar opens on the first day it is asking about rather
  // than on today -- which may be months away from the poll and is never where
  // the answer is. One date across all three views, so switching between them
  // stays where the reader was.
  const [date, setDate] = useState(() => days[0] ?? dayjs().format('YYYY-MM-DD'))
  const [view, setView] = useState<ScheduleViewLevel>('week')

  const inBounds = useMemo(() => new Set(days), [days])
  // A month has no hours to draw a run of granules on, so it gets a line per
  // day instead; the two grids that do have hours draw the hours.
  const events = useMemo(
    () =>
      view === 'month'
        ? daySummaryEvents(painting, schedule, days)
        : paintingToEvents(painting, schedule),
    [view, painting, schedule, days],
  )

  const scores = useMemo(
    () => scoresFromPainting(windows, painting, schedule),
    [windows, painting, schedule],
  )
  const nothingFits = saysNothing(scores)
  const painted = Object.values(painting).some((value) => value > 0)

  /** Write one rating over a set of cells, or rub them out when it is 0. */
  function apply(keys: GranuleKey[], value: number) {
    if (keys.length === 0) return
    setPainting((prev) => {
      const next = { ...prev }
      for (const key of keys) {
        // A 0 is stored as an absence rather than as a zero, so that the two
        // ways of saying "not then" -- painting it grey and never touching it
        // -- are one state rather than two that look alike.
        if (value === 0) delete next[key]
        else next[key] = value
      }
      return next
    })
  }

  /** Set every granule in a half-open range to the rating on the brush. */
  function paint(fromSlot: string, toSlot: string) {
    // `YYYY-MM-DD HH:mm:ss` on the way in, and the grid is keyed to the
    // minute; the end is the end of the last slot dragged over, so the range
    // is half-open.
    const day = fromSlot.slice(0, 10)
    const from = toMinutes(fromSlot.slice(11, 16))
    const to = toMinutes(toSlot.slice(11, 16))

    const keys: GranuleKey[] = []
    for (let at = from; at < to; at += schedule.granularity) {
      const timeOfDay = toTimeOfDay(at)
      // Filtered cell by cell rather than day by day, because a day can now be
      // in bounds for part of itself: a drag from 9am down a Friday that only
      // starts at 6pm marks the evening and leaves the morning alone, rather
      // than being refused whole.
      if (paintable(schedule, inBounds, day, timeOfDay)) keys.push(`${day} ${timeOfDay}`)
    }
    apply(keys, Number(rating))
  }

  /**
   * Fill a whole day, or clear it.
   *
   * **It toggles**, and that is the difference between a shortcut and a trap.
   * The gesture is one click on a strip with no undo beside it; a day that is
   * already exactly what the brush would make it is a day the click was
   * meant to take back. Anything else fills -- including a day that is
   * half-marked, or marked at a different rating, both of which are answers the
   * click is being used to replace.
   *
   * The `Can't` brush never toggles: clearing a cleared day would fill it,
   * which is the one thing a brush that means "not then" must never do.
   */
  function fillDay(on: string) {
    // `YYYY-MM-DD` from the month grid's day and `YYYY-MM-DD 00:00:00` from
    // the week grid's heading, which is the shape every date callback in this
    // library hands back. Sliced here rather than at each call site, so the two
    // gestures are one function.
    const day = on.slice(0, 10)
    if (!inBounds.has(day)) return
    const cells = granulesInBounds(schedule, day)
    const value = Number(rating)
    const already = value > 0 && cells.every((key) => painting[key] === value)
    apply(cells, already ? 0 : value)
  }

  /** The same over a run of days, from a drag across the month. Never toggles. */
  function fillDays(fromDay: string, toDay: string) {
    const first = fromDay.slice(0, 10)
    const last = toDay.slice(0, 10)
    const cells = days
      .filter((day) => day >= first && day <= last)
      .flatMap((day) => granulesInBounds(schedule, day))
    apply(cells, Number(rating))
  }

  function collect(): BallotScore[] {
    return options.map((option) => ({
      candidate_id: option.id,
      score: scores[option.name] ?? 0,
    }))
  }

  const length = meetingMinutes(schedule)
  const away = offsetFromViewer(schedule, days[0])
  const showing = visibleRange(date, view)
  // Whether the calendar has been navigated off the poll entirely. Worth
  // asking now that a month view exists: the arrows move a month at a time,
  // and a poll asking about three days in September is one press away from a
  // screen with nothing on it and no clue why.
  const adrift = days.length > 0 && (days[days.length - 1] < showing.from || days[0] > showing.to)

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
      // Fetched when it is drawn rather than bundled with the ballot, so it
      // arrives after the page's own entrance has finished and has to make one
      // of its own; see BallotFrame's `arriving`.
      arriving
    >
      <Stack gap="xs">
        <Text size="sm">
          Mark when you could meet for {describe(length)}. Drag across the calendar to paint, click
          a day&apos;s heading — or a day in the month view — to fill the whole of it, and use{' '}
          <b>Can&apos;t</b> to rub something out.
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

        {/* The zone is stated rather than converted, because converting it is
            the one thing this poll promised not to do: everybody is looking at
            the same grid, and a voter elsewhere needs to be told which one --
            in the creator's own words where they gave any, and then in hours
            from the clock on the reader's own wall, which is the part they
            were going to work out anyway. */}
        <Group gap={6} wrap="wrap" justify="space-between">
          <Text size="xs" c="dimmed">
            All times are {describeOffset(schedule.timezone, schedule.timezone_label)}
            {away && ` · ${away}`}
            {days.length > 0 && ` · ${formatDay(days[0])} to ${formatDay(days[days.length - 1])}`}
          </Text>
          {painted && (
            <Anchor
              component="button"
              type="button"
              size="xs"
              c="dimmed"
              onClick={() => setPainting({})}
            >
              Clear everything
            </Anchor>
          )}
        </Group>

        {/* The calendar's own header, rebuilt -- see the note at the top of
            this file. What it carries is what a ballot needs: where you are,
            how to move, and how far to zoom. What it does not carry is Today,
            which is a week the poll is probably not asking about; the way back
            to the poll's own dates is offered beside it, and only when it is
            needed. */}
        <Group gap="xs" wrap="wrap" justify="space-between">
          <Group gap={4} wrap="nowrap">
            <ActionIcon
              variant="default"
              size="md"
              aria-label={`Previous ${view}`}
              onClick={() => setDate(step(date, view, -1))}
            >
              <CaretLeftIcon size={14} />
            </ActionIcon>
            <Text size="sm" fw={500} ta="center" miw={170}>
              {rangeLabel(date, view)}
            </Text>
            <ActionIcon
              variant="default"
              size="md"
              aria-label={`Next ${view}`}
              onClick={() => setDate(step(date, view, 1))}
            >
              <CaretRightIcon size={14} />
            </ActionIcon>
            {/* Navigated off the poll's own dates, which a month of arrows
                makes easy. A way back, rather than a rule against leaving: a
                voter checking what else is on that week is doing something
                reasonable. */}
            {adrift && (
              <Anchor component="button" type="button" size="xs" onClick={() => setDate(days[0])}>
                Back to {formatDay(days[0])}
              </Anchor>
            )}
          </Group>
          <SegmentedControl
            size="xs"
            value={view}
            onChange={(next) => setView(next as ScheduleViewLevel)}
            data={VIEWS.map((level) => ({ value: level, label: VIEW_LABELS[level] }))}
          />
        </Group>

        {view === 'month' ? (
          <MonthView
            date={date}
            withHeader={false}
            events={events}
            renderEventBody={eventBody}
            // A month has no hours in it, so a day is the smallest thing there
            // is to say something about -- which makes the day itself the
            // gesture rather than a shortcut for one.
            onDayClick={fillDay}
            withDragSlotSelect
            onSlotDragEnd={fillDays}
            getDayProps={(day) => (inBounds.has(day) ? {} : outOfBounds)}
            firstDayOfWeek={1}
            withOutsideDays={false}
            maxEventsPerDay={1}
          />
        ) : view === 'day' ? (
          <DayView
            date={date}
            withHeader={false}
            {...gridProps(schedule)}
            events={events}
            withDragSlotSelect
            onSlotDragEnd={paint}
            onTimeSlotClick={({ slotStart, slotEnd }) => paint(slotStart, slotEnd)}
            getTimeSlotProps={({ start }) =>
              paintable(schedule, inBounds, start.slice(0, 10), start.slice(11, 16))
                ? undefined
                : outOfBounds
            }
            // One day on screen and no heading over it, so there is nothing to
            // fill it in a click. There is no need: a drag from the top of the
            // column to the bottom is the same gesture and the same result, and
            // this is the view somebody has zoomed into to be precise.
            withAllDaySlot={false}
            withCurrentTimeIndicator={false}
            withAgenda={false}
          />
        ) : (
          <WeekView
            date={date}
            withHeader={false}
            {...gridProps(schedule)}
            events={events}
            withDragSlotSelect
            onSlotDragEnd={paint}
            onTimeSlotClick={({ slotStart, slotEnd }) => paint(slotStart, slotEnd)}
            // The day's own column heading, which with the header off is the
            // only thing left in this view that changes the date -- so it is a
            // callback with one caller and one meaning rather than a guess
            // about which control fired. Its accessible name says so too; see
            // LABELS.
            onDateChange={fillDay}
            labels={LABELS}
            // An hour the poll is not asking about is not an hour to paint --
            // whether because the whole day is out, or because that day starts
            // at six. Disabled rather than hidden: which hours are in bounds is
            // part of what the poll is asking, and a week with holes in it says
            // so plainly.
            getTimeSlotProps={({ start }) =>
              paintable(schedule, inBounds, start.slice(0, 10), start.slice(11, 16))
                ? undefined
                : outOfBounds
            }
            withAllDaySlots={false}
            withWeekNumber={false}
            // Monday first, pinned rather than inherited, because `visibleRange`
            // works out which week is on screen and the two have to agree.
            firstDayOfWeek={1}
            // The clock says nothing here: "now" is in the reader's own zone and
            // the grid is in the poll's, so a line across it would be wrong by
            // however far apart the two are.
            withCurrentTimeIndicator={false}
            withAgenda={false}
          />
        )}

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

/**
 * The week grid gives every day heading the accessible name
 * `<weekday label> <date>`, and that label is the one string this ballot has
 * to say what the heading does. A screen reader reads "Fill the whole day
 * 2026-09-04" rather than "Weekday 2026-09-04", which is the difference
 * between a control and a caption.
 */
const LABELS = { weekday: 'Fill the whole day' }

/**
 * The one thing drawn inside an event: a day's summary, in a colour the
 * calendar would otherwise pick badly. The painted runs carry no title at all,
 * so this is only ever the day lines -- see `inkFor`.
 */
function eventBody(event: ScheduleEventData) {
  return <span style={{ color: event.payload?.ink as string | undefined }}>{event.title}</span>
}

/** A cell or a day the poll is not asking about: visible, and not paintable. */
const outOfBounds = {
  disabled: true,
  style: { background: 'var(--mantine-color-gray-light)', cursor: 'not-allowed' },
}

/**
 * The vertical axis the two time grids are drawn on, which is the poll's
 * `window` and therefore the union of every day's hours -- see PollSchedule.
 * A day with narrower hours than the poll is drawn on the same axis with the
 * rest of it greyed out, rather than on a shorter grid of its own: two days
 * side by side whose rows did not line up would be unreadable.
 */
function gridProps(schedule: PollSchedule) {
  return {
    startTime: `${schedule.window.start}:00`,
    // 24:00 is midnight at the end of the day, which the calendar cannot draw
    // as a time of day; a second before it is the same last row.
    endTime: schedule.window.end === '24:00' ? '23:59:59' : `${schedule.window.end}:00`,
    intervalMinutes: schedule.granularity,
    slotHeight: schedule.granularity < 30 ? 28 : 40,
  }
}

/** One view's worth of movement: a day, a week or a month, forwards or back. */
function step(date: string, view: ScheduleViewLevel, by: number): string {
  const unit = view === 'month' ? 'month' : view === 'week' ? 'week' : 'day'
  return dayjs(date).add(by, unit).format('YYYY-MM-DD')
}

/**
 * What the header says you are looking at: `Fri 4 Sep`, `Mon 31 Aug – Sun 6
 * Sep`, `September 2026`.
 *
 * Formatted from the view's own date, which is a date somebody navigated to
 * rather than a time in the poll's grid -- so `dayjs` is safe here in a way it
 * would not be over a window start: it parses `YYYY-MM-DD` as a wall-clock
 * date and no instant is built from it. The days inside the grid are still
 * formatted by hand; see `formatWindow`.
 */
function rangeLabel(date: string, view: ScheduleViewLevel): string {
  if (view === 'day') return formatDay(date)
  if (view === 'month') return dayjs(date).format('MMMM YYYY')
  const { from, to } = visibleRange(date, view)
  return `${formatDay(from)} – ${formatDay(to)}`
}

/**
 * The first and last dates a view has on screen.
 *
 * Only ever used to decide whether the calendar has wandered off the poll, so
 * it is allowed to be arithmetic rather than exact: a month view shows a few
 * days either side of its month and this does not count them, which at worst
 * offers a way back to the poll on a screen that already shows one day of it.
 */
function visibleRange(date: string, view: ScheduleViewLevel): { from: string; to: string } {
  const on = dayjs(date)
  if (view === 'day') return { from: date, to: date }
  if (view === 'month') {
    return {
      from: on.startOf('month').format('YYYY-MM-DD'),
      to: on.endOf('month').format('YYYY-MM-DD'),
    }
  }
  // Monday-first, to match `firstDayOfWeek` on the week grid. Worked out here
  // rather than with `startOf('week')`, which follows dayjs's locale and
  // defaults to Sunday.
  const back = (on.day() + 6) % 7
  const monday = on.subtract(back, 'day')
  return { from: monday.format('YYYY-MM-DD'), to: monday.add(6, 'day').format('YYYY-MM-DD') }
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
