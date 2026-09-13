import { Group, Select } from '@mantine/core'
import { toTimeOfDay } from '../lib/schedule'
import type { DailyWindow } from '../lib/types'

/**
 * The two selects that say which part of the day a calendar is about.
 *
 * Drawn on both screens that paint what a poll is asking about — the create
 * form and the card a group adds times through — because they answer the same
 * question on each: which hours the grid is drawn between (`axisFor`), and
 * which hours clicking a day's heading lays down (`cellsInHours`). Nobody
 * wants to drag out 09:00 to 17:00 on each of ten days, and "the working day,
 * except Friday which is only the afternoon" is the common answer, so the pair
 * is the default and the drag is there for the days that differ.
 *
 * **They are not stored and they are not the poll: what is painted is.** A
 * poll's `window` is the axis it was created with, and this is one reader's
 * working view of it — moving it adds nothing to the poll and takes nothing
 * away, it only decides what can be reached without dragging.
 *
 * **And they do not touch what is already painted.** Moving them used to
 * re-fill every day whose painting was still exactly the old default, on the
 * grounds that such a day was a day nobody had touched. It was a guess about
 * intent and it was wrong as often as not: a day filled from its heading and
 * then deliberately left alone is an answer, and it looks identical to one
 * nobody has reached yet. So they decide what the *next* whole-day fill lays
 * down, and the painting changes only when somebody paints.
 */

/** Times of day for the two ends, at half-hour steps. */
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

export function HoursFields({
  hours,
  onChange,
}: {
  hours: DailyWindow
  onChange: (hours: DailyWindow) => void
}) {
  return (
    <Group grow align="flex-start" wrap="wrap">
      <Select
        label="Earliest start"
        data={STARTS}
        value={hours.start}
        onChange={(v) =>
          v &&
          onChange({
            start: v,
            // A start moved past the end takes the end with it, to the first
            // time after it: the pair is always a stretch of the day, and a
            // select that could be left saying 18:00 to 09:00 would be one
            // more state for every reader of it to work out.
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
        data={ENDS.filter((end) => end.value > hours.start)}
        value={hours.end}
        onChange={(v) => v && onChange({ ...hours, end: v })}
        allowDeselect={false}
        comboboxProps={{ withinPortal: false }}
      />
    </Group>
  )
}
