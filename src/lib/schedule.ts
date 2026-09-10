import type { DailyWindow, PollSchedule } from './types'

/**
 * The one piece of real logic a time poll has: turning a painted calendar into
 * options, turning a painted calendar into scores, and turning them back.
 *
 * A time poll is a poll whose options happen to be meeting times. The
 * database never learns that -- `poll_tally`, `star_round`, `settle_winner`,
 * the RLS policies and the voter-key path all see sixty rows in `candidates`
 * and a score per row, exactly as they do for a poll about pizza. What makes
 * it a calendar is entirely here: the creator's browser enumerates the windows
 * when the poll is made, and the voter's browser flattens a painting into a
 * score per window before it is sent.
 *
 * So this file is where the feature can actually be wrong, and every function
 * that touches a window, a granule or a score is a pure function of its
 * arguments for that reason. No `Date`, no `Intl`, no reading of the clock: a
 * poll is held in one fixed UTC offset that its creator declared, and every
 * calculation of that kind is wall-clock arithmetic in that offset. A voter in
 * Berlin and a voter in Denver are shown the same grid with the same labels,
 * which is the whole of what "one timezone per poll" buys and the reason none
 * of this needs a timezone library.
 *
 * The exceptions are gathered under *Offsets, and the four functions that are
 * allowed to read a clock*, well below everything the ballot is built from.
 * They turn a place into the offset a poll is then held at, and an offset into
 * a sentence for the person reading it; none of their answers is ever an
 * argument to anything above them.
 *
 * Two string shapes carry everything:
 *
 * - A **window start** is an option's name: `2026-09-01T14:00:00-07:00`. Full
 *   ISO 8601 with the poll's offset on it, so it is unambiguous on its own,
 *   unique within the poll (which is what `insert_option`'s case-insensitive
 *   duplicate check needs), and sorts chronologically as plain text.
 * - A **granule key** is one cell of the grid: `2026-09-01 14:00`. Wall clock
 *   in the poll's offset with no zone on it, which is the format
 *   `@mantine/schedule` hands back from its slot callbacks, minus the seconds.
 *   Fixed width, so a set of them sorts chronologically as plain text too.
 *
 * The duration of a meeting is not stored and not in any name: it is
 * `desired_slots * granularity`, and every window is that long.
 *
 * **What a poll is asking about is a set of cells, and nothing else.** There
 * is no list of days and no pair of times per day in the schedule -- the
 * creator paints the calendar exactly as a voter does, and the painting
 * becomes the option list. Reading it back is `boundsOf`: the cells covered by
 * at least one window are exactly the cells a voter can usefully mark, so the
 * options *are* the bounds and the two can never disagree. That is why the
 * only thing `schedule` still says about the shape of a day is `window`, which
 * is the vertical axis a grid is drawn on.
 */

/** `2026-09-01T14:00:00-07:00` -- an option's name on a time poll. */
export type WindowStart = string

/** `2026-09-01 14:00` -- one cell of the grid, in the poll's own offset. */
export type GranuleKey = string

/** `2026-09-01` -- a day the poll is asking about. */
export type ScheduleDay = string

/**
 * The cells a poll is asking about.
 *
 * On the create form it is what the creator has painted; on a ballot it is
 * `boundsOf` the options. One type either way, because the two are the same
 * question asked at two moments and every rule below reads them the same.
 */
export type Bounds = ReadonlySet<GranuleKey>

/** Minutes in a day, which is also the coarsest granule there is. */
export const DAY_MINUTES = 1440

/** How long a meeting is, in minutes. Not stored: every window is this long. */
export function meetingMinutes(schedule: PollSchedule): number {
  return schedule.desired_slots * schedule.granularity
}

/**
 * Whether this poll's unit is a whole day rather than part of one.
 *
 * A meeting of a day or more is answered in days: there is no useful sense in
 * which somebody is free from 09:00 on Tuesday to 09:00 on Thursday but not
 * from 10:00 to 10:00, and asking for that resolution would multiply a
 * three-day poll's options by forty-eight. So the granularity is derived from
 * the length rather than chosen -- see `granularityFor` -- and everything that
 * reads differently at day resolution asks here rather than comparing numbers.
 */
