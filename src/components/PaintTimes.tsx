import { useEffect, useMemo, useState } from 'react'
import { Button, Group, Stack, Text } from '@mantine/core'
import type { ScheduleEventData, ScheduleViewLevel } from '@mantine/schedule'
import { PaintCalendar } from './PaintCalendar'
import { HoursFields } from './HoursFields'
import {
  axisFor,
  boundsOf,
  cellsInHours,
  DAY_MINUTES,
  daysOf,
  describeOffset,
  enumerateWindows,
  granulesOf,
  isDaily,
  paintingRuns,
  runBounds,
  toMinutes,
  toTimeOfDay,
  type GranuleKey,
} from '../lib/schedule'
import { offsetName } from '../lib/timezones'
import type { DailyWindow, PollOption, PollSchedule } from '../lib/types'

/**
 * Choosing which times a poll offers, by painting them.
 *
 * The list a time poll is collecting is a list of window starts, and nobody
 * types one of those. So where an option poll's list is a text box and a row
 * per suggestion, a time poll's is the same calendar the ballot is voted on --
 * marking the hours you would offer rather than the hours you are free.
 *
 * Two callers, and the difference between them is one flag:
 *
 * - a **voter** adding to a poll that is still collecting, who may only add.
 *   The windows already on the list are drawn as they are and cannot be rubbed
 *   out; taking somebody else's suggestion off the list is the creator's job
 *   everywhere else in this app and is that here too.
 * - the **creator** correcting a list that is already a ballot, who may do
 *   both.
 *
 * **One brush, and painting over a stretch takes it back.** There used to be
 * an *Offer* / *Take off* toggle above the calendar, which was a mode to be in
 * for a gesture that already says which of the two it means: every gesture on
 * this calendar toggles, so marking a stretch that is already marked is how
 * anybody says "not that after all" -- see `fillCells` in `PaintCalendar`. The
 * toggle answered one case the brush does not, a drag across a half-marked
 * stretch, and cost a mode on every other.
 *
 * **The hours are this reader's, not the poll's.** `HoursFields` says which
 * part of the day the grid is drawn on and which hours a day's heading lays
 * down, exactly as it does on the create form. It used to be the poll's stored
 * `window`, full stop, which meant a group could only ever be asked about the
 * hours its creator had already thought of: a poll painted 09:00-17:00 had no
 * way to be offered an evening, by anybody, ever. The axis still holds
 * whatever is already on the list (`axisFor`), so narrowing the pair hides
 * nothing that has been offered.
 *
 * **It saves in one request**, which is the whole reason a time poll can
 * collect its times at all. One gesture here is a handful of windows -- a
 * three-hour meeting over a painted afternoon is five of them -- and the
 * suggestion path used to insert one option per request, so a run that failed
 * halfway left a day with morning windows and no afternoon. `suggest_options`
 * and its two siblings take the lot; see 0056_schedule_options.sql.
 */

/**
 * What a cell is on this calendar: on its way off the list, already offered,
 * or newly marked. Three states rather than the ballot's six, and all of them
 * above zero, because `paintingRuns` reads a 0 as "nobody marked this" -- which
 * is true on a ballot and is not true of a window being taken off.
 */
const DROPPING = 1
const OFFERED = 2
const ADDING = 3

/**
 * The difference between the painting and the list: the window starts to add,
 * and the ids of the options to drop. One edit, whichever of the two halves
 * is empty.
 */
export type PaintedEdit = { add: string[]; removeIds: string[] }

