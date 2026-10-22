import type { DailyWindow, PollSchedule } from './types'

/**
 * Time-poll arithmetic: a painted calendar into options, a painting into
 * scores, and scores back into a painting. The database sees an ordinary poll;
 * everything that makes it a calendar is here. See "A poll that finds a time"
 * in AGENTS.md.
 *
 * Everything above the "Offsets" section is pure wall-clock arithmetic in the
 * poll's fixed UTC offset — no `Date` as a clock, no `Intl`.
 *
 * - A **window start** is an option's name: `2026-09-01T14:00:00-07:00`.
 * - A **granule key** is one grid cell: `2026-09-01 14:00`, in the poll's offset.
 *
 * Both sort chronologically as plain text.
 */

/** `2026-09-01T14:00:00-07:00` -- an option's name on a time poll. */
export type WindowStart = string

/** `2026-09-01 14:00` -- one cell of the grid, in the poll's own offset. */
export type GranuleKey = string

/** `2026-09-01` -- a day the poll is asking about. */
export type ScheduleDay = string

/** The cells a poll is asking about: the creator's painting, or `boundsOf` the options. */
export type Bounds = ReadonlySet<GranuleKey>

export const DAY_MINUTES = 1440

/** How long a meeting is, in minutes. Not stored: every window is this long. */
export function meetingMinutes(schedule: PollSchedule): number {
  return schedule.desired_slots * schedule.granularity
}

export function isDaily(schedule: PollSchedule): boolean {
  return schedule.granularity >= DAY_MINUTES
}

/** Half an hour below a day, a whole day at or above one. Derived, never chosen. */
export function granularityFor(lengthMinutes: number): number {
  return lengthMinutes < DAY_MINUTES ? 30 : DAY_MINUTES
}