export function isDaily(schedule: PollSchedule): boolean {
  return schedule.granularity >= DAY_MINUTES
}

/**
 * The resolution a meeting of this length is answered at: half an hour below a
 * day, a whole day at or above one.
 *
 * Derived rather than asked, which is the whole of the rule. Granularity was a
 * question on the create form, and it is not a question anybody has an opinion
 * about -- it is a consequence of how long the meeting is, and the one
 * combination people chose by hand that mattered (a length the grid cannot
 * express) was one the form then had to refuse.
 */
export function granularityFor(lengthMinutes: number): number {
  return lengthMinutes < DAY_MINUTES ? 30 : DAY_MINUTES
}

/** `14:30` to 870. The one direction; `toTimeOfDay` is the other. */
export function toMinutes(timeOfDay: string): number {
  const [hours, minutes] = timeOfDay.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/**
 * 870 to `14:30`, and 1440 to `24:00` -- midnight at the end of a day, which
 * is where a window running to the end of one finishes and which `00:00` would
 * read as the start of it.
 *
 * This is both the wall clock the grid is keyed by and the clock a person
 * reads, because those are now the same string: every time in this app is
 * twenty-four hour time. The create form's two selectors used to say `2:00pm`
 * while the calendar beside them said `14:00`, which is one poll described two
 * ways on one screen.
 */
export function toTimeOfDay(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** One cell of the grid, from the two halves of it. */
export function granuleKey(day: ScheduleDay, minutes: number): GranuleKey {
  return `${day} ${toTimeOfDay(minutes)}`
}

/** And back again. */
export function splitGranule(key: GranuleKey): { day: ScheduleDay; minutes: number } {
  return { day: key.slice(0, 10), minutes: toMinutes(key.slice(11)) }
}

/**
 * The cell `by` minutes after this one, carrying into the next day.
 *
 * The carry is what lets a window be longer than a day. At half-hour
 * resolution it fires only on a poll whose bounds run to midnight and pick up
 * again after it; at day resolution it fires on every step, because the step
 * *is* a day.
 */
export function stepGranule(key: GranuleKey, by: number): GranuleKey {
  const { day, minutes } = splitGranule(key)
  const total = minutes + by
  const days = Math.floor(total / DAY_MINUTES)
  return granuleKey(days === 0 ? day : addDays(day, days), total - days * DAY_MINUTES)
}

/**
 * Every window the creator is offering, in order: one option per start time.
 *
 * A window is offered when every cell it covers was painted, which is the
 * whole rule and the reason there is nothing else to say about which times a
 * poll asks about. A three-hour meeting on a day painted 09:00-12:00 offers
 * exactly one start; painted 09:00-13:00 it offers three; painted 09:00-10:00
 * it offers none, and that day quietly contributes nothing -- which the create
 * form says out loud rather than leaving to be found on the ballot.
 *
 * It follows that a gap in the painting is a gap in the options. A creator who
 * paints a morning and an afternoon and leaves lunch out is offering no window
 * that spans lunch, which is what they said.
 *
 * Chronological, which is both what a reader expects and what `sort_order`
 * ends up holding, since `create_poll` keeps the order it is given.
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

/** The size of the ballot those bounds would produce, without building it. */
export function countWindows(schedule: PollSchedule, bounds: Bounds): number {
  return enumerateWindows(schedule, bounds).length
}

/**
 * The cells a poll's options cover: the bounds, read back off the ballot.
 *
 * **This is why nothing about which days or hours are in bounds is stored.**
 * A cell no window covers is a cell a voter could paint to no effect -- no
 * option's score would move -- so the cells worth offering are exactly the
 * cells the options cover, and those are recoverable from the option list
 * alone. A poll cannot then be in a state where its stored bounds and its
 * stored options disagree, because there is only one of them.
 *
 * The cost is that the last granule or two of a painted stretch drop out: a
 * day painted 09:00-12:00 for a three-hour meeting is one window covering all
 * six half-hours, but painted 09:00-12:30 the 12:00 cell is covered by the
 * second window and painted 09:00-11:30 nothing is covered at all. Which is
 * correct -- those are the cells that can change an answer.
 */
export function boundsOf(windowStarts: WindowStart[], schedule: PollSchedule): Set<GranuleKey> {
  const cells = new Set<GranuleKey>()
  for (const start of windowStarts) {
    for (const key of granulesOf(start, schedule)) cells.add(key)
  }
  return cells
}

/** The days a poll is asking about: exactly the days its cells fall on. */
export function daysOf(bounds: Bounds): ScheduleDay[] {
  const days = new Set<ScheduleDay>()
  for (const key of bounds) days.add(key.slice(0, 10))
  return [...days].sort()
}

/** The cells in bounds on one day, in order. */
export function boundsOnDay(bounds: Bounds, day: ScheduleDay): GranuleKey[] {
  return [...bounds].filter((key) => key.startsWith(day)).sort()
}

/**
 * The hours the grid has to be tall enough to draw: the union of every day's.
 *
 * This is what `window` is set to when a poll is created, and it is the one
 * thing about the shape of a day that is stored -- because it is the only one
 * a grid cannot be drawn without, and because a poll whose Friday starts at
 * 18:00 and whose Saturday starts at 09:00 has to be drawn on one axis running
 * 09:00 to 22:00 with Friday morning greyed out, rather than on two grids or
 * on one that clips whichever day it was not built for.
 *
 * With nothing painted there is no union to take, so a whole day stands. The
 * create form is in that state until somebody paints a cell.
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
 * A date some whole days later, and the whole days between two dates.
 *
 * `Date` is used here as a calendar and never as a clock, which is the same
 * licence `formatWindow` takes further down and is safe for the same reason:
 * the parts go in as wall clock, come out as wall clock, and no instant is
 * ever compared against anybody's own zone. Built in UTC so that a browser
 * sitting in a zone with a daylight-saving change in the middle of the range
 * cannot turn a week into six days and 23 hours.
 */
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
 * The same poll, on the next dates that have not already gone: what a
 * *duplicate* of a time poll asks about.
 *
 * Everything else in a schedule copies straight across -- how long the meeting
 * is, at what resolution, where in the world -- and the painting is the one
 * part that cannot, because the whole reason to duplicate a poll about last
 * Friday is to ask about a Friday that is still ahead. Copied verbatim it
 * would be a form pre-filled with a fortnight nobody can attend.
 *
 * **Whole weeks, so the weekdays hold.** That is the point of shifting rather
 * than clearing: a painting that says "Friday evenings, Saturday from nine" is
 * an answer about days of the week, and a Friday moved onto a Wednesday is
 * that answer given about the wrong day.
 *
 * The smallest number of weeks that puts the first day on or after `today`, so
 * a poll whose dates are still ahead is not moved at all: duplicating a poll
 * you made this morning gives you back the dates you picked this morning.
 * `today` is an argument rather than a reading of the clock, which is what
 * keeps this in the pure half of the file.
 *
 * `weeks` comes back with it because the form says so on screen. Dates that
 * moved on their own are exactly the kind of thing a creator notices two
 * screens later, or never.
 */
export function carryForward(
  bounds: Bounds,
  today: ScheduleDay,
): { bounds: Set<GranuleKey>; weeks: number } {
  const days = daysOf(bounds)
  if (days.length === 0 || days[0] >= today) return { bounds: new Set(bounds), weeks: 0 }

  const weeks = Math.ceil(daysApart(days[0], today) / 7)
  const shift = weeks * 7
  const moved = new Set<GranuleKey>()
  for (const key of bounds) {
    const { day, minutes } = splitGranule(key)
    moved.add(granuleKey(addDays(day, shift), minutes))
  }
  return { bounds: moved, weeks }
}

/**
 * Pull the day and the wall-clock time back out of an option's name.
 *
 * Deliberately strict, and null rather than a throw: this is applied to names
 * that came from the database, and a `time` poll whose options were written by
 * some other means is a poll the calendar should decline to draw rather than
 * one it should draw wrongly.
 */
export function parseWindowStart(
  name: string,
): { day: ScheduleDay; timeOfDay: string; offset: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}([+-]\d{2}:\d{2})$/.exec(name)
  if (!match) return null
  return { day: match[1], timeOfDay: match[2], offset: match[3] }
}

/**
 * The grid cells one window covers: `desired_slots` of them, starting at its
 * own start.
 *
 * A window may run past midnight -- a three-day retreat is three cells on
 * three dates, and at half-hour resolution a poll whose bounds run through
 * midnight can offer one too -- so the walk is `stepGranule` rather than
 * arithmetic on one date.
 */
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
 * A painted calendar, flattened into the score per window that gets sent.
 *
 * **A window's rating is the mean of the granules it covers, rounded** -- with
 * the two ends of the scale kept exact. A window scores 5 only when every
 * granule under it is a 5, and 0 only when every granule under it is a 0;
 * everything else lands somewhere in 1-4, however lopsided the mean. So the
 * two claims that are not matters of degree, "all of this works" and "none of
 * this does", are still only made when they are true.
 *
 * The mean is the load-bearing choice, and it is a mean rather than a minimum
 * because **a window a voter can attend most of is genuinely better than one
 * they cannot attend at all.** Taking the lowest granule threw that difference
 * away: half an hour of conflict inside a three-hour window and a diary full
 * of conflict both came out as 0, so a poll where nobody is completely free
 * had nothing to elect and every ballot in it said the same nothing. The
 * ordering it produces is the one people mean -- a window with one bad half
 * hour beats a window with three, and neither beats a window with none.
 *
 * An unpainted granule is 0, and 0 is a real rating meaning unavailable rather
 * than a missing answer. That is the same reading `BallotCard` already gives
 * an unscored option when it sends `values[o.id] ?? 0`.
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
    // Rounded to the nearest star, then held off both ends: neither promise
    // is one an average is allowed to make on the granules' behalf.
    else scores[start] = Math.max(1, Math.min(4, Math.round(total / keys.length)))
  }
  return scores
}

