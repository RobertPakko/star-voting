import { useEffect, useMemo, useState } from 'react'
import { Button, Group, SegmentedControl, Stack, Text } from '@mantine/core'
import type { ScheduleEventData, ScheduleViewLevel } from '@mantine/schedule'
import { PaintCalendar } from './PaintCalendar'
import {
  boundsOf,
  DAY_MINUTES,
  describeLength,
  describeOffset,
  enumerateWindows,
  granuleKey,
  granulesOf,
  isDaily,
  meetingMinutes,
  paintingRuns,
  runBounds,
  toMinutes,
  toTimeOfDay,
  type GranuleKey,
  type ScheduleDay,
} from '../lib/schedule'
import type { PollOption, PollSchedule } from '../lib/types'

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

export function PaintTimes({
  schedule,
  options,
  canRemove,
  saving,
  onSave,
  onDirtyChange,
}: {
  schedule: PollSchedule
  /** The windows already on the list, as ordinary options. */
  options: PollOption[]
  /** Whether existing windows may be taken off the list; creator-only. */
  canRemove: boolean
  saving: boolean
  /**
   * Apply the difference: the window starts to add, and the ids of the options
   * to drop. One call, whichever of the two is empty.
   */
  onSave: (add: string[], removeIds: string[]) => Promise<void>
  /** Whether the calendar holds a change the poll does not; see CollectOptions. */
  onDirtyChange: (dirty: boolean) => void
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
  const [brush, setBrush] = useState(ADDING)

  const daily = isDaily(schedule)
  const length = meetingMinutes(schedule)

  /**
   * The hours a suggestion may be made in: the poll's own axis, on any day.
   *
   * Horizontally open and vertically closed, and both halves are deliberate. A
   * poll collecting its times is asking about days nobody has named yet, so
   * there is nothing to bound the days by -- the calendar's arrows are the
   * whole of the range. The hours are the grid the ballot will be drawn on,
   * and a window outside them is one the ballot has no rows for.
   */
  const first = toMinutes(schedule.window.start)
  const last = toMinutes(schedule.window.end)
  const canPaint = (key: GranuleKey) => {
    const at = toMinutes(key.slice(11))
    return at >= first && at + schedule.granularity <= last
  }

  const cellsOn = (day: ScheduleDay): GranuleKey[] => {
    if (daily) return [granuleKey(day, 0)]
    const keys: GranuleKey[] = []
    for (let at = first; at + schedule.granularity <= last; at += schedule.granularity) {
      keys.push(granuleKey(day, at))
    }
    return keys
  }

  function paint(keys: GranuleKey[], value: number) {
    setWanted((prev) => {
      const next = new Set(prev)
      for (const key of keys) {
        // A cell already on the list is only rubbed out by somebody allowed to
        // take a window off it; for everybody else the eraser reaches their
        // own unsaved marks and stops there.
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
  // says "you have changes that have not been saved" and it cannot see the
  // painting. An effect rather than a call inside `paint`, since the diff is
  // enumerated from the whole painting and not tracked cell by cell.
  useEffect(() => onDirtyChange(!nothing), [nothing, onDirtyChange])

  return (
    <Stack gap="xs">
      <Text size="sm">
        Mark the times this poll should offer, in blocks of {describeLength(length)}.{' '}
        {daily
          ? 'Click a day to offer it, or drag across several.'
          : 'Drag across the calendar, or click a day’s heading to take the whole of it.'}
      </Text>

      <Group gap="sm" wrap="wrap" align="center">
        <SegmentedControl
          size="xs"
          value={String(brush)}
          onChange={(v) => setBrush(Number(v))}
          data={[
            { value: String(ADDING), label: 'Offer' },
            { value: '0', label: canRemove ? 'Take off' : 'Undo' },
          ]}
        />
        <Text size="xs" c="dimmed">
          All times are {describeOffset(schedule.timezone)}
        </Text>
      </Group>

      <PaintCalendar
        schedule={schedule}
        bounds={offered}
        axis={schedule.window}
        // Keyed to the brush rather than to what the cell is, so that clicking
        // a day that is already entirely marked takes it back -- which is the
        // toggle every day-fill in this app has. What a cell *is* is drawn by
        // `buildEvents`; this is only what a gesture compares against.
        painting={Object.fromEntries([...wanted].map((key) => [key, ADDING]))}
        brush={brush}
        onPaint={paint}
        buildEvents={buildEvents}
        canPaint={canPaint}
        dayInBounds={() => true}
        fillOnDay={cellsOn}
        slotHeight={daily ? undefined : 22}
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