/** `14:30` to 870. */
export function toMinutes(timeOfDay: string): number {
  const [hours, minutes] = timeOfDay.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/**
 * 870 to `14:30`, and 1440 to `24:00` (the end of a day). This is the key
 * format, not display -- what a person reads goes through `formatTimeOfDay`.
 */
export function toTimeOfDay(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * 870 as a person reads it: `14:30` or `2:30pm`. Every time on screen goes
 * through here so one screen never mixes clocks (`lib/clock.ts`).
 */
export function formatTimeOfDay(minutes: number, h24: boolean): string {
  if (h24) return toTimeOfDay(minutes)
  const hours = Math.floor(minutes / 60) % 24
  const suffix = hours < 12 ? 'am' : 'pm'
  return `${hours % 12 || 12}:${String(minutes % 60).padStart(2, '0')}${suffix}`
}

/**
 * A stretch as a month chip says it: `09:00–11:00`, or `9–11am`. The 12-hour
 * form drops `:00` and a shared suffix so it fits a phone-width month cell.
 */
export function formatTimeRange(from: number, to: number, h24: boolean): string {
  if (h24) return `${formatTimeOfDay(from, true)}–${formatTimeOfDay(to, true)}`
  const short = (minutes: number) => formatTimeOfDay(minutes, false).replace(':00', '')
  const start = short(from)
  const end = short(to)
  const sameHalf = start.slice(-2) === end.slice(-2)
  return `${sameHalf ? start.slice(0, -2) : start}–${end}`
}

export function granuleKey(day: ScheduleDay, minutes: number): GranuleKey {
  return `${day} ${toTimeOfDay(minutes)}`
}

export function splitGranule(key: GranuleKey): { day: ScheduleDay; minutes: number } {
  return { day: key.slice(0, 10), minutes: toMinutes(key.slice(11)) }
}

/** The cell `by` minutes later, carrying into the next day -- which is what lets a window outlast a day. */
export function stepGranule(key: GranuleKey, by: number): GranuleKey {
  const { day, minutes } = splitGranule(key)
  const total = minutes + by
  const days = Math.floor(total / DAY_MINUTES)
  return granuleKey(days === 0 ? day : addDays(day, days), total - days * DAY_MINUTES)
}

/**
 * Every window on offer, in order: one per start such that every cell the
 * window covers was painted. A gap in the painting is a gap in the options.
 */
export function enumerateWindows(schedule: PollSchedule, bounds: Bounds): WindowStart[] {
  const starts: WindowStart[] = []

  for (const key of [...bounds].sort()) {
    let at = key
    let whole = true
    for (let slot = 1; slot < schedule.desired_slots; slot++) {
      at = stepGranule(at, schedule.granularity)
      if (!bounds.has(at)) {
        whole = false
        break
      }
    }
    if (!whole) continue

    const { day, minutes } = splitGranule(key)
    starts.push(`${day}T${toTimeOfDay(minutes)}:00${schedule.timezone}`)
  }
  return starts
}

export function countWindows(schedule: PollSchedule, bounds: Bounds): number {
  return enumerateWindows(schedule, bounds).length
}

/**
 * The cells a poll's options cover -- the bounds, read back off the ballot.
 * This is why bounds are never stored. Lossy at the edges, correctly: a cell
 * no window covers is one a voter could paint to no effect.
 */
export function boundsOf(windowStarts: WindowStart[], schedule: PollSchedule): Set<GranuleKey> {
  const cells = new Set<GranuleKey>()
  for (const start of windowStarts) {
    for (const key of granulesOf(start, schedule)) cells.add(key)
  }
  return cells
}

/**
 * The painting, less whatever falls before `first`. Re-applied when options
 * are built, for a form left open across midnight or moved to a later offset.
 */
export function fromDay(bounds: Bounds, first: ScheduleDay): Set<GranuleKey> {
  return new Set([...bounds].filter((key) => key.slice(0, 10) >= first))
}

export function daysOf(bounds: Bounds): ScheduleDay[] {
  const days = new Set<ScheduleDay>()
  for (const key of bounds) days.add(key.slice(0, 10))
  return [...days].sort()
}

export function boundsOnDay(bounds: Bounds, day: ScheduleDay): GranuleKey[] {
  return [...bounds].filter((key) => key.startsWith(day)).sort()
}

/**
 * The union of every day's hours: what `window` is set to at creation, so one
 * grid axis can hold days with different hours. With nothing painted, the
 * whole day.
 */
export function spanOf(bounds: Bounds, schedule: PollSchedule): DailyWindow {
  let first: number | null = null
  let last: number | null = null

  for (const key of bounds) {
    const at = toMinutes(key.slice(11))
    if (first === null || at < first) first = at
    if (last === null || at + schedule.granularity > last) last = at + schedule.granularity
  }

  if (first === null || last === null) return { start: '00:00', end: '24:00' }
  return { start: toTimeOfDay(first), end: toTimeOfDay(Math.min(last, DAY_MINUTES)) }
}

/**
 * The hours a grid is drawn between: `hours`, widened (never clipped) to hold
 * anything marked outside them -- a painted cell off the axis would be an
 * answer nobody can see or rub out.
 */
export function axisFor(hours: DailyWindow, marked: Bounds, schedule: PollSchedule): DailyWindow {
  if (marked.size === 0) return hours
  const painted = spanOf(marked, schedule)
  // `HH:mm` is fixed width, so these compare as strings, `24:00` included.
  return {
    start: painted.start < hours.start ? painted.start : hours.start,
    end: painted.end > hours.end ? painted.end : hours.end,
  }
}

/** The cells `hours` covers on one day -- what a day-fill writes. One cell on a daily poll. */
export function cellsInHours(
  day: ScheduleDay,
  hours: DailyWindow,
  granularity: number,
): GranuleKey[] {
  if (granularity >= DAY_MINUTES) return [granuleKey(day, 0)]
  const last = toMinutes(hours.end)
  const keys: GranuleKey[] = []
  for (let at = toMinutes(hours.start); at + granularity <= last; at += granularity) {
    keys.push(granuleKey(day, at))
  }
  return keys
}

// `Date` as a calendar only, in UTC, so a DST change in the browser's zone
// cannot turn a week into six days and 23 hours.
function addDays(day: ScheduleDay, count: number): ScheduleDay {
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  const moved = new Date(Date.UTC(year, month - 1, dayOfMonth + count))
  return moved.toISOString().slice(0, 10)
}

function daysApart(from: ScheduleDay, to: ScheduleDay): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/**
 * A duplicate's painting: moved forward by the fewest whole weeks that put its
 * first day on or after `today` (none if it is already ahead), so weekdays hold.
 * `weeks` is returned so the form can say the dates moved.
 */
export function carryForward(
  bounds: Bounds,
  today: ScheduleDay,
): { bounds: Set<GranuleKey>; weeks: number } {
  const days = daysOf(bounds)
  if (days.length === 0 || days[0] >= today) return { bounds: new Set(bounds), weeks: 0 }

  const weeks = Math.ceil(daysApart(days[0], today) / 7)
  return { bounds: shiftDays(bounds, weeks * 7), weeks }
}

/**
 * A painting moved, every cell by the same number of days, so its first day is
 * `first` -- the date a duplicate's creator picked. `from` is the day that
 * lands there, for moving several questions of one poll together; it defaults
 * to this painting's own first day.
 */
export function startingOn(
  bounds: Bounds,
  first: ScheduleDay,
  from: ScheduleDay | undefined = daysOf(bounds)[0],
): Set<GranuleKey> {
  return from ? shiftDays(bounds, daysApart(from, first)) : new Set(bounds)
}

function shiftDays(bounds: Bounds, by: number): Set<GranuleKey> {
  const moved = new Set<GranuleKey>()
  for (const key of bounds) {
    const { day, minutes } = splitGranule(key)
    moved.add(granuleKey(addDays(day, by), minutes))
  }
  return moved
}

/** Day, time and offset out of an option's name; null for anything that is not one. */
export function parseWindowStart(
  name: string,
): { day: ScheduleDay; timeOfDay: string; offset: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}([+-]\d{2}:\d{2})$/.exec(name)
  if (!match) return null
  return { day: match[1], timeOfDay: match[2], offset: match[3] }
}

/** The `desired_slots` cells one window covers, which may run past midnight. */
export function granulesOf(start: WindowStart, schedule: PollSchedule): GranuleKey[] {
  const parsed = parseWindowStart(start)
  if (!parsed) return []

  const keys: GranuleKey[] = [granuleKey(parsed.day, toMinutes(parsed.timeOfDay))]
  for (let slot = 1; slot < schedule.desired_slots; slot++) {
    keys.push(stepGranule(keys[slot - 1], schedule.granularity))
  }
  return keys
}

/**
 * A painting flattened into a score per window: the rounded mean of its
 * granules, but 5 only if every granule is 5 and 0 only if every granule is 0.
 * An unpainted granule is 0 (unavailable).
 */
export function scoresFromPainting(
  windowStarts: WindowStart[],
  painting: Record<GranuleKey, number>,
  schedule: PollSchedule,
): Record<WindowStart, number> {
  const scores: Record<WindowStart, number> = {}
  for (const start of windowStarts) {
    const keys = granulesOf(start, schedule)
    let total = 0
    let lowest = 5
    let highest = 0
    for (const key of keys) {
      const rating = painting[key] ?? 0
      total += rating
      lowest = Math.min(lowest, rating)
      highest = Math.max(highest, rating)
    }
    if (keys.length === 0 || highest === 0) scores[start] = 0
    else if (lowest === 5) scores[start] = 5
    else scores[start] = Math.max(1, Math.min(4, Math.round(total / keys.length)))
  }
  return scores
}

/**
 * A ballot repainted onto the calendar. A 0 window vetoes every granule under
 * it; otherwise a granule takes the highest window covering it. Exact for
 * blocks at least a meeting long; anything shorter blurs, so re-saving an
 * unedited ballot can move a rating a step.
 */
export function paintingFromScores(
  windowStarts: WindowStart[],
  scores: Record<WindowStart, number>,
  schedule: PollSchedule,
): Record<GranuleKey, number> {
  const painting: Record<GranuleKey, number> = {}
  const vetoed = new Set<GranuleKey>()
  for (const start of windowStarts) {
    const score = scores[start] ?? 0
    const keys = granulesOf(start, schedule)
    if (score === 0) {
      for (const key of keys) vetoed.add(key)
      continue
    }
    for (const key of keys) {
      painting[key] = Math.max(painting[key] ?? 0, score)
    }
  }
  for (const key of vetoed) delete painting[key]
  return painting
}

/**
 * Each cell's average rating across several ballots. Averaged over the
 * repainted paintings (not the scores) so a set of one voter is exactly that
 * voter's calendar. Unpainted counts as 0; cells averaging 0 are dropped.
 */
export function averagePainting(
  windowStarts: WindowStart[],
  ballots: Record<WindowStart, number>[],
  schedule: PollSchedule,
): Record<GranuleKey, number> {
  const totals: Record<GranuleKey, number> = {}
  for (const scores of ballots) {
    const painting = paintingFromScores(windowStarts, scores, schedule)
    for (const [key, rating] of Object.entries(painting)) {
      totals[key] = (totals[key] ?? 0) + rating
    }
  }
  const average: Record<GranuleKey, number> = {}
  for (const [key, total] of Object.entries(totals)) {
    if (total > 0) average[key] = total / ballots.length
  }
  return average
}

// ---------------------------------------------------------------------------
// Meeting lengths
// ---------------------------------------------------------------------------

const LONGEST_MEETING = 8 * 60

/**
 * Every half hour up to eight hours, then whole days up to a fortnight.
 * Nothing between eight hours and a day is offered on purpose.
 */
export const MEETING_LENGTHS: number[] = [
  ...Array.from({ length: LONGEST_MEETING / 30 }, (_, i) => (i + 1) * 30),
  ...Array.from({ length: 14 }, (_, i) => (i + 1) * DAY_MINUTES),
]

/** `30 minutes`, `1 hour`, `1.5 hours`, `3 days`. */
export function describeLength(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  if (minutes < DAY_MINUTES) {
    const hours = minutes / 60
    return hours === 1 ? '1 hour' : `${trimmed(hours)} hours`
  }
  const days = minutes / DAY_MINUTES
  return days === 1 ? '1 day' : `${trimmed(days)} days`
}

function trimmed(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

// ---------------------------------------------------------------------------
// Offsets -- the only functions here that read a clock or `Intl`. None of
// their answers reaches a window start, a granule key or a score.
// ---------------------------------------------------------------------------

/** 870 to `+14:30`, -420 to `-07:00`. */
function toOffset(minutes: number): string {
  return `${minutes < 0 ? '-' : '+'}${toTimeOfDay(Math.abs(minutes))}`
}

/** `-07:00` to -420; null if it is not an offset. */
export function offsetMinutes(offset: string): number | null {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset)
  if (!match) return null
  const size = Number(match[2]) * 60 + Number(match[3])
  return match[1] === '-' ? -size : size
}

/**
 * Today's date on the *poll's* clock, not the reader's -- a creator in
 * Auckland painting a `-07:00` poll is a day ahead of its grid.
 */
export function todayIn(offset: string, now: number = Date.now()): ScheduleDay {
  return new Date(now + (offsetMinutes(offset) ?? 0) * 60_000).toISOString().slice(0, 10)
}

/**
 * This browser's offset right now, as a last-resort default. Note
 * `getTimezoneOffset` is minutes *behind* UTC, hence the negation. Rounded to
 * the quarter hour and clamped to the range the picker offers.
 */
export function browserOffset(): string {
  const behind = new Date().getTimezoneOffset()
  const minutes = Math.round(-behind / 15) * 15
  const clamped = Math.max(-12 * 60, Math.min(14 * 60, minutes))
  return toOffset(clamped)
}

/**
 * A named zone's offset on one particular day: `-06:00` for `America/Denver`
 * in July, `-07:00` in December. Asked about the poll's dates rather than now,
 * since a meeting in July is held at July's offset. Used to caption offsets
 * (`timezones.ts`) and to guess the creator's.
 */
export function zoneOffsetOn(timeZone: string, day: ScheduleDay): string | null {
  const noon = Date.parse(`${day}T12:00:00Z`)
  if (Number.isNaN(noon)) return null

  // Two passes: the first measures the offset at noon UTC, which may be a
  // different local day; shifting by it lands on local noon, which is never
  // near a clock change.
  const guess = offsetAt(timeZone, noon)
  if (guess === null) return null
  const minutes = offsetMinutes(guess)
  if (minutes === null) return guess
  return offsetAt(timeZone, noon - minutes * 60_000) ?? guess
}

function offsetAt(timeZone: string, instant: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date(instant))
    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
    // `GMT-06:00`, or bare `GMT` at zero on some runtimes.
    if (name === 'GMT') return '+00:00'
    const match = /GMT([+-]\d{2}:\d{2})$/.exec(name)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * `UTC-07:00 (Pacific Time)`, or `UTC-07:00` with no label. Bracketed rather
 * than dotted because the ballot puts it in a line of `·`-separated clauses.
 */
export function describeOffset(offset: string, label?: string | null): string {
  const named = label?.trim()
  return named ? `UTC${offset} (${named})` : `UTC${offset}`
}

export function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** What a whole-day fill lays down, and where the create form's selects open. Not stored. */
export const DEFAULT_HOURS: DailyWindow = { start: '09:00', end: '17:00' }

/** A new time poll: an hour-long meeting in this browser's offset. */
export function blankSchedule(): PollSchedule {
  return {
    timezone: browserOffset(),
    window: { ...DEFAULT_HOURS },
    desired_slots: 2,
    granularity: 30,
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * An option's name for reading: `2:00pm, Tue Sep 1`, or just the day for a
 * window starting at midnight (every option of a daily poll does). Anything
 * that is not a window start is returned untouched, so this is safe to apply
 * to every poll's names without knowing its kind.
 *
 * Formatted by hand: any `Intl` formatter taking a `Date` would apply the
 * reader's zone, and the poll's grid is the same for everyone.
 */
export function formatWindow(name: string, h24: boolean): string {
  const parsed = parseWindowStart(name)
  if (!parsed) return name

  const at = toMinutes(parsed.timeOfDay)
  return at === 0 ? formatDay(parsed.day) : `${formatTimeOfDay(at, h24)}, ${formatDay(parsed.day)}`
}

/** `Fri Feb 20`. */
export function formatDay(day: ScheduleDay): string {
  const [, month, dayOfMonth] = day.split('-').map(Number)
  return `${WEEKDAYS[weekdayOf(day)]} ${MONTHS[month - 1]} ${dayOfMonth}`
}

/** 0 for Sunday. Computed in UTC, like `addDays`. */
export function weekdayOf(day: ScheduleDay): number {
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay()
}

/**
 * The painting as runs of neighbouring same-valued cells within a day, one
 * calendar event per run. Zeros draw nothing.
 */
export function paintingRuns(
  painting: Record<GranuleKey, number>,
  schedule: PollSchedule,
): { day: ScheduleDay; from: number; to: number; value: number }[] {
  const cells = Object.entries(painting)
    .filter(([, value]) => value > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))

  const runs: { day: ScheduleDay; from: number; to: number; value: number }[] = []
  for (const [key, value] of cells) {
    const day = key.slice(0, 10)
    const from = toMinutes(key.slice(11))
    const last = runs[runs.length - 1]
    if (last && last.value === value && last.day === day && last.to === from) {
      last.to = from + schedule.granularity
      continue
    }
    runs.push({ day, from, to: from + schedule.granularity, value })
  }
  return runs
}

/**
 * A run as `YYYY-MM-DD HH:mm:ss` at both ends. A run reaching midnight ends at
 * `23:59:59`, since the calendar library cannot parse `24:00:00`.
 */
export function runBounds(run: { day: ScheduleDay; from: number; to: number }): {
  start: string
  end: string
} {
  return {
    start: `${run.day} ${toTimeOfDay(run.from)}:00`,
    end: run.to >= DAY_MINUTES ? `${run.day} 23:59:59` : `${run.day} ${toTimeOfDay(run.to)}:00`,
  }
}

/**
 * The inverse of `runBounds` (also how a dragged range is read). Half-open,
 * which is what brings `23:59:59` back whole. A stretch never crosses midnight.
 */
export function granulesBetween(start: string, end: string, granularity: number): GranuleKey[] {
  const day = start.slice(0, 10)
  const to = toMinutes(end.slice(11, 16))
  const keys: GranuleKey[] = []
  for (let at = toMinutes(start.slice(11, 16)); at < to; at += granularity) {
    keys.push(granuleKey(day, at))
  }
  return keys
}

// ---------------------------------------------------------------------------
// Results: option names are rewritten once on the payload, so nothing that
// renders `name` needs to know it is drawing a time poll. Safe on any poll,
// since `formatWindow` passes ordinary names through.
// ---------------------------------------------------------------------------

type Labelled = {
  options: { name: string }[]
  tiebreaks: {
    tied: { name: string }[]
    advanced: { name: string }[]
    steps: ({ results: { name: string }[] } & {
      matchups?: { a_name: string; b_name: string }[]
    })[]
  }[]
}

export function relabelResults<T extends Labelled>(results: T, h24: boolean): T {
  const label = (name: string) => formatWindow(name, h24)
  return {
    ...results,
    options: results.options.map((option) => ({ ...option, name: label(option.name) })),
    tiebreaks: results.tiebreaks.map((tiebreak) => ({
      ...tiebreak,
      tied: tiebreak.tied.map((entry) => ({ ...entry, name: label(entry.name) })),
      advanced: tiebreak.advanced.map((entry) => ({ ...entry, name: label(entry.name) })),
      steps: tiebreak.steps.map((step) => ({
        ...step,
        results: step.results.map((entry) => ({ ...entry, name: label(entry.name) })),
        ...(step.matchups
          ? {
              matchups: step.matchups.map((matchup) => ({
                ...matchup,
                a_name: label(matchup.a_name),
                b_name: label(matchup.b_name),
              })),
            }
          : {}),
      })),
    })),
  }
}

export function relabelRanking<T extends Labelled>(ranking: T[], h24: boolean): T[] {
  return ranking.map((place) => relabelResults(place, h24))
}

export function relabelSheet<T extends { options: { name: string }[] }>(sheet: T, h24: boolean): T {
  return {
    ...sheet,
    options: sheet.options.map((option) => ({ ...option, name: formatWindow(option.name, h24) })),
  }
}

/** A settled winner's badge label. `undefined` (not settled) and `null` (no winner) pass through. */
export function winnerLabel(
  name: string | null | undefined,
  h24: boolean,
): string | null | undefined {
  return name ? formatWindow(name, h24) : name
}