/**
 * A ballot read back, repainted onto the calendar.
 *
 * The inverse of the rule above, as far as there is one, and it is two rules
 * applied in this order:
 *
 * - **A 0 vetoes.** A window scores 0 only when every granule under it is a 0,
 *   so a 0 is a promise about each of them and nothing may overrule it.
 * - **Otherwise a granule takes the highest window covering it.** A 5 is the
 *   mirror promise, and for the ratings in between, the best window over a
 *   granule is the closest thing to evidence about that granule there is.
 *
 * Between them they are exact on the paintings people actually make: a block
 * of one rating at least as long as the meeting contains a window made of
 * nothing but itself, so it comes back as it went in, and an unmarked stretch
 * that long comes back empty for the same reason.
 *
 * **What blurs is anything shorter than the meeting**, and that is not a
 * choice -- the scores simply do not carry it. One busy half hour inside a
 * free afternoon lowers every window over it by a step, so it returns as a dip
 * rather than a hole; one free half hour in a busy day lifts its windows to a
 * 1, so it returns marked but faint. The blur is in the rating and not in the
 * position: the veto keeps every edge where the voter put it, except within
 * one meeting's length of the ends of the poll's own bounds, where there is no
 * room for an all-zero window to say the times are empty.
 *
 * So saving an unedited ballot back is not a no-op -- it can move a rating a
 * step. That is the accepted trade for storing windows rather than granules,
 * which is what lets a time poll be an ordinary poll everywhere else in the
 * app.
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

// ---------------------------------------------------------------------------
// How long a meeting is, as a person says it
// ---------------------------------------------------------------------------

/**
 * The lengths a meeting may be, in minutes: every half hour up to a day, then
 * whole days.
 *
 * The step is the granularity the length implies -- see `granularityFor` --
 * which is what keeps the two from ever disagreeing: there is no length in
 * this list that its own granularity cannot express.
 *
 * A fortnight is the top, and arbitrarily so; the ballot for one is a month
 * grid with fourteen days to click, and a poll looking for a longer block than
 * that is asking a question about a calendar rather than about a meeting.
 */
