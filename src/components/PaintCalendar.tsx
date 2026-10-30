import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Group, Popover, Tooltip } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import {
  DayView,
  MonthView,
  ScheduleHeader,
  WeekView,
  type ScheduleEventData,
  type ScheduleViewLevel,
} from '@mantine/schedule'
// Imported here so the CSS is split into this lazy chunk rather than main.
import '@mantine/schedule/styles.css'
import dayjs from 'dayjs'
import {
  boundsOnDay,
  daysOf,
  formatDay,
  formatTimeOfDay,
  granuleKey,
  granulesBetween,
  isDaily,
  toMinutes,
  type Bounds,
  type GranuleKey,
  type ScheduleDay,
} from '../lib/schedule'
import { use24HourTime } from '../lib/clock'
import { DAY_BEFORE_MONTH, WEEK_STARTS_ON } from '../lib/locale'
import type { DailyWindow, PollSchedule } from '../lib/types'

/**
 * The paintable calendar shared by the time ballot, the create form and the
 * time-collecting card. Built on `@mantine/schedule`, an event calendar, by
 * rendering the painting back as background events and wiring its gestures:
 * drag and tap to paint, a day heading or month day to fill a day, a month
 * chip to erase, and the header's range label to fill what is on screen.
 *
 * The library's own header is off (`withHeader={false}`) and rebuilt from its
 * parts, which leaves the day heading as the only caller of `onDateChange` in
 * the week view -- so that callback can safely mean "fill this day".
 *
 * See "The ballot" in AGENTS.md for the reasoning behind each gesture.
 */

/** No year view. A daily poll gets the month alone. */
const VIEWS: readonly ScheduleViewLevel[] = ['day', 'week', 'month']

// The week grid names each day heading `<weekday label> <date>`; this makes a
// screen reader say "Fill the whole day 2026-09-04".
const LABELS = { weekday: 'Fill the whole day' }
const READ_LABELS = { weekday: 'Weekday' }

/**
 * What is drawn inside an event. `ink` overrides the chip text colour, which
 * Mantine picks unreadably at the dark end of the ramp. `fill` is for colours
 * that are not theme shades (the results' blends), which the library would
 * otherwise draw as a faint tint. `select`, with `fill`, makes the block a
 * button opening a popover: a read-only calendar's own slots and background
 * events take no clicks (`mode="static"`), so the press is the block's own.
 * `selected` opens it over `details`, and rings the block; `dismiss` is a
 * press outside or Escape. `label` names the block to a screen reader in full.
 * A month chip is a `<button>` of the library's own, which a static calendar
 * leaves unfocusable and deaf to clicks, so with `chip` the block takes the
 * press but not a button's role, which axe would call nested; the week and
 * day views are the way in from a keyboard.
 */
function eventBody(event: ScheduleEventData) {
  const hint = event.payload?.hint as string | undefined
  const fill = event.payload?.fill as string | undefined
  const ink = event.payload?.ink as string | undefined
  const select = event.payload?.select as (() => void) | undefined
  const selected = event.payload?.selected === true
  const details = event.payload?.details as ReactNode
  const dismiss = event.payload?.dismiss as (() => void) | undefined
  const chip = event.payload?.chip === true
  const label = (event.payload?.label as string | undefined) ?? hint
  if (!fill) return <span style={{ color: ink }}>{event.title}</span>
  // pointerEvents is restored so the hint shows on hover; `fill` is only set
  // on read-only calendars, where nothing underneath needs the pointer.
  const block = (
    <span
      // The popover says it all once it is open.
      title={selected ? undefined : hint}
      style={{
        position: 'absolute',
        inset: 0,
        background: fill,
        pointerEvents: 'auto',
        cursor: select ? 'pointer' : undefined,
        outline: selected ? '2px solid var(--mantine-color-text)' : undefined,
        outlineOffset: -2,
      }}
      onClick={select}
      {...(select &&
        !chip && {
          role: 'button',
          tabIndex: 0,
          'aria-label': label,
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            select()
          },
        })}
    />
  )
  return (
    <>
      {select ? (
        <Popover
          opened={selected}
          // A chip's `aria-expanded` would land on a span with no role.
          withRoles={!chip}
          onDismiss={dismiss}
          position="right"
          withArrow
          shadow="md"
          width={260}
          trapFocus
          returnFocus
          withinPortal
        >
          <Popover.Target>{block}</Popover.Target>
          <Popover.Dropdown role="dialog" aria-label={label}>
            {details}
          </Popover.Dropdown>
        </Popover>
      ) : (
        block
      )}
      <span style={{ position: 'relative', color: ink, pointerEvents: 'none' }}>{event.title}</span>
    </>
  )
}

