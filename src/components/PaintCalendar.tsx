import { useLayoutEffect, useRef, useState } from 'react'
import { Group, Tooltip } from '@mantine/core'
import {
  DayView,
  MonthView,
  ScheduleHeader,
  WeekView,
  type DayOfWeek,
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
  weekdayOf,
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
 * - **The range in the header fills everything on screen**, which is the one
 *   gesture here that is not the library's at all: its own label made clickable
 *   (`fillVisible`), so the answer to "all of September" is the word September.
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

/**
 * An arrow with nowhere left to go; see `stepTo`.
 *
 * `disabled` is what stops the press, and the other two are what say so: the
 * library's control has no disabled state in its own stylesheet, so
 * `interactive` takes away the pointer and the hover and the dimming is the
 * rest of it.
 */
function dead(is: boolean) {
  return { disabled: is, interactive: !is, style: is ? { opacity: 0.4 } : undefined }
}

/**
 * The time column, held still while the days scroll under it.
 *
 * A week of seven days will not fit on a phone -- the library holds every day
 * column to a five-rem minimum and scrolls the lot sideways -- and what
 * scrolled out of sight first was the one column saying what the rows are. A
 * grid of unlabelled cells is not a grid.
 *
 * Three declarations, and the first is the one that needs explaining.
 * `weekViewInner` is `overflow: hidden`, which makes it a scroll container in
 * its own right, and a sticky element sticks to the nearest one of those --
 * a box that never scrolls, so it would not stick at all. Opening it up hands
 * the column back to the scroll area that actually moves. Nothing is lost by
 * it: every event this calendar draws is positioned inside the day column it
 * belongs to, and the rounded corner is clipped by `weekViewRoot`, which is
 * outside the scroll area and still hides what leaves it.
 */
const STICKY_TIMES = {
  weekViewInner: { overflow: 'visible' },
  weekViewSlotLabels: {
    position: 'sticky',
    insetInlineStart: 0,
    // Over the painted runs, which the library's own sheet puts at 2.
    zIndex: 3,
    // The first day column's own border, redrawn on the sticky edge -- the
    // real one travels with the day that owns it.
    boxShadow: '1px 0 0 var(--week-view-border-color)',
  },
  // The corner above it, which is inside the header's stacking context and so
  // needs only to beat the day headings sliding beneath it. Transparent by
  // default, and a transparent pane is not a pane.
  weekViewCorner: {
    position: 'sticky',
    insetInlineStart: 0,
    zIndex: 1,
    background: 'var(--mantine-color-body)',
  },
} as const

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
  confine,
  earliest,
  hideEmptyWeekdays,
  slotHeight,
}: {
  schedule: PollSchedule
  /** The cells that may be painted at all; everything else is drawn greyed. */
  bounds: Bounds
  /** The hours the grid is drawn between -- the poll's `window` on a ballot. */
  axis: DailyWindow
  painting: Record<GranuleKey, number>
  /** What a gesture writes. 0 rubs out, and never toggles; see `fillCells`. */
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
  /**
   * Keep the arrows on the poll: they step to the next range that has a day in
   * bounds on it, and stop at the ends.
   *
   * **The ballot is the caller, and it is the only screen where the poll's own
   * days are the whole of the answer.** A voter has nothing to say about a week
   * the poll is not asking about, so a Next that lands on one is a press that
   * empties the screen and asks them to work out why -- and on a poll about
   * three days in September the month arrows do that in one press. Stepping
   * over the empty ranges rather than into them means every press changes what
   * there is to answer, and a disabled arrow says there is no more of it.
   *
   * The two painting screens do not set it, and must not: on the create form
   * the bounds *are* the answer, so an empty calendar would confine the arrows
   * to nothing at all, and a poll collecting its times is asking about days
   * nobody has proposed yet.
   */
  confine?: boolean
  /**
   * The earliest day the arrows will reach, where there is one.
   *
   * The create form's floor, and a weaker rule than `confine`: it says which
   * way is out of the question rather than which ranges are worth showing. A
   * poll cannot ask about a day that has already gone (see `ScheduleFields`),
   * so the month before it is a screen of greyed cells and no way to say
   * anything on it.
   */
  earliest?: ScheduleDay
  /**
   * Leave out the weekdays the poll has nothing on, in the two grids that are
   * laid out by weekday.
   *
   * A poll about a Friday, a Saturday and a Sunday draws four columns of greyed
   * cells for the days it is not asking about, and on a phone those four are
   * most of the width. Dropping them makes the three that matter three times
   * wider, which is the difference between a grid that is scanned and one that
   * is scrolled.
   *
   * The ballot again, and for the ballot's reason: its bounds are the whole of
   * what can ever be answered, so a weekday with nothing on it is a weekday
   * nothing will ever be on. On the two painting screens an empty Monday is an
   * empty Monday somebody is about to paint.
   */
  hideEmptyWeekdays?: boolean
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

  // The header, and where its top sat on screen when the zoom last changed;
  // see `showView`. `null` between changes, so that scrolling for any other
  // reason -- reading the page, moving a week -- is never corrected.
  const header = useRef<HTMLDivElement>(null)
  const held = useRef<number | null>(null)

  /**
   * Change the zoom, and leave the calendar where it was on screen.
   *
   * The three views are wildly different heights: a week of half-hours is over
   * a thousand pixels tall and the same poll's month is a few hundred. So
   * switching between them moves the page under the reader -- the document
   * becomes shorter than the position it is scrolled to, the browser clamps
   * that position, and a calendar that was filling the screen is suddenly
   * halfway down it. Nothing scrolled on purpose, which is exactly why it
   * reads as a fault rather than as a consequence.
   *
   * So the calendar's own top is measured before the switch and the page is
   * scrolled by however far it moved after it, which pins the header and lets
   * the grid change size below it. Where the document is too short to hold the
   * position the reader was at, there is nowhere to put them back and the
   * effect below brings the calendar to the top of the screen instead.
   */
  function showView(next: ScheduleViewLevel) {
    held.current = header.current?.getBoundingClientRect().top ?? null
    setView(next)
  }

  // After React has committed the new view and before the browser paints it,
  // so neither correction is ever a visible jump and back.
  useLayoutEffect(() => {
    const was = held.current
    held.current = null
    const row = header.current
    if (was === null || !row) return

    // Reading the rectangle forces layout, so this is the new view's geometry
    // with the browser's own clamping already applied. Nothing above the header
    // moved, so all the difference can be is that clamping.
    window.scrollBy({ top: row.getBoundingClientRect().top - was })

    // And when it could not be undone, the page had no room for the position
    // the reader was at: they were a thousand pixels into a week of half-hours
    // and the month that replaced it is a few hundred tall, so the scroll above
    // asked to go past the bottom of a document that had just got shorter. The
    // reader cannot be put back, so the calendar is brought to the top of the
    // screen instead -- the new view whole, rather than the part of it the
    // clamp happened to leave on screen. `scrollMarginTop` is what keeps it out
    // from under the app's own fixed header; see the element itself.
    if (row.getBoundingClientRect().top > was + 1) row.scrollIntoView({ block: 'start' })
  }, [showing])

  /**
   * Set every cell in a half-open range to the brush, skipping what is out --
   * or, where the range is already exactly that, take it back.
   *
   * **A stroke toggles, the same way every other gesture on this calendar
   * does.** Painting over what you have just painted is how somebody says "not
   * that after all": it is the gesture already to hand, it is the one the day
   * heading and the header's range have always answered to, and without it the
   * only way back from a stroke is to find the brush that means nothing and
   * lay it over the same cells. See `fillCells` for the rule and for why a
   * brush of 0 is exempt from it.
   */
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
    fillCells(keys)
  }

  /** What a click covers across a run of days, from one date to another. */
  function cellsAcross(from: string, to: string): GranuleKey[] {
    // Every day in the range rather than only the days already in bounds: on a
    // calendar that is collecting times the range is exactly the days nobody
    // has proposed yet, and `asks` is what says which of them count.
    return daysBetween(from, to).filter(asks).flatMap(fill)
  }

  /**
   * Lay the brush over a set of cells a gesture asked for, or clear them.
   *
   * **It toggles**, and that is the difference between a shortcut and a trap.
   * There is no undo beside any of these gestures; a stretch that is already
   * exactly what the brush would make it is a stretch the gesture was meant to
   * take back. Anything else fills -- including one that is half-marked, or
   * marked at a different rating, both of which are answers the gesture is
   * being used to replace.
   *
   * A brush of 0 never toggles: clearing a cleared day would fill it, which is
   * the one thing a brush that means "not then" must never do.
   */
  function fillCells(cells: GranuleKey[]) {
    if (cells.length === 0) return
    const already = brush > 0 && cells.every((key) => painting[key] === brush)
    onPaint(cells, already ? 0 : brush)
  }

  /** Fill a whole day, or clear it. */
  function fillDay(on: string) {
    // `YYYY-MM-DD` from the month grid's day and `YYYY-MM-DD 00:00:00` from
    // the week grid's heading, which is the shape every date callback in this
    // library hands back. Sliced here rather than at each call site, so the two
    // gestures are one function.
    const day = on.slice(0, 10)
    // A day the poll is not asking about is not filled by its heading. The
    // month grid disables such a day outright, but a week grid's heading sits
    // above the disabled cells rather than among them -- and on the create
    // form, where a heading is how a day joins the poll at all, that heading is
    // the one way a day behind the floor could still be marked.
    if (!asks(day)) return
    fillCells(fill(day))
  }

  /**
   * The same over a run of days, from a drag across the month.
   *
   * Never toggles, unlike the two clicks: a drag says which days it means by
   * covering them, so there is no gesture left over to mean "and take that
   * back" -- releasing over a stretch that is already marked would undo the
   * drag that made it.
   */
  function fillDays(fromDay: string, toDay: string) {
    onPaint(cellsAcross(fromDay.slice(0, 10), toDay.slice(0, 10)), brush)
  }

  const inView = visibleRange(date, showing)
  // Whether the calendar has been navigated off the poll entirely. Worth
  // asking now that a month view exists: the arrows move a month at a time,
  // and a poll asking about three days in September is one press away from a
  // screen with nothing on it and no clue why. A confined calendar cannot get
  // there at all; see `stepTo`.
  const adrift = days.length > 0 && (days[days.length - 1] < inView.from || days[0] > inView.to)

  /**
   * Where one arrow goes, or null when there is nowhere for it to go and it is
   * drawn as a dead control rather than as a press that changes nothing.
   *
   * Unconfined this is a view's worth of movement and nothing more, save for
   * the floor `earliest` puts under it. Confined it is a *jump*: the nearest
   * day the poll asks about that this range is not already showing, which the
   * containing week or month is then drawn around. So the arrows walk the poll
   * rather than the calendar -- on a poll about a Friday in September and a
   * Friday in November, Next is one press rather than two through October.
   */
  function stepTo(by: 1 | -1): string | null {
    if (confine) {
      const day =
        by > 0 ? days.find((on) => on > inView.to) : days.findLast((on) => on < inView.from)
      return day ?? null
    }
    const next = step(date, showing, by)
    // The whole of the range has to be behind the floor before the arrow dies,
    // rather than its first day: the week the floor falls in is a week with
    // days in it, and the poll is asking about them.
    if (by < 0 && earliest !== undefined && visibleRange(next, showing).to < earliest) return null
    return next
  }

  const back = stepTo(-1)
  const forward = stepTo(1)

  /**
   * Everything on screen, from the range the header is already naming.
   *
   * This is the header's own label made into the gesture it describes: a reader
   * looking at September clicks *September 2026* to answer for the whole of it,
   * and the same control on the week grid answers for the week and on the day
   * grid for the day. It replaced a button beside the calendar reading *apply 5
   * to every time*, which was the same idea attached to nothing a reader was
   * looking at -- it answered for the whole poll however much of it was on
   * screen, so a fortnight in two halves could only be answered in one go or
   * cell by cell.
   *
   * It reaches exactly what is drawn, which is what makes the label honest: the
   * month grid hides the days either side of its month (`withOutsideDays`) and
   * both time grids run Monday to Sunday, which is what `visibleRange` works
   * out. Out-of-bounds days inside the range are left alone, by `cellsAcross`.
   */
  function fillVisible() {
    fillCells(cellsAcross(inView.from, inView.to))
  }

  /**
   * The weekdays with nothing on them **in what is on screen**, which the two
   * grids laid out by weekday leave out; see `hideEmptyWeekdays`.
   *
   * **Asked of the range rather than of the poll**, which is the whole of what
   * makes it right. A poll about a Saturday, a Sunday and the Monday after
   * spans two weeks and uses three weekdays, and taken poll-wide that drew
   * three columns on *both* weeks -- a Monday on the first that the poll is
   * not asking about, and a Saturday and Sunday on the second. Each week is
   * its own question, so each is drawn with the days it actually holds: two
   * columns, then one.
   *
   * The month asks the same question of its own month, which is as fine as it
   * can be: one grid of columns is shared by all its weeks, so per-week is not
   * a thing a month can express.
   *
   * Said through the library's own `weekendDays` and `withWeekendDays`, which
   * is its one way of dropping a column and the only one that keeps the
   * month's rows and its event spans in step with the drop. The name is the
   * library's and not a description of the list: what is in it is what is not
   * drawn, and a week that does hold a Saturday does not put Saturday in it --
   * which also spares that day the red the library paints a weekend heading
   * in, a colour that means nothing on an availability grid.
   *
   * Empty where there is nothing to hide, and it can never be all seven: a
   * range holding no day of the poll is the first case here, and one holding
   * any day at all has that day's weekday in use.
   */
  const onScreen = days.filter((on) => on >= inView.from && on <= inView.to)
  const emptyWeekdays: DayOfWeek[] =
    !hideEmptyWeekdays || onScreen.length === 0
      ? []
      : ([0, 1, 2, 3, 4, 5, 6] as DayOfWeek[]).filter(
          (weekday) => !onScreen.some((on) => weekdayOf(on) === weekday),
        )
  const byWeekday = {
    weekendDays: emptyWeekdays,
    withWeekendDays: emptyWeekdays.length === 0,
  }

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
      <ScheduleHeader
        ref={header}
        // Clear of the app's own header, which is fixed over the top of the
        // page: this row is what a view change scrolls back into view, and
        // `scrollIntoView` measures the viewport rather than what is painted
        // over it. See `showView`.
        style={{ scrollMarginTop: 'var(--app-shell-header-offset, 0px)' }}
      >
        <div className={ScheduleHeader.classes.navigationGroup}>
          <ScheduleHeader.Previous
            aria-label={`Previous ${showing}`}
            {...dead(back === null)}
            onClick={() => back !== null && setDate(back)}
          />
          {/* The range, which says what is on screen and fills it; see
              `fillVisible`. The accessible name carries the label rather than
              replacing it, so a screen reader is told both -- "Apply to all of
              September 2026" -- the way the week grid's day headings are; see
              LABELS. */}
          <Tooltip label="Apply to everything on screen" withArrow>
            <ScheduleHeader.Control
              miw={190}
              aria-label={`Apply to all of ${rangeLabel(date, showing)}`}
              onClick={fillVisible}
            >
              {rangeLabel(date, showing)}
            </ScheduleHeader.Control>
          </Tooltip>
          <ScheduleHeader.Next
            aria-label={`Next ${showing}`}
            {...dead(forward === null)}
            onClick={() => forward !== null && setDate(forward)}
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
              // Not `setView`: the three views are different heights, and
              // changing one without holding the calendar still scrolls the
              // page out from under the reader. See `showView`.
              onChange={showView}
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
          {...byWeekday}
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
          {...byWeekday}
          // The time column, pinned so that scrolling a narrow week sideways
          // does not take the hours with it; see STICKY_TIMES.
          styles={STICKY_TIMES}
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
  return `${dayjs(from).format('MMM DD')} – ${dayjs(to).format('MMM DD')}`
}

/**
 * The first and last dates a view has on screen.
 *
 * Exact, and it has to be: as well as deciding whether the calendar has
 * wandered off the poll, it is what the header's range control fills. The two
 * things that make it exact are set on the grids themselves -- the month draws
 * only its own days (`withOutsideDays={false}`, so the week either side of it
 * is blank rather than borrowed) and both time grids start on Monday
 * (`firstDayOfWeek={1}`) -- so a change to either of those belongs here too.
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