export const MEETING_LENGTHS: number[] = [
  ...Array.from({ length: 47 }, (_, i) => (i + 1) * 30),
  ...Array.from({ length: 14 }, (_, i) => (i + 1) * DAY_MINUTES),
]

/**
 * `30 minutes`, `1 hour`, `1.5 hours`, `3 days`.
 *
 * Decimal hours rather than "1 hour, 30 minutes", which is two units to read
 * where one will do and which sorts badly against its neighbours in a list --
 * `1 hour`, `1 hour, 30 minutes`, `2 hours` is three shapes for three
 * consecutive rows. One trailing digit at most, because the shortest step is
 * half an hour.
 */
export function describeLength(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  if (minutes < DAY_MINUTES) {
    const hours = minutes / 60
    return hours === 1 ? '1 hour' : `${trimmed(hours)} hours`
  }
  const days = minutes / DAY_MINUTES
  return days === 1 ? '1 day' : `${trimmed(days)} days`
}

/** `2`, and `1.5` -- a number with no decimal point it does not need. */
function trimmed(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
// ---------------------------------------------------------------------------
// Offsets, and the only functions here allowed to read a clock
// ---------------------------------------------------------------------------

/**
 * Everything above this line is wall-clock arithmetic in the poll's own offset
 * and touches nothing outside its arguments. Below it sit the offset
 * functions, and three of them -- `browserOffset`, `zoneOffsetOn`,
 * `viewerZone` -- read `Date` and `Intl`: the reader's own clock and the
 * world's zone database. They are gathered here rather than scattered so that
 * the exception is one place rather than three.
 *
 * **None of their answers reaches a window start, a granule key or a score.**
 * `zoneOffsetOn` is what [`timezones.ts`](timezones.ts) asks to work out what
 * an offset is called on the poll's own dates; the other two say where the
 * reader is sitting, so the create form can guess an offset and the ballot can
 * tell a voter how far from the grid they are. That is the whole list, and it
 * is the line that keeps a voter's zone out of a grid built to exclude it.
 */

/** Minutes as an offset: 870 to `+14:30`, -420 to `-07:00`. */
function toOffset(minutes: number): string {
  return `${minutes < 0 ? '-' : '+'}${toTimeOfDay(Math.abs(minutes))}`
}

/** An offset back to minutes: `-07:00` to -420. Null if it is not one. */
export function offsetMinutes(offset: string): number | null {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset)
  if (!match) return null
  const size = Number(match[2]) * 60 + Number(match[3])
  return match[1] === '-' ? -size : size
}

