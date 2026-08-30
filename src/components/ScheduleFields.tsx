import { Group, Select, Stack, Text } from '@mantine/core'
import { DatePicker } from '@mantine/dates'
// With the day picker, in the create form's own chunk; see TimeBallotCard.
import '@mantine/dates/styles.css'
import { clock, toMinutes, toTimeOfDay, windowsPerDay } from '../lib/schedule'
import type { PollSchedule } from '../lib/types'

/**
 * What a creator says instead of writing a list of options: when the meeting
 * could be, how long it is, and at what resolution people may answer.
 *
 * Four answers and a calendar, and between them they generate the whole
 * ballot -- see `enumerateWindows`. Nothing here is stored as typed: the days
 * become options and are read back off them, and the rest becomes the poll's
 * `schedule` column.
 *
 * The fields are ordered the way the sentence goes. Granularity comes before
 * length because it is the unit length is expressed in, and offering "90
 * minutes" beside a half-hour grid that cannot express it is how you get a
 * combination the enumeration has to refuse after the fact.
 */

/** The resolutions a calendar can be painted at; see `validate_schedule`. */
const GRANULARITIES = [
  { value: '15', label: '15 minutes' },
  { value: '30', label: 'half an hour' },
  { value: '60', label: 'an hour' },
]

/**
 * Every offset a poll can be held in, at quarter-hour steps from -12:00 to
 * +14:00 -- which is the real range of civil time, Chatham Islands and all.
 *
 * Offsets rather than named zones, and that is a decision rather than a
 * shortcut: a named zone spanning a daylight-saving change gives one day 23 or
 * 25 hours and a 1am that happens twice or not at all, so an option named
 * "1am" would stop meaning one time. See PollSchedule.timezone.
 */
function offsets(): { value: string; label: string }[] {
  const all: { value: string; label: string }[] = []
  for (let minutes = -12 * 60; minutes <= 14 * 60; minutes += 15) {
    const sign = minutes < 0 ? '-' : '+'
    const value = `${sign}${toTimeOfDay(Math.abs(minutes))}`
    all.push({ value, label: `UTC${value}` })
  }
  return all
}

const OFFSETS = offsets()

/** Times of day for the two ends of the daily window, at half-hour steps. */
function timesOfDay(from: number, to: number): { value: string; label: string }[] {
  const all: { value: string; label: string }[] = []
  for (let minutes = from; minutes <= to; minutes += 30) {
    all.push({ value: toTimeOfDay(minutes), label: clock(minutes) })
  }
  return all
}

/** How long a meeting may be, in whole granules, as far as a day can hold. */
function lengths(schedule: PollSchedule): { value: string; label: string }[] {
  const span = toMinutes(schedule.window.end) - toMinutes(schedule.window.start)
  const most = Math.max(1, Math.floor(span / schedule.granularity))
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

export function ScheduleFields({
  schedule,
  days,
  onScheduleChange,
  onDaysChange,
  error,
}: {
  schedule: PollSchedule
  /** The days in bounds, as `YYYY-MM-DD`. Not part of the schedule: see PollSchedule. */
  days: string[]
  onScheduleChange: (schedule: PollSchedule) => void
  onDaysChange: (days: string[]) => void
  /** Wrong with the schedule as a whole -- no days, or too many windows. */
  error?: string
}) {
  const perDay = windowsPerDay(schedule)
  const total = perDay * days.length

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
          data={lengths(schedule)}
          value={String(schedule.desired_slots)}
          onChange={(v) => v && onScheduleChange({ ...schedule, desired_slots: Number(v) })}
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
        />
      </Group>

      <Group grow align="flex-start" wrap="wrap">
        <Select
          label="Earliest start"
          data={timesOfDay(0, 23 * 60 + 30)}
          value={schedule.window.start}
          onChange={(v) =>
            v && onScheduleChange({ ...schedule, window: { ...schedule.window, start: v } })
          }
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
        />
        <Select
          label="Latest end"
          // Offered from half an hour after midnight so the list can never
          // contain a time at or before the earliest start; 24:00 is midnight
          // at the end of the day, which '00:00' would read as the start of it.
          data={[...timesOfDay(30, 23 * 60 + 30), { value: '24:00', label: 'midnight' }].filter(
            (time) => time.value > schedule.window.start,
          )}
          value={schedule.window.end}
          onChange={(v) =>
            v && onScheduleChange({ ...schedule, window: { ...schedule.window, end: v } })
          }
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
        />
      </Group>

      <Select
        label="Times are in"
        description="Everybody sees the same grid, in this offset, wherever they are"
        data={OFFSETS}
        value={schedule.timezone}
        onChange={(v) => v && onScheduleChange({ ...schedule, timezone: v })}
        searchable
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
          onChange={onDaysChange}
          size="sm"
          // The picker is the only field here whose width is not the form's,
          // and centring it stops it sitting oddly against the selects above.
          mx="auto"
        />
      </Stack>

      {/* What the four answers above actually add up to. The creator is
          writing a ballot without seeing one, and this is the only place the
          size of it is visible before the poll exists. */}
      <Text size="xs" c={error ? 'var(--mantine-color-error)' : 'dimmed'}>
        {error ??
          (days.length === 0
            ? 'Pick the days people can choose between.'
            : `${total} ${total === 1 ? 'window' : 'windows'} to score: ${perDay} a day across ${days.length} ${days.length === 1 ? 'day' : 'days'}.`)}
      </Text>
    </Stack>
  )
}