/**
 * On a finger, sideways scrolls the days and downwards paints. Needed because
 * the library gives every slot `touch-action: none`. Mouse is unaffected.
 */
const PAN_SIDEWAYS = { touchAction: 'pan-x pinch-zoom' }

const outOfBounds = {
  disabled: true,
  style: { background: 'var(--mantine-color-gray-light)', cursor: 'not-allowed' },
}

/** Greyed on a read-only calendar, without the not-allowed cursor. */
const outOfBoundsRead = {
  disabled: true,
  style: { background: outOfBounds.style.background },
}

/**
 * The row lines a time slot draws, taken out where it is out of bounds, so a
 * greyed stretch reads as one block rather than as cells waiting to be
 * painted. The border shows the slot's own grey through it; where the
 * stretch meets open cells below, their own line still marks the edge.
 */
const NO_ROW_LINE = { borderTopColor: 'transparent' }

/**
 * An out-of-bounds time slot. It still carries the library's drag index (and
 * so `touch-action: none`), and has no stroke to protect, so it scrolls both
 * ways. Month days don't need this: their drag is off on touch.
 */
const outOfBoundsSlot = {
  ...outOfBounds,
  style: { ...outOfBounds.style, ...NO_ROW_LINE, touchAction: 'pan-x pan-y pinch-zoom' },
}

/** `outOfBoundsRead`, for a time slot. */
const outOfBoundsReadSlot = {
  ...outOfBoundsRead,
  style: { ...outOfBoundsRead.style, ...NO_ROW_LINE },
}

/** An arrow with nowhere to go. The library's control has no disabled style of its own. */
function dead(is: boolean) {
  return { disabled: is, interactive: !is, style: is ? { opacity: 0.4 } : undefined }
}

/** One hour of the time grids, in px. The library's `slotHeight` is per hour, not per row. */
const HOUR_HEIGHT = 40

/**
 * Lines the hours column up with the rows on an axis that does not start or
 * end on the hour. The library stacks one hour-tall label per hour from the
 * top, so a 14:30 start put every label half a row off; pad the top by the
 * partial first hour and cut the height to the rows.
 */
function hoursColumn(axis: DailyWindow, granularity: number) {
  const start = toMinutes(axis.start)
  const perMinute = HOUR_HEIGHT / 60
  // One row per granule; a partial last one is drawn whole.
  const rows = Math.ceil((toMinutes(axis.end) - start) / granularity)
  return {
    paddingTop: ((60 - (start % 60)) % 60) * perMinute,
    height: rows * granularity * perMinute,
    overflow: 'hidden',
  }
}

/** The library uppercases slot labels, turning `9:00am` into `9:00AM`. */
const SLOT_LABEL: CSSProperties = { textTransform: 'none' }

/**
 * Pins the time column while a wide week scrolls sideways. `weekViewInner` has
 * to be opened up: its `overflow: hidden` makes it the (non-scrolling) box a
 * sticky child would stick to.
 */