/**
 * The offset this browser is in right now, as a last-resort default.
 *
 * `getTimezoneOffset` is minutes *behind* UTC, so its sign is the opposite of
 * every other offset in the world; the negation is the whole reason this is a
 * function with a comment rather than an expression inline. Rounded onto the
 * quarter-hour grid the list is built on, so a zone the list cannot express
 * lands on its nearest neighbour rather than on nothing.
 */
export function browserOffset(): string {
  const behind = new Date().getTimezoneOffset()
  const minutes = Math.round(-behind / 15) * 15
  const clamped = Math.max(-12 * 60, Math.min(14 * 60, minutes))
  return toOffset(clamped)
}

/**
 * What a named zone's offset actually is on one particular day: `-06:00` for
 * `America/Denver` in July, `-07:00` for the same place in December.
 *
 * **This is how a place becomes an offset, and it is the only place the two
 * meet.** A poll is held at a fixed offset -- see PollSchedule.timezone, and
 * the reasons are not cosmetic -- but almost nobody knows theirs, and the ones
 * who think they do are often quoting the half of the year they are not in.
 * So the create form asks for a place and asks this what that place's clock
 * says on the poll's own dates, and stores the answer. From that moment the
 * zone is gone and the number is the poll.
 *
 * Asked about a date rather than about now, which is the point: a poll held in
 * March about a meeting in July has to be built on July's offset, and a
 * browser reading its own clock in March would be an hour out for the whole
 * ballot.
 *
 * Null when the runtime does not know the zone. Every browser this app
 * supports does, and a caller that has an offset already never asks.
 */
