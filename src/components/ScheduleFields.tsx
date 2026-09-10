import { useMemo } from 'react'
import { ActionIcon, Alert, Group, Select, Stack, Switch, Text, Tooltip } from '@mantine/core'
import { DatePicker } from '@mantine/dates'
// With the day picker, in the create form's own chunk; see TimeBallotCard.
import '@mantine/dates/styles.css'
import { XIcon } from '@phosphor-icons/react'
import {
  clock,
  countWindows,
  describeOffset,
  formatDay,
  spanOf,
  toMinutes,
  toTimeOfDay,
  windowOn,
  windowsOn,
} from '../lib/schedule'
import { offsetChoices, offsetDrift } from '../lib/timezones'
import type { DailyWindow, PollSchedule } from '../lib/types'

/**
 * What a creator says instead of writing a list of options: when the meeting
 * could be, how long it is, and at what resolution people may answer.
 *
 * A handful of answers and a calendar, and between them they generate the
 * whole ballot -- see `enumerateWindows`. Nothing here is stored as typed: the
 * days become options and are read back off them, and the rest becomes the
 * poll's `schedule` column.
 *
 * **The days come before the hours**, which is the one thing about the order
 * worth explaining. It was the other way round when every day had the same
 * hours, because then the hours were a fact about the poll and the days were a
 * list. Now the hours can be a fact about each day, so there has to be a list
 * of days to hang them on before the question can be asked at all -- and the
 * offset comes last of the three because what each one is *called* is worked
 * out on the first of those days (see `offsetName`), so it is the only answer
 * whose list is not final until the ones above it are.
 *
 * Within the first group, granularity comes before length because it is the
 * unit length is expressed in, and offering "90 minutes" beside a half-hour
 * grid that cannot express it is how you get a combination the enumeration has
 * to refuse after the fact.
 */

/** The resolutions a calendar can be painted at; see `validate_schedule`. */
const GRANULARITIES = [
  { value: '15', label: '15 minutes' },
  { value: '30', label: 'half an hour' },
  { value: '60', label: 'an hour' },
]

/** Times of day for the two ends of a daily window, at half-hour steps. */
function timesOfDay(from: number, to: number): { value: string; label: string }[] {
  const all: { value: string; label: string }[] = []
  for (let minutes = from; minutes <= to; minutes += 30) {
    all.push({ value: toTimeOfDay(minutes), label: clock(minutes) })
  }
  return all
}

const STARTS = timesOfDay(0, 23 * 60 + 30)
// Offered from half an hour after midnight so the list can never contain a
// time at or before the earliest start; 24:00 is midnight at the end of the
// day, which '00:00' would read as the start of it.
const ENDS = [...timesOfDay(30, 23 * 60 + 30), { value: '24:00', label: 'midnight' }]

/**
 * How long a meeting may be, in whole granules, as far as the longest day in
 * the poll can hold.
 *
 * The *longest*, now that days can differ. Bounding it by the shortest would
 * refuse a perfectly good poll -- a three-hour Saturday meeting with a Friday
 * evening thrown in for the people who can only do Fridays -- and bounding it
 * by the union would offer a length no single day could hold. A day too short
 * for the meeting simply offers no windows, which the summary line says out
 * loud rather than leaving to be discovered on the ballot.
 */
function lengths(schedule: PollSchedule, days: string[]): { value: string; label: string }[] {
  const spans = days.map((day) => {
    const hours = windowOn(schedule, day)
    return toMinutes(hours.end) - toMinutes(hours.start)
  })
  const widest = spans.length
    ? Math.max(...spans)
    : toMinutes(schedule.window.end) - toMinutes(schedule.window.start)

  const most = Math.max(1, Math.floor(widest / schedule.granularity))
  const all: { value: string; label: string }[] = []
  for (let slots = 1; slots <= most; slots++) {
    all.push({ value: String(slots), label: describeLength(slots * schedule.granularity) })
  }
  return all
}

