import { useState } from 'react'
import { Group } from '@mantine/core'
import {
  DayView,
  MonthView,
  ScheduleHeader,
  WeekView,
  type ScheduleEventData,
  type ScheduleViewLevel,
} from '@mantine/schedule'
// Imported here rather than in main.tsx so it travels in this component's own
// chunk: Vite splits a lazy chunk's CSS with it, and the two things that draw
// a calendar -- the time ballot and the create form -- are both behind a
// lazy() of their own. A poll that chooses an option never fetches it.
import '@mantine/schedule/styles.css'
import dayjs from 'dayjs'
import {
  boundsOnDay,
  daysOf,
  formatDay,
  granuleKey,
  isDaily,
  toMinutes,
  type Bounds,
  type GranuleKey,
  type ScheduleDay,
} from '../lib/schedule'
import type { DailyWindow, PollSchedule } from '../lib/types'

/**
 * A calendar somebody paints, and the only place in this app that knows how.
 *
 * It is used twice and the two uses are the same gesture asked two questions:
 * a **voter** paints how good each time is for them, and a **creator** paints
 * which times the poll is asking about at all. Both are a rating per cell --
 * the creator's happens to have two values -- so both are one component, one
 * set of drag handlers and one header. Before this the create form asked for
 * per-day hours as rows of dropdowns, which is the same answer typed out.
 *
 * **What `@mantine/schedule` is**, since building on it looks stranger than it
 * is: an event calendar in the Google Calendar mould, whose primitive is an
 * event with a start, an end and a colour. It has no notion of a rated cell
 * and no availability grid. The adaptation is a handful of its props, and each
 * one is a gesture:
 *
 * - `withDragSlotSelect` with `onSlotDragEnd` gives the drag, and
 *   `onTimeSlotClick` covers a single tap -- a plain click is not a drag of
 *   length zero to that hook, it is nothing at all, so both are wired.
 * - The painting is rendered back as events, which the caller builds: the two
 *   callers colour a cell by different things.
 * - **A day's column heading fills that day**, through `onDateChange`.
 * - In the month view, which has no time grid at all, a day *is* the unit:
 *   `onDayClick` fills one and a drag across several fills those.
 *
 * **The header is ours, and that is what makes the heading gesture honest.**
 * `onDateChange` is fired by four things in a week grid -- the previous and
 * next controls, Today, and the day heading -- and by two in a month. Turning
 * the library's header off (`withHeader={false}`) leaves exactly one caller in
 * each view: the day heading in the week grid, and nothing at all in the other
 * two. So the callback means one thing, and the code reads as what it is
 * rather than as a guess about which control fired.
 */

/**
 * The views offered, which is the library's four minus the year: a year of
 * months is a screen with nothing on it to paint, and no poll spans one.
 *
 * A poll answered in whole days gets the month alone. There are no hours to
 * paint on one -- a granule *is* a day -- so a week grid would be a wall of
 * cells that all do the same thing and a day grid would be one cell.
 */
const VIEWS: readonly ScheduleViewLevel[] = ['day', 'week', 'month']

/**
 * The week grid gives every day heading the accessible name
 * `<weekday label> <date>`, and that label is the one string this calendar has
 * to say what the heading does. A screen reader reads "Fill the whole day
 * 2026-09-04" rather than "Weekday 2026-09-04", which is the difference
 * between a control and a caption.
 */
const LABELS = { weekday: 'Fill the whole day' }

/**
 * The one thing drawn inside an event: a month chip's label, in a colour the
 * calendar would otherwise pick badly.
 *
 * A chip takes its text colour from Mantine's variant resolver, and at the
 * darker end of a rating ramp that comes back close enough to the background
 * to be unreadable -- `green.9` on `green.9`. The two time grids draw runs with
 * no title at all, so this is only ever the month.
 */
function eventBody(event: ScheduleEventData) {
  return <span style={{ color: event.payload?.ink as string | undefined }}>{event.title}</span>
}