export function zoneOffsetOn(timeZone: string, day: ScheduleDay): string | null {
  const noon = Date.parse(`${day}T12:00:00Z`)
  if (Number.isNaN(noon)) return null

  // Twice, and the second pass is the point. What is wanted is the offset in
  // force at *local* noon on that date; what the first pass measures is the
  // offset at noon UTC, which in Auckland is one in the morning the following
  // day. Shifting the instant by the first answer lands on local noon, and
  // asking again there settles it -- clocks change in the small hours, so noon
  // is never the ambiguous side of a transition. One correction is enough
  // because no zone is more than a day from UTC.
  const guess = offsetAt(timeZone, noon)
  if (guess === null) return null
  const minutes = offsetMinutes(guess)
  if (minutes === null) return guess
  return offsetAt(timeZone, noon - minutes * 60_000) ?? guess
}

/** The offset a zone is on at one instant, as `-06:00`. */
function offsetAt(timeZone: string, instant: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date(instant))
    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
    // `GMT-06:00`, and plain `GMT` at exactly zero on the runtimes that spell
    // it that way -- which the pattern below would otherwise miss.
    if (name === 'GMT') return '+00:00'
    const match = /GMT([+-]\d{2}:\d{2})$/.exec(name)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * An offset as a person reads it: `UTC-07:00 · Pacific Time`, or plain
 * `UTC-07:00` where there is nothing to add.
 *
 * **The offset leads and the name follows.** The offset is what the poll *is*
 * and the name is a caption on it -- one that cannot be exact, because several
 * zones sit on one offset and which of them is the recognisable one depends on
 * the time of year. Putting the number first says which way round that is: a
 * reader who does not recognise `Pacific Time` has still been told the poll's
 * offset, and one who does not know their offset has been given something to
 * recognise.
 *
 * Pure of the zone list on purpose. This is the formatter every screen uses,
 * the ballot included, and the ballot has no business loading a table of zones
 * to draw a line of text -- the name it prints was worked out once, by the
 * creator's browser, and stored beside the offset it describes.
 */
export function describeOffset(offset: string, label?: string | null): string {
  const named = label?.trim()
  return named ? `UTC${offset} · ${named}` : `UTC${offset}`
}

/**
 * How far the poll's offset is from the clock on the wall behind whoever is
 * reading -- `3 hours behind you`, `half an hour ahead of you`, or nothing at
 * all when the two agree.
 *
 * The one genuinely useful thing a voter's own zone can be used for on this
 * screen, and the reason it is safe: it is a sentence *about* the difference
 * rather than a conversion of the grid. Nothing on the calendar moves. A voter
 * in Berlin still paints the same cells with the same labels as a voter in
 * Denver -- they are just told, in words, that 2pm on it is 10pm to them.
 *
 * Null when the browser is in the poll's own offset today, which is the
 * common case and wants no sentence at all. Also null when the browser is in
 * a zone that changes between now and the poll, in which case the honest
 * answer would need a date this function has not been given -- and a slightly
 * stale hint is worse than no hint, so it says nothing.
 */