export function PaintTimes({
  schedule,
  options,
  canRemove,
  saving,
  showSave,
  onSave,
  onDraftChange,
}: {
  schedule: PollSchedule
  /** The windows already on the list, as ordinary options. */
  options: PollOption[]
  /** Whether existing windows may be taken off the list; creator-only. */
  canRemove: boolean
  saving: boolean
  /**
   * Whether the calendar carries its own *Save times*.
   *
   * False where the card around it ends in *Confirm options*, which is the
   * same press: confirming a list is saying the list in front of you is the
   * one you mean, and an afternoon painted but not saved is part of it. Two
   * buttons for one act was the thing that was wrong. See CollectOptions.
   */
  showSave: boolean
  /** Apply the difference, and answer whether it went in. */
  onSave: (add: string[], removeIds: string[]) => Promise<boolean>
  /** The difference as it now stands, or null when there is none. */
  onDraftChange: (edit: PaintedEdit | null) => void
}) {
  const offered = useMemo(
    () =>
      boundsOf(
        options.map((o) => o.name),
        schedule,
      ),
    [options, schedule],
  )

  // What the calendar currently says the poll should offer. It opens as what
  // it already offers, so the first thing a reader sees is the poll as it
  // stands, and the difference below is empty until they touch something.
  const [wanted, setWanted] = useState<Set<GranuleKey>>(() => new Set(offered))
  // Which part of the day this reader is working in; see HoursFields. It opens
  // as the poll's own axis, so the calendar is the one the creator drew until
  // somebody says otherwise.
  const [hours, setHours] = useState<DailyWindow>(schedule.window)

  const daily = isDaily(schedule)
  const zone = useMemo(() => {
    const first = daysOf(offered)[0]
    return first ? offsetName(schedule.timezone, first) : null
  }, [schedule.timezone, offered])

  /**
   * The hours a suggestion may be made in: the pair above, widened to hold
   * everything already painted, on any day.
   *
   * Horizontally open and vertically bounded, and both halves are deliberate.
   * A poll collecting its times is asking about days nobody has named yet, so
   * there is nothing to bound the days by -- the calendar's arrows are the
   * whole of the range. The hours are what the grid is drawn between, so an
   * hour outside them is reached by moving the end that excludes it rather
   * than by scrolling to a row that is not there.
   */
  const axis = useMemo(
    () => axisFor(hours, new Set([...offered, ...wanted]), schedule),
    [hours, offered, wanted, schedule],
  )
  const first = toMinutes(axis.start)
  const last = toMinutes(axis.end)
  const canPaint = (key: GranuleKey) => {
    const at = toMinutes(key.slice(11))
    return at >= first && at + schedule.granularity <= last
  }

  function paint(keys: GranuleKey[], value: number) {
    setWanted((prev) => {
      const next = new Set(prev)
      for (const key of keys) {
        // A cell already on the list is only rubbed out by somebody allowed to
        // take a window off it; for everybody else painting over one of their
        // own unsaved marks takes it back and there it stops.
        if (value === 0) {
          if (canRemove || !offered.has(key)) next.delete(key)
        } else {
          next.add(key)
        }
      }
      return next
    })
  }

  /**
   * The difference, as the two lists the save is made of.
   *
   * Enumerated from the painting rather than tracked as it is made, for the
   * reason the create form enumerates rather than tracks: a window is a run of
   * cells, so marking one cell beside an existing stretch creates windows that
   * span both, and no per-cell bookkeeping would find them.
   */
  const target = useMemo(() => new Set(enumerateWindows(schedule, wanted)), [schedule, wanted])
  const adding = useMemo(
    () => [...target].filter((name) => !options.some((o) => o.name === name)),
    [target, options],
  )
  const removing = useMemo(() => options.filter((o) => !target.has(o.name)), [target, options])

  function buildEvents(view: ScheduleViewLevel): ScheduleEventData[] {
    const painting: Record<GranuleKey, number> = {}
    // A window on its way off the list first, so a cell that is both -- part
    // of a window being dropped and part of one being kept -- is drawn as
    // kept. The dropped ones are what is left over.
    for (const option of removing) {
      for (const key of granulesOf(option.name, schedule)) painting[key] = DROPPING
    }
    for (const key of wanted) painting[key] = offered.has(key) ? OFFERED : ADDING

    return paintingRuns(painting, schedule).map((run) => ({
      id: `${run.day} ${run.from}`,
      title:
        view !== 'month'
          ? ''
          : daily
            ? LABELS[run.value]
            : `${toTimeOfDay(run.from)}–${toTimeOfDay(Math.min(run.to, DAY_MINUTES))}`,
      ...runBounds(run),
      color: COLORS[run.value],
      display: view === 'month' ? 'default' : 'background',
      payload: { ink: INKS[run.value] },
    }))
  }

  const nothing = adding.length === 0 && removing.length === 0

  // Reported up rather than asked for, because the card around this is what
  // says "you have changes that have not been saved" -- and, where the way
  // out of it is *Confirm options*, what puts them in -- and it cannot see
  // the painting. An effect rather than a call inside `paint`, since the diff
  // is enumerated from the whole painting and not tracked cell by cell.
  useEffect(() => {
    onDraftChange(
      adding.length === 0 && removing.length === 0
        ? null
        : { add: adding, removeIds: removing.map((option) => option.id) },
    )
  }, [adding, removing, onDraftChange])

  return (
    <Stack gap="xs">
      {/* What the gesture is, and what the gesture undone is: there is no
          eraser to switch to, because marking a stretch that is already marked
          takes it back. A reader who may not take a window off the list is
          told which marks that reaches -- their own, the ones not yet saved --
          rather than being invited to press at somebody else's and watch
          nothing happen. */}
      <Text size="sm">
        Mark the times this poll should offer.{' '}
        {canRemove
          ? 'Mark them again to take them back.'
          : 'Mark your own again to take them back.'}
      </Text>

      {/* Hidden on a poll answered in whole days, where there are no hours to
          be earliest or latest: a day is either in or out. */}
      {!daily && <HoursFields hours={hours} onChange={setHours} />}

      <Text size="xs" c="dimmed">
        All times are {describeOffset(schedule.timezone, zone)}
      </Text>

      <PaintCalendar
        schedule={schedule}
        bounds={offered}
        axis={axis}
        // Keyed to the brush rather than to what the cell is, so that clicking
        // a day that is already entirely marked takes it back -- which is the
        // toggle every day-fill in this app has. What a cell *is* is drawn by
        // `buildEvents`; this is only what a gesture compares against.
        painting={Object.fromEntries([...wanted].map((key) => [key, ADDING]))}
        brush={ADDING}
        onPaint={paint}
        buildEvents={buildEvents}
        canPaint={canPaint}
        dayInBounds={() => true}
        fillOnDay={(day) => cellsInHours(day, hours, schedule.granularity)}
      />

      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="sm" c="dimmed">
          {nothing
            ? `${options.length} ${options.length === 1 ? 'time' : 'times'} on the list.`
            : [
                adding.length > 0 && `${adding.length} to add`,
                removing.length > 0 && `${removing.length} to take off`,
              ]
                .filter(Boolean)
                .join(', ')}
        </Text>
        {showSave && (
          <Button
            onClick={() =>
              onSave(
                adding,
                removing.map((o) => o.id),
              )
            }
            loading={saving}
            disabled={nothing}
          >
            Save times
          </Button>
        )}
      </Group>
    </Stack>
  )
}

/** Being taken off, offered already, or being added. */
const COLORS: Record<number, string> = {
  [DROPPING]: 'red.4',
  [OFFERED]: 'blue.5',
  [ADDING]: 'teal.6',
}
const LABELS: Record<number, string> = {
  [DROPPING]: 'Coming off',
  [OFFERED]: 'Offered',
  [ADDING]: 'Adding',
}

/** And what a month chip's label is written in over each of them. */
const INKS: Record<number, string> = {
  [DROPPING]: 'var(--mantine-color-black)',
  [OFFERED]: 'var(--mantine-color-white)',
  [ADDING]: 'var(--mantine-color-white)',
}