/** A cell or a day the poll is not asking about: visible, and not paintable. */
const outOfBounds = {
  disabled: true,
  style: { background: 'var(--mantine-color-gray-light)', cursor: 'not-allowed' },
}

export function PaintCalendar({
  schedule,
  bounds,
  axis,
  painting,
  brush,
  onPaint,
  buildEvents,
  fillOnDay,
  canPaint,
  dayInBounds,
  slotHeight,
}: {
  schedule: PollSchedule
  /** The cells that may be painted at all; everything else is drawn greyed. */
  bounds: Bounds
  /** The hours the grid is drawn between -- the poll's `window` on a ballot. */
  axis: DailyWindow
  painting: Record<GranuleKey, number>
  /** What a gesture writes. 0 rubs out, and never toggles; see `fillDay`. */
  brush: number
  /**
   * Write one value over a set of cells. The caller keeps the painting,
   * because the caller is the one that has to send it somewhere.
   */
  onPaint: (keys: GranuleKey[], value: number) => void
  /**
   * The painting as events, asked per view: a month has no rows to lay a run
   * of granules on, so its callers draw something else there. Called during
   * render rather than passed as an array so that switching view cannot show
   * the previous view's events for a frame.
   */
  buildEvents: (view: ScheduleViewLevel) => ScheduleEventData[]
  /**
   * What clicking a whole day covers, where that is not simply every cell the
   * day has in bounds.
   *
   * The create form is the caller that needs it: every cell of a chosen day is
   * paintable there, and a day-fill is meant to lay down the creator's own
   * earliest and latest rather than midnight to midnight. On a ballot the two
   * are the same set and this is left out.
   */
  fillOnDay?: (day: ScheduleDay) => GranuleKey[]
  /**
   * Whether one cell may be painted, where that is not simply whether it is in
   * bounds.
   *
   * The suggestion calendar is the caller that needs it: a poll collecting its
   * times is asking for days nobody has proposed yet, so its bounds are the
   * windows already on the list and what may be painted is any cell of the
   * grid, on any day. `bounds` still decides which days the calendar opens on
   * and whether it has wandered off them.
   */
  canPaint?: (key: GranuleKey) => boolean
  /** And whether a whole day is one the poll is asking about; see `canPaint`. */
  dayInBounds?: (day: ScheduleDay) => boolean
  slotHeight?: number
}) {
  const days = daysOf(bounds)
  const daily = isDaily(schedule)
  const open = canPaint ?? ((key: GranuleKey) => bounds.has(key))
  const asks = dayInBounds ?? ((day: ScheduleDay) => boundsOnDay(bounds, day).length > 0)
  const fill = fillOnDay ?? ((day: ScheduleDay) => boundsOnDay(bounds, day))

  // Which date is on screen, and at what zoom. A poll can span more than one
  // week, and the calendar opens on the first day it is asking about rather
  // than on today -- which may be months away from the poll and is never where
  // the answer is. One date across all three views, so switching between them
  // stays where the reader was.
  const [date, setDate] = useState(() => days[0] ?? dayjs().format('YYYY-MM-DD'))
  const [view, setView] = useState<ScheduleViewLevel>(daily ? 'month' : 'week')
  const showing = daily ? 'month' : view

  const events = buildEvents(showing)

  /** Set every cell in a half-open range to the brush, skipping what is out. */
  function paint(fromSlot: string, toSlot: string) {
    // `YYYY-MM-DD HH:mm:ss` on the way in, and the grid is keyed to the
    // minute; the end is the end of the last slot dragged over, so the range
    // is half-open.
    const day = fromSlot.slice(0, 10)
    const from = toMinutes(fromSlot.slice(11, 16))
    const to = toMinutes(toSlot.slice(11, 16))

    const keys: GranuleKey[] = []
    for (let at = from; at < to; at += schedule.granularity) {
      // Filtered cell by cell rather than day by day, because a day can be in
      // bounds for part of itself: a drag from 09:00 down a Friday that only
      // starts at 18:00 marks the evening and leaves the morning alone, rather
      // than being refused whole.
      const key = granuleKey(day, at)
      if (open(key)) keys.push(key)
    }
    onPaint(keys, brush)
  }

  /**
   * Fill a whole day, or clear it.
   *
   * **It toggles**, and that is the difference between a shortcut and a trap.
   * The gesture is one click on a strip with no undo beside it; a day that is
   * already exactly what the brush would make it is a day the click was meant
   * to take back. Anything else fills -- including a day that is half-marked,
   * or marked at a different rating, both of which are answers the click is
   * being used to replace.
   *
   * A brush of 0 never toggles: clearing a cleared day would fill it, which is
   * the one thing a brush that means "not then" must never do.
   */
  function fillDay(on: string) {
    // `YYYY-MM-DD` from the month grid's day and `YYYY-MM-DD 00:00:00` from
    // the week grid's heading, which is the shape every date callback in this
    // library hands back. Sliced here rather than at each call site, so the two
    // gestures are one function.
    const day = on.slice(0, 10)
    const cells = fill(day)
    if (cells.length === 0) return
    const already = brush > 0 && cells.every((key) => painting[key] === brush)
    onPaint(cells, already ? 0 : brush)
  }

  /** The same over a run of days, from a drag across the month. Never toggles. */
  function fillDays(fromDay: string, toDay: string) {
    const first = fromDay.slice(0, 10)
    const last = toDay.slice(0, 10)
    // Every day in the dragged range, rather than only the days already in
    // bounds: on a calendar that is collecting times the range is exactly the
    // days nobody has proposed yet.
    const cells = daysBetween(first, last).filter(asks).flatMap(fill)
    onPaint(cells, brush)
  }

  const inView = visibleRange(date, showing)
  // Whether the calendar has been navigated off the poll entirely. Worth
  // asking now that a month view exists: the arrows move a month at a time,
  // and a poll asking about three days in September is one press away from a
  // screen with nothing on it and no clue why.
  const adrift = days.length > 0 && (days[days.length - 1] < inView.from || days[0] > inView.to)

  const grid = {
    startTime: `${axis.start}:00`,
    // 24:00 is midnight at the end of the day, which the calendar cannot draw
    // as a time of day; a second before it is the same last row.
    endTime: axis.end === '24:00' ? '23:59:59' : `${axis.end}:00`,
    intervalMinutes: schedule.granularity,
    slotHeight: slotHeight ?? (schedule.granularity < 30 ? 28 : 40),
    withAllDaySlots: false as const,
    withCurrentTimeIndicator: false as const,
    withAgenda: false as const,
    withDragSlotSelect: true as const,
    onSlotDragEnd: paint,
    getTimeSlotProps: ({ start }: { start: string }) =>
      open(granuleKey(start.slice(0, 10), toMinutes(start.slice(11, 16))))
        ? undefined
        : outOfBounds,
  }

  return (
    <>
      {/* The calendar's own header, rebuilt -- see the note at the top of this
          file. What it carries is what a ballot needs: where you are, how to
          move, and how far to zoom. What it does not carry is Today, which is
          a week the poll is probably not asking about; the way back to the
          poll's own dates is offered beside it, and only when it is needed.

          Rebuilt out of the library's own pieces rather than out of ours:
          `ScheduleHeader.Previous`, `.Control`, `.Next` and `.ViewSelect` are
          plain buttons taking an ordinary onClick -- no navigation context
          behind them -- so using them costs nothing and buys a header that is
          the calendar's rather than one sitting above it in a different
          shape. `navigationGroup` comes with them, and with it the container
          query that lets the cluster fill a narrow screen. */}
      <ScheduleHeader>
        <div className={ScheduleHeader.classes.navigationGroup}>
          <ScheduleHeader.Previous
            aria-label={`Previous ${showing}`}
            onClick={() => setDate(step(date, showing, -1))}
          />
          <ScheduleHeader.Control interactive={false} miw={190}>
            {rangeLabel(date, showing)}
          </ScheduleHeader.Control>
          <ScheduleHeader.Next
            aria-label={`Next ${showing}`}
            onClick={() => setDate(step(date, showing, 1))}
          />
        </div>

        {/* Navigated off the poll's own dates, which a month of arrows makes
            easy. A way back, rather than a rule against leaving: a voter
            checking what else is on that week is doing something reasonable.
            A control of the header's own, because it belongs to the row it
            sits in -- it moves the calendar rather than going anywhere, and a
            link the width of a date between two icon buttons was the one
            thing there that did not look like a control. */}
        {adrift && (
          <Group gap="xs" wrap="nowrap">
            {/* `tt="none"` because the library capitalises every word in a
                control, which is right for its own one-word labels (Day,
                Week, Today) and turns this one into "Back To Fri Feb 20". */}
            <ScheduleHeader.Control tt="none" onClick={() => setDate(days[0])}>
              Back to {formatDay(days[0])}
            </ScheduleHeader.Control>
          </Group>
        )}

        {/* A poll answered in whole days has one view and no switch: see VIEWS. */}
        {!daily && (
          <Group gap="xs" wrap="nowrap" style={{ marginInlineStart: 'auto' }}>
            <ScheduleHeader.ViewSelect
              views={VIEWS}
              value={view}
              onChange={(next) => setView(next)}
            />
          </Group>
        )}
      </ScheduleHeader>

      {showing === 'month' ? (
        <MonthView
          date={date}
          withHeader={false}
          events={events}
          // A month has no hours in it, so a day is the smallest thing there
          // is to say something about -- which makes the day itself the
          // gesture rather than a shortcut for one.
          onDayClick={fillDay}
          withDragSlotSelect
          onSlotDragEnd={fillDays}
          getDayProps={(day) => (asks(day) ? {} : outOfBounds)}
          firstDayOfWeek={1}
          withOutsideDays={false}
          renderEventBody={eventBody}
        />
      ) : showing === 'day' ? (
        <DayView
          date={date}
          withHeader={false}
          {...grid}
          withAllDaySlot={false}
          events={events}
          onTimeSlotClick={({ slotStart, slotEnd }) => paint(slotStart, slotEnd)}
          // One day on screen and no heading over it, so there is nothing to
          // fill it in a click. There is no need: a drag from the top of the
          // column to the bottom is the same gesture and the same result, and
          // this is the view somebody has zoomed into to be precise.
        />
      ) : (
        <WeekView
          date={date}
          withHeader={false}
          {...grid}
          events={events}
          onTimeSlotClick={({ slotStart, slotEnd }) => paint(slotStart, slotEnd)}
          // The day's own column heading, which with the header off is the
          // only thing left in this view that changes the date -- so it is a
          // callback with one caller and one meaning rather than a guess about
          // which control fired. Its accessible name says so too; see LABELS.
          onDateChange={fillDay}
          labels={LABELS}
          withWeekNumber={false}
          // Monday first, pinned rather than inherited, because `visibleRange`
          // works out which week is on screen and the two have to agree.
          firstDayOfWeek={1}
        />
      )}
    </>
  )
}

/** Every date from one to another, inclusive: what a drag across a month covers. */
function daysBetween(from: string, to: string): string[] {
  const days: string[] = []
  for (let on = dayjs(from); !on.isAfter(dayjs(to)); on = on.add(1, 'day')) {
    days.push(on.format('YYYY-MM-DD'))
  }
  return days
}

/** One view's worth of movement: a day, a week or a month, forwards or back. */
function step(date: string, view: ScheduleViewLevel, by: number): string {
  const unit = view === 'month' ? 'month' : view === 'week' ? 'week' : 'day'
  return dayjs(date).add(by, unit).format('YYYY-MM-DD')
}

/**
 * What the header says you are looking at: `Fri 4 Sep`, `Mon 31 Aug - Sun 6
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