function describeLength(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} minutes`
  const hourPart = hours === 1 ? '1 hour' : `${hours} hours`
  return rest === 0 ? hourPart : `${hourPart} ${rest} minutes`
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
  days,
  onScheduleChange,
  onDaysChange,
  onOffsetChange,
  error,
}: {
  schedule: PollSchedule
  /** The days in bounds, as `YYYY-MM-DD`. Not part of the schedule: see PollSchedule. */
  days: string[]
  onScheduleChange: (schedule: PollSchedule) => void
  onDaysChange: (days: string[]) => void
  /**
   * Picking an offset, which the form handles rather than this component
   * because the *name* stored beside it has to be worked out on the poll's
   * first day -- see `CreatePoll`'s `pickOffset`. What is chosen here is the
   * number; the caption follows from it.
   */
  onOffsetChange: (offset: string) => void
  /** Wrong with the schedule as a whole -- no days, or too many windows. */
  error?: string
}) {
  const ordered = inOrder(days)
  const perDay = Object.keys(schedule.day_windows ?? {}).length > 0
  const total = countWindows(schedule, ordered)

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

  /**
   * Changing the granularity re-expresses the meeting length in the new unit
   * rather than keeping the number of granules, because the number of granules
   * is not what the creator was looking at: they chose "an hour", and moving
   * the grid from half-hours to quarter-hours must not quietly make it thirty
   * minutes. Rounded up, so a 90-minute meeting on an hourly grid becomes two
   * hours rather than one -- the direction that keeps the meeting long enough.
   */
  function setGranularity(granularity: number) {
    const minutes = schedule.desired_slots * schedule.granularity
    onScheduleChange({
      ...schedule,
      granularity,
      desired_slots: Math.max(1, Math.ceil(minutes / granularity)),
    })
  }

  /**
   * Write a set of per-day hours back, and re-derive the poll's own window
   * from it.
   *
   * `window` is the union of every day's hours as well as the default for a
   * day that has none -- see PollSchedule -- so it is never edited directly
   * while the per-day rows are up: it is whatever those rows add up to. That
   * is what keeps the ballot's vertical axis exactly as tall as the poll needs
   * and no taller, and what makes turning the switch back off land on
   * something sensible rather than on whatever the selects last held.
   */
  function setDayWindows(dayWindows: Record<string, DailyWindow>) {
    const next = { ...schedule, day_windows: dayWindows }
    onScheduleChange({ ...next, window: spanOf(next, Object.keys(dayWindows)) })
  }

  /** Every chosen day gets a row, seeded from what it is already getting. */
  function seed(forDays: string[]): Record<string, DailyWindow> {
    const seeded: Record<string, DailyWindow> = {}
    for (const day of inOrder(forDays)) seeded[day] = windowOn(schedule, day)
    return seeded
  }

  /**
   * Choosing days, with the per-day rows kept in step: a day added while they
   * are up arrives with a row of its own, and a day removed takes its row with
   * it. Anything else leaves an entry naming a day the poll is not asking
   * about, which is a stored answer to a question nobody asked.
   */
  function setDays(next: string[]) {
    onDaysChange(next)
    if (perDay) setDayWindows(seed(next))
  }

  /**
   * On: every chosen day gets the hours it already had, so the switch changes
   * nothing until something is edited -- it opens the rows rather than
   * answering them.
   *
   * Off: the rows go, and the poll keeps the union of what they held. Not the
   * hours from before the switch was flipped: those are gone, and the union is
   * the one window every day already fits inside.
   */
  function setPerDay(on: boolean) {
    if (on) setDayWindows(seed(ordered))
    else onScheduleChange({ ...schedule, window: spanOf(schedule, ordered), day_windows: null })
  }

  function setDayWindow(day: string, edit: Partial<DailyWindow>) {
    const current = schedule.day_windows ?? {}
    const hours = { ...windowOn(schedule, day), ...edit }
    // Dragging a start past its own end is the one edit that can produce an
    // impossible day, and the end is what moves: a creator moving the start is
    // saying when the day begins, not asking for it to be refused.
    if (toMinutes(hours.end) <= toMinutes(hours.start)) {
      const after = ENDS.find((end) => end.value > hours.start)
      if (!after) return
      hours.end = after.value
    }
    setDayWindows({ ...current, [day]: hours })
  }

  return (
    <Stack gap="sm">
      <Group grow align="flex-start" wrap="wrap">
        <Select
          label="Answer in blocks of"
          description="How finely people can mark their time"
          data={GRANULARITIES}
          value={String(schedule.granularity)}
          onChange={(v) => v && setGranularity(Number(v))}
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
        />
        <Select
          label="Meeting length"
          description="Every option is a window this long"
          data={lengths(schedule, ordered)}
          value={String(schedule.desired_slots)}
          onChange={(v) => v && onScheduleChange({ ...schedule, desired_slots: Number(v) })}
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
        />
      </Group>

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
          // and centring it stops it sitting oddly against the selects above.
          mx="auto"
        />
      </Stack>

      <Stack gap={6}>
        <Group justify="space-between" align="center" wrap="nowrap">
          <Text size="sm" fw={500}>
            Hours to choose from
          </Text>
          <Switch
            size="sm"
            label="Set them per day"
            checked={perDay}
            onChange={(event) => setPerDay(event.currentTarget.checked)}
            // With no days there is nothing to set hours on, and a switch that
            // turns on and visibly does nothing is worse than one that says
            // why it is waiting.
            disabled={ordered.length === 0}
          />
        </Group>

        {perDay ? (
          /* One row per day, in date order. A poll asking about a fortnight
             gets fourteen rows, which is long -- and is exactly as long as the
             answer the creator is giving. Nothing is collapsed behind a
             summary, because the summary is the thing that would be wrong. */
          <Stack gap={6}>
            {ordered.map((day) => {
              const hours = windowOn(schedule, day)
              const windows = windowsOn(schedule, day)
              return (
                <Group key={day} gap="xs" wrap="nowrap" align="center">
                  <Text
                    size="sm"
                    w={110}
                    style={{ flexShrink: 0 }}
                    c={windows ? undefined : 'dimmed'}
                  >
                    {formatDay(day)}
                  </Text>
                  <Select
                    size="xs"
                    aria-label={`Earliest start on ${formatDay(day)}`}
                    data={STARTS}
                    value={hours.start}
                    onChange={(v) => v && setDayWindow(day, { start: v })}
                    allowDeselect={false}
                    comboboxProps={{ withinPortal: false }}
                  />
                  <Text size="xs" c="dimmed">
                    to
                  </Text>
                  <Select
                    size="xs"
                    aria-label={`Latest end on ${formatDay(day)}`}
                    data={ENDS.filter((end) => end.value > hours.start)}
                    value={hours.end}
                    onChange={(v) => v && setDayWindow(day, { end: v })}
                    allowDeselect={false}
                    comboboxProps={{ withinPortal: false }}
                  />
                  <Tooltip label="Take this day off the list" withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      aria-label={`Remove ${formatDay(day)}`}
                      onClick={() => setDays(ordered.filter((other) => other !== day))}
                    >
                      <XIcon size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              )
            })}
          </Stack>
        ) : (
          <Group grow align="flex-start" wrap="wrap">
            <Select
              label="Earliest start"
              data={STARTS}
              value={schedule.window.start}
              onChange={(v) =>
                v && onScheduleChange({ ...schedule, window: { ...schedule.window, start: v } })
              }
              allowDeselect={false}
              comboboxProps={{ withinPortal: false }}
            />
            <Select
              label="Latest end"
              data={ENDS.filter((end) => end.value > schedule.window.start)}
              value={schedule.window.end}
              onChange={(v) =>
                v && onScheduleChange({ ...schedule, window: { ...schedule.window, end: v } })
              }
              allowDeselect={false}
              comboboxProps={{ withinPortal: false }}
            />
          </Group>
        )}
      </Stack>

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
          is visible before the poll exists. */}
      <Text size="xs" c={error ? 'var(--mantine-color-error)' : 'dimmed'}>
        {error ??
          (ordered.length === 0
            ? 'Pick the days people can choose between.'
            : `${total} ${total === 1 ? 'window' : 'windows'} to score across ${ordered.length} ${ordered.length === 1 ? 'day' : 'days'}.`)}
      </Text>
    </Stack>
  )
}

/**
 * Today, as the date the offsets are captioned against before any day has been
 * picked. Only ever used to *label* the picker; what is stored beside the
 * offset is worked out by `CreatePoll` on the poll's own first day, and worked
 * out again whenever that day moves.
 */
function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