export function offsetFromViewer(schedule: PollSchedule, on?: ScheduleDay): string | null {
  const poll = offsetMinutes(schedule.timezone)
  if (poll === null) return null

  // The reader's own zone on the poll's first day where one was given, so a
  // hint about a July meeting is not computed from a January clock.
  const here = on
    ? offsetMinutes(zoneOffsetOn(viewerZone(), on) ?? '')
    : -new Date().getTimezoneOffset()
  if (here === null) return null

  const gap = poll - here
  if (gap === 0) return null

  const size = Math.abs(gap)
  const hours = Math.floor(size / 60)
  const minutes = size % 60
  const parts: string[] = []
  if (hours > 0) parts.push(hours === 1 ? '1 hour' : `${hours} hours`)
  if (minutes > 0) parts.push(`${minutes} minutes`)
  return `${parts.join(' ')} ${gap > 0 ? 'ahead of' : 'behind'} your clock`
}

/** The zone this browser believes it is in, or `UTC` if it will not say. */
export function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * The hours a new poll fills a day with, and the hours the create form's two
 * selects open on. A working day, because most meetings are in one.
 *
 * Not stored and not part of a schedule: it is the default a whole-day fill
 * lays down, and what a poll is asking about is what was painted. See
 * `ScheduleFields`.
 */
export const DEFAULT_HOURS: DailyWindow = { start: '09:00', end: '17:00' }

/**
 * The schedule a new time poll starts with: an hour-long meeting, in this
 * browser's offset.
 *
 * `window` is the grid's axis and is worked out from the painting on the way
 * out (`spanOf`), so what it holds until then is only what an unpainted form
 * would be drawn on -- which is nothing, since the calendar appears with the
 * first day picked.
 */
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
 * An option's name, as a person reads it: `14:00, Tue Sep 1`.
 *
 * **It decides from the name alone, and takes no schedule.** That is the whole
 * point of it: formatting a time is presentation, and presentation is the
 * browser's job. Nothing above has to be told which kind of poll it is reading
 * or hand a schedule down to reach it -- which is what keeps `list_polls` and
 * every card that draws a winner out of this feature entirely.
 *
 * What it recognises is the exact shape `enumerateWindows` produces: a full
 * ISO 8601 instant with a numeric offset. Anything else is returned untouched,
 * so an ordinary poll's options pass straight through. An option poll whose
 * option is *literally* named `2026-09-01T14:00:00-07:00` would be reformatted
 * too -- which is a poll nobody is going to write, and which would still be
 * shown the same instant, more legibly.
 *
 * **The time leads and the date follows**, which is the order the answer is
 * spoken in -- "seven on Friday the twentieth" -- and the order that puts the
 * part that differs between two adjacent options first. Within the date the
 * month leads the day, for the same reason it does in speech.
 *
 * **A window starting at midnight is shown as a day and no time**, which is
 * the one concession to not having the schedule: a poll whose meeting is a day
 * or longer is answered in whole days and every one of its options starts at
 * 00:00, so `00:00, Mon Sep 7` would be sixty rows each carrying the same four
 * useless digits. It costs a half-hour poll whose first window happens to
 * start at midnight the word `00:00` -- still the right day, and a poll nobody
 * has yet made.
 *
 * Formatted by hand rather than through `Intl.DateTimeFormat`, because every
 * formatter that takes a `Date` also takes the reader's own timezone with it,
 * and a poll is held in one offset that everybody sees the same. Building a
 * `Date` here to format it would put the reader's zone back into a grid built
 * specifically to keep it out -- a 14:00 Denver poll would read as 22:00 to a
 * voter in Berlin on the results page while their ballot said 14:00.
 *
 * The weekday is worked out from the date arithmetically, in UTC, which is
 * safe for the same reason: the parts are treated as wall clock and never as
 * an instant.
 *
 * The window's *end* is deliberately not here. It would need the schedule
 * back, and every window in a poll is the same length -- sixty rows each
 * saying "- 17:00" three hours after their own start is noise, and the length
 * is one fact about the poll rather than one fact per option.
 */
export function formatWindow(name: string): string {
  const parsed = parseWindowStart(name)
  // A name that is not a window is shown as it is. Better a stray label on a
  // results page than a crash on one.
  if (!parsed) return name

  const at = toMinutes(parsed.timeOfDay)
  return at === 0 ? formatDay(parsed.day) : `${parsed.timeOfDay}, ${formatDay(parsed.day)}`
}