const STICKY_TIMES = {
  weekViewInner: { overflow: 'visible' },
  weekViewSlotLabels: {
    position: 'sticky',
    insetInlineStart: 0,
    // Above the painted runs, which the library puts at 2.
    zIndex: 3,
    // Redraws the first day column's border, which scrolls away with its day.
    boxShadow: '1px 0 0 var(--week-view-border-color)',
  },
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
  brushColor,
  onPaint,
  buildEvents,
  fillOnDay,
  canPaint,
  dayInBounds,
  confine,
  earliest,
  onShowRange,
  reveal,
  readOnly = false,
}: {
  schedule: PollSchedule
  /** The cells that may be painted at all; everything else is drawn greyed. */
  bounds: Bounds
  /** The hours the grid is drawn between. */
  axis: DailyWindow
  painting: Record<GranuleKey, number>
  /** What a gesture writes. 0 rubs out and never toggles. Absent when read-only. */
  brush?: number
  /**
   * The theme colour (`teal.6`) a stroke with `brush` is drawn in, so a
   * hovered cell can preview it. Absent while the brush rubs out.
   */
  brushColor?: string
  /** Write one value over a set of cells; the caller owns the painting. */
  onPaint?: (keys: GranuleKey[], value: number) => void
  /**
   * The painting as events for a view. A function (called during render) so
   * switching views never shows the previous view's events for a frame.
   */
  buildEvents: (view: ScheduleViewLevel) => ScheduleEventData[]
  /** What filling a whole day covers, when not simply the day's in-bounds cells (create form). */
  fillOnDay?: (day: ScheduleDay) => GranuleKey[]
  /**
   * Whether a cell may be painted, when not simply "in bounds" -- the
   * time-collecting card lets any cell be painted. `bounds` still picks the
   * opening day and drives `adrift`.
   */
  canPaint?: (key: GranuleKey) => boolean
  /** Whether a whole day is one the poll asks about; see `canPaint`. */
  dayInBounds?: (day: ScheduleDay) => boolean
  /**
   * Arrows jump to the next range with an in-bounds day and stop at the ends.
   * The ballot only: on the painting screens the days are the open question.
   */
  confine?: boolean
  /** The earliest day the back arrow will reach (the create form's "today"). */
  earliest?: ScheduleDay
  /** Told the first and last day on screen whenever they change. */
  onShowRange?: (from: ScheduleDay, to: ScheduleDay) => void
  /** Bring this day on screen. An object so asking for the same day twice is still a change. */
  reveal?: { day: ScheduleDay } | null
  /** Read, not painted: `mode="static"`, a plain range label, and plain heading names. */
  readOnly?: boolean
}) {
  const write = onPaint ?? (() => {})
  const strokeWith = brush ?? 0
  const mode = readOnly ? ('static' as const) : ('default' as const)
  const labels = readOnly ? READ_LABELS : LABELS
  const days = daysOf(bounds)
  const daily = isDaily(schedule)
  const open = canPaint ?? ((key: GranuleKey) => bounds.has(key))
  const asks = dayInBounds ?? ((day: ScheduleDay) => boundsOnDay(bounds, day).length > 0)
  const fill = fillOnDay ?? ((day: ScheduleDay) => boundsOnDay(bounds, day))

  // Opens on the poll's first day rather than today. One date shared by all
  // three views, so switching zoom stays put.
  const [date, setDate] = useState(() => days[0] ?? dayjs().format('YYYY-MM-DD'))
  const [view, setView] = useState<ScheduleViewLevel>(daily ? 'month' : 'week')
  const h24 = use24HourTime()
  const showing = daily ? 'month' : view
  const narrowLabels = useMediaQuery('(max-width: 560px)', false, {
    getInitialValueInEffect: false,
  })
  const timeLabelWidth = narrowLabels ? (h24 ? '3rem' : '4.25rem') : '5rem'
  const daySlotWidth = narrowLabels ? '3rem' : '5rem'

  const events = buildEvents(showing)

  // See `showView`. Null except across a zoom change.
  const header = useRef<HTMLDivElement>(null)
  const held = useRef<number | null>(null)

  // Asked of the device, not the width. Read on first render so the month
  // never mounts with a drag it loses a frame later.
  const touch = useMediaQuery('(pointer: coarse)', false, { getInitialValueInEffect: false })

  /**
   * When the browser claims a swipe it fires `pointercancel`, but the
   * library's drag only listens for `pointerup` -- so it would stay open and
   * paint on the next `pointerup` anywhere. We dispatch a synthetic
   * `pointerup` (next frame, once its listeners exist) and set this flag so
   * the drag-end callbacks skip committing it.
   */
  const cancelled = useRef(false)

  useEffect(() => {
    function onCancel() {
      cancelled.current = true
      requestAnimationFrame(() => {
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        cancelled.current = false
      })
    }
    document.addEventListener('pointercancel', onCancel)
    return () => document.removeEventListener('pointercancel', onCancel)
  }, [])

  /**
   * Change zoom without the page jumping. The views differ in height by
   * hundreds of pixels, so the browser clamps the scroll; we measure the
   * header before and scroll it back into place in a layout effect after.
   */
  function showView(next: ScheduleViewLevel) {
    held.current = header.current?.getBoundingClientRect().top ?? null
    setView(next)
  }

  useLayoutEffect(() => {
    const was = held.current
    held.current = null
    const row = header.current
    if (was === null || !row) return

    window.scrollBy({ top: row.getBoundingClientRect().top - was })

    // Still lower than before: the document got too short to restore the
    // position, so bring the calendar to the top instead.
    if (row.getBoundingClientRect().top > was + 1) row.scrollIntoView({ block: 'start' })
  }, [showing])

  function paint(fromSlot: string, toSlot: string) {
    fillCells(cellsBetween(fromSlot, toSlot))
  }

  /** The paintable cells in one stretch of a day (filtered per cell, since a day can be partly in bounds). */
  function cellsBetween(fromSlot: string, toSlot: string): GranuleKey[] {
    return granulesBetween(fromSlot, toSlot, schedule.granularity).filter(open)
  }

  /** Tapping a drawn block clears it -- the undo for a tap-filled month day. */
  function erase(event: ScheduleEventData) {
    // Our events are always wall-clock strings; a `Date` would smuggle in the
    // reader's zone, so refuse it.
    if (typeof event.start !== 'string' || typeof event.end !== 'string') return
    const keys = cellsBetween(event.start, event.end)
    if (keys.length > 0) write(keys, 0)
  }

  function cellsAcross(from: string, to: string): GranuleKey[] {
    return daysBetween(from, to).filter(asks).flatMap(fill)
  }

  /**
   * Lay the brush over cells -- or clear them if they already hold exactly the
   * brush. Every gesture toggles this way. A 0 brush never toggles (clearing
   * a cleared stretch would fill it).
   */
  function fillCells(cells: GranuleKey[]) {
    if (cells.length === 0) return
    const already = strokeWith > 0 && cells.every((key) => painting[key] === strokeWith)
    write(cells, already ? 0 : strokeWith)
  }

  function fillDay(on: string) {
    // `YYYY-MM-DD` from the month, `YYYY-MM-DD 00:00:00` from the week heading.
    const day = on.slice(0, 10)
    // The week heading isn't disabled with its column, so guard here.
    if (!asks(day)) return
    fillCells(fill(day))
  }

  /** A drag across the month. Never toggles: the drag itself says which days. */
  function fillDays(fromDay: string, toDay: string) {
    write(cellsAcross(fromDay.slice(0, 10), toDay.slice(0, 10)), strokeWith)
  }

  const inView = visibleRange(date, showing)

  useEffect(() => {
    onShowRange?.(inView.from, inView.to)
  }, [onShowRange, inView.from, inView.to])

  useEffect(() => {
    if (reveal) setDate(reveal.day)
  }, [reveal])

  // The library takes no per-heading props, so out-of-bounds week headings
  // are greyed by a stylesheet keyed on their accessible names, scoped by
  // `calendarId`.
  const calendarId = useId()
  const greyedHeadings =
    showing === 'week'
      ? daysBetween(inView.from, inView.to)
          .filter((day) => !asks(day))
          .map(
            (day) =>
              `[data-paint-calendar="${calendarId}"] [aria-label="${labels.weekday} ${day}"]`,
          )
      : []
  const adrift = days.length > 0 && (days[days.length - 1] < inView.from || days[0] > inView.to)

  /** Where an arrow goes, or null for a dead arrow. Confined, it jumps to the next poll day. */
  function stepTo(by: 1 | -1): string | null {
    if (confine) {
      const day =
        by > 0 ? days.find((on) => on > inView.to) : days.findLast((on) => on < inView.from)
      return day ?? null
    }
    const next = step(date, showing, by)
    // Dead only once the whole range is behind the floor.
    if (by < 0 && earliest !== undefined && visibleRange(next, showing).to < earliest) return null
    return next
  }

  const back = stepTo(-1)
  const forward = stepTo(1)

  /** The header's range label as a control: fill exactly what is on screen. */
  function fillVisible() {
    fillCells(cellsAcross(inView.from, inView.to))
  }

  const timeColumn = hoursColumn(axis, schedule.granularity)

  const dayStyle = {
    '--day-view-slot-labels-width': timeLabelWidth,
  } as CSSProperties
  const weekStyle = {
    '--week-view-slots-label-width': timeLabelWidth,
    '--week-view-min-slot-width': daySlotWidth,
  } as CSSProperties
  const monthStyle = {
    '--min-day-width': '6rem',
  } as CSSProperties

  const grid = {
    startTime: `${axis.start}:00`,
    // The library cannot parse 24:00.
    endTime: axis.end === '24:00' ? '23:59:59' : `${axis.end}:00`,
    intervalMinutes: schedule.granularity,
    slotLabelFormat: (slot: string) => formatTimeOfDay(toMinutes(slot.slice(11, 16)), h24),
    slotHeight: HOUR_HEIGHT,
    withAllDaySlots: false as const,
    withCurrentTimeIndicator: false as const,
    withAgenda: false as const,
    withDragSlotSelect: !readOnly,
    mode,
    // A static calendar has nothing focusable, so the scroll viewport takes
    // focus itself to stay keyboard-scrollable.
    scrollAreaProps: readOnly
      ? { viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Calendar' } }
      : undefined,
    onSlotDragEnd: (fromSlot: string, toSlot: string) => {
      if (!cancelled.current) paint(fromSlot, toSlot)
    },
    getTimeSlotProps: ({ start }: { start: string }) =>
      open(granuleKey(start.slice(0, 10), toMinutes(start.slice(11, 16))))
        ? readOnly
          ? {}
          : { style: PAN_SIDEWAYS }
        : readOnly
          ? outOfBoundsReadSlot
          : outOfBoundsSlot,
  }

  return (
    <>
      {/* Our header, from the library's own parts (no Today button). */}
      <ScheduleHeader
        ref={header}
        // Clear of the fixed app header when `showView` scrolls this into view.
        style={{ scrollMarginTop: 'var(--app-shell-header-offset, 0px)', marginBottom: 0 }}
      >
        <div className={ScheduleHeader.classes.navigationGroup}>
          <ScheduleHeader.Previous
            aria-label={`Previous ${showing}`}
            {...dead(back === null)}
            onClick={() => back !== null && setDate(back)}
          />
          {readOnly ? (
            <ScheduleHeader.Control miw={190} interactive={false} tabIndex={-1}>
              {rangeLabel(date, showing)}
            </ScheduleHeader.Control>
          ) : (
            <Tooltip label="Apply to everything on screen" withArrow>
              <ScheduleHeader.Control
                miw={190}
                aria-label={`Apply to all of ${rangeLabel(date, showing)}`}
                onClick={fillVisible}
              >
                {rangeLabel(date, showing)}
              </ScheduleHeader.Control>
            </Tooltip>
          )}
          <ScheduleHeader.Next
            aria-label={`Next ${showing}`}
            {...dead(forward === null)}
            onClick={() => forward !== null && setDate(forward)}
          />
        </div>

        {adrift && (
          <Group gap="xs" wrap="nowrap">
            {/* The library title-cases control text. */}
            <ScheduleHeader.Control tt="none" onClick={() => setDate(days[0])}>
              Back to {formatDay(days[0])}
            </ScheduleHeader.Control>
          </Group>
        )}

        {!daily && (
          <Group gap="xs" wrap="nowrap" style={{ marginInlineStart: 'auto' }}>
            <ScheduleHeader.ViewSelect views={VIEWS} value={view} onChange={showView} />
          </Group>
        )}
      </ScheduleHeader>

      {/* Opts out of SmoothHeight: `showView` already holds the page still.
          `data-brush` drives the hover preview in index.css. */}
      <div
        data-own-height
        data-brush={readOnly ? undefined : brushColor ? 'paint' : 'erase'}
        style={
          brushColor
            ? ({
                '--brush': `var(--mantine-color-${brushColor.replace('.', '-')})`,
              } as CSSProperties)
            : undefined
        }
      >
        {showing === 'month' ? (
          <MonthView
            date={date}
            withHeader={false}
            style={monthStyle}
            events={events}
            onDayClick={fillDay}
            // No drag on touch: a month drag spans both axes, so there is no
            // axis to give the browser for scrolling. Turning the drag off is
            // what removes `touch-action: none`; taps still fill days.
            withDragSlotSelect={!touch && !readOnly}
            mode={mode}
            onSlotDragEnd={(fromDay: string, toDay: string) => {
              if (!cancelled.current) fillDays(fromDay, toDay)
            }}
            onEventClick={erase}
            getDayProps={(day) => (asks(day) ? {} : readOnly ? outOfBoundsRead : outOfBounds)}
            // No red weekend headings.
            weekendDays={[]}
            firstDayOfWeek={WEEK_STARTS_ON}
            withOutsideDays={false}
            renderEventBody={eventBody}
          />
        ) : showing === 'day' ? (
          <DayView
            date={date}
            withHeader={false}
            {...grid}
            style={dayStyle}
            styles={{
              dayViewSlotLabels: timeColumn,
              // This view drops the first label's top border; give it back
              // once padding has pushed that label down onto its own row.
              dayViewSlotLabel: {
                borderTop: timeColumn.paddingTop
                  ? '1px solid var(--day-view-border-color)'
                  : undefined,
                ...SLOT_LABEL,
              },
            }}
            withAllDaySlot={false}
            events={events}
            renderEventBody={eventBody}
            onTimeSlotClick={({ slotStart, slotEnd }) => paint(slotStart, slotEnd)}
          />
        ) : (
          <>
            {greyedHeadings.length > 0 && (
              <style>{`${greyedHeadings.join(',\n')} {
              color: var(--mantine-color-dimmed);
              background: var(--mantine-color-gray-light);
              cursor: ${readOnly ? 'default' : 'not-allowed'};
            }`}</style>
            )}
            <WeekView
              date={date}
              withHeader={false}
              {...grid}
              style={weekStyle}
              events={events}
              renderEventBody={eventBody}
              onTimeSlotClick={({ slotStart, slotEnd }) => paint(slotStart, slotEnd)}
              // With the header off, only the day heading fires this.
              onDateChange={fillDay}
              labels={labels}
              styles={{
                ...STICKY_TIMES,
                weekViewSlotLabels: { ...STICKY_TIMES.weekViewSlotLabels, ...timeColumn },
                weekViewSlotLabel: SLOT_LABEL,
              }}
              withWeekNumber={false}
              data-paint-calendar={calendarId}
              weekendDays={[]}
              // Must match `visibleRange`, which reads the same constant.
              firstDayOfWeek={WEEK_STARTS_ON}
            />
          </>
        )}
      </div>
    </>
  )
}

function daysBetween(from: string, to: string): string[] {
  const days: string[] = []
  for (let on = dayjs(from); !on.isAfter(dayjs(to)); on = on.add(1, 'day')) {
    days.push(on.format('YYYY-MM-DD'))
  }
  return days
}

function step(date: string, view: ScheduleViewLevel, by: number): string {
  const unit = view === 'month' ? 'month' : view === 'week' ? 'week' : 'day'
  return dayjs(date).add(by, unit).format('YYYY-MM-DD')
}

/** `Fri Sep 4`, `Aug 31 – Sep 06` (`31 Aug – 06 Sep` day first), `September 2026`. */
function rangeLabel(date: string, view: ScheduleViewLevel): string {
  if (view === 'day') return formatDay(date)
  if (view === 'month') return dayjs(date).format('MMMM YYYY')
  const { from, to } = visibleRange(date, view)
  const pattern = DAY_BEFORE_MONTH ? 'DD MMM' : 'MMM DD'
  return `${dayjs(from).format(pattern)} – ${dayjs(to).format(pattern)}`
}

/**
 * The first and last dates on screen. Must be exact, since `fillVisible`
 * fills it: relies on `withOutsideDays={false}` and `firstDayOfWeek={WEEK_STARTS_ON}`.
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
  // By hand rather than dayjs's `startOf('week')`, whose locale is dayjs's own
  // and not necessarily the one the grids were told to start on.
  const back = (on.day() - WEEK_STARTS_ON + 7) % 7
  const first = on.subtract(back, 'day')
  return { from: first.format('YYYY-MM-DD'), to: first.add(6, 'day').format('YYYY-MM-DD') }
}