/** The day part alone, for a column heading over a grid: `Fri Feb 20`. */
export function formatDay(day: ScheduleDay): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay()]
  return `${weekday} ${MONTHS[month - 1]} ${dayOfMonth}`
}
/**
 * The painting as one event per run of neighbouring cells sharing a value, for
 * the two views that have hours in them.
 *
 * Merged rather than one event per cell, because a week of half-hours is three
 * hundred cells and a run of them is one block to look at. A 0 draws nothing
 * at all -- an unpainted cell already means the same thing, so a grey block
 * over the whole calendar would be an answer nobody gave.
 *
 * `background` in the grids, where it is a wash behind the hours; the month
 * view asks for `default`, which is the ordinary chip Mantine draws in a day
 * cell, one per block. See `runsOf` for what a caller does with these.
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
 * A run of cells, as the grid wants it: `YYYY-MM-DD HH:mm:ss` at both ends.
 *
 * A run reaching the end of its day ends a second before the next one starts,
 * because `24:00:00` is not a time of day the library can parse -- which is
 * also every run on a poll answered in whole days, where a cell *is* a day.
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

// ---------------------------------------------------------------------------
// Reading a time poll's results
// ---------------------------------------------------------------------------

/**
 * The results view is reused exactly as it stands -- no calendar heat map, no
 * second layout. An option's name *is* its identity, and the existing page
 * already ranks options by score, which is a legible answer to "when should we
 * meet". The only thing wrong with it on a time poll is that the names are ISO
 * timestamps.
 *
 * So they are rewritten once, here, on the payload -- rather than threading a
 * formatter down through the score rows, the tie-break prose, `NameList`, the
 * head-to-head matchups, the full ranking's places and the published sheet's
 * column headings. Every one of those renders `name` and every one of them
 * stays untouched: what changes is what `name` says by the time it arrives.
 *
 * None of these take a schedule, and none of their callers has to know which
 * kind of poll they are drawing: `formatWindow` decides from the name alone,
 * and an ordinary poll's options are not window starts, so they pass straight
 * through. Applied unconditionally for that reason.
 */
export function relabelResults<
  T extends {
    options: { name: string }[]
    tiebreaks: {
      tied: { name: string }[]
      advanced: { name: string }[]
      steps: ({ results: { name: string }[] } & {
        matchups?: { a_name: string; b_name: string }[]
      })[]
    }[]
  },
>(results: T): T {
  const label = formatWindow
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

/** The same, for the full ranking: a list of places, each with its own tally. */
export function relabelRanking<
  T extends {
    options: { name: string }[]
    tiebreaks: {
      tied: { name: string }[]
      advanced: { name: string }[]
      steps: ({ results: { name: string }[] } & {
        matchups?: { a_name: string; b_name: string }[]
      })[]
    }[]
  },
>(ranking: T[]): T[] {
  return ranking.map(relabelResults)
}

/** And for the published sheet, whose columns are the options. */
export function relabelSheet<T extends { options: { name: string }[] }>(sheet: T): T {
  return {
    ...sheet,
    options: sheet.options.map((option) => ({ ...option, name: formatWindow(option.name) })),
  }
}

/**
 * A poll's settled winner, as a badge should say it.
 *
 * Three screens draw this badge -- the poll list, the poll's own page and the
 * share-link page -- and on a time poll the name they were handed is an ISO
 * timestamp. `undefined` means "not settled" and `null` means "settled, and
 * nobody won"; both pass through untouched, because both are answers rather
 * than names.
 *
 * The poll list is why this takes no schedule. That screen reads `list_polls`,
 * which would have had to carry two more columns -- a hundred and thirty lines
 * of function restated, since adding a column to a `RETURNS TABLE` is a new
 * return type and cannot be a `CREATE OR REPLACE` -- for the sake of one
 * label. `formatWindow` decides from the name.
 */
export function winnerLabel(name: string | null | undefined): string | null | undefined {
  return name ? formatWindow(name) : name
}
