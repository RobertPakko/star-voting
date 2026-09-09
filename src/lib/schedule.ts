import type { DailyWindow, PollSchedule } from './types'

/**
 * The one piece of real logic a time poll has: turning a schedule into
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
 *
 * The duration of a meeting is not stored and not in any name: it is
 * `desired_slots * granularity`, and every window is that long.
 */

/** `2026-09-01T14:00:00-07:00` -- an option's name on a time poll. */
export type WindowStart = string

/** `2026-09-01 14:00` -- one cell of the grid, in the poll's own offset. */
export type GranuleKey = string

/** `2026-09-01` -- a day the poll is asking about. */
export type ScheduleDay = string

/** How long a meeting is, in minutes. Not stored: every window is this long. */
export function meetingMinutes(schedule: PollSchedule): number {
  return schedule.desired_slots * schedule.granularity
}

/** `14:30` to 870. The one direction; `toTimeOfDay` is the other. */
export function toMinutes(timeOfDay: string): number {
  const [hours, minutes] = timeOfDay.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/**
 * 870 to `14:30`. Never asked for more than 1440, because a window is
 * required to fit inside one day's in-bounds hours -- see `enumerateWindows`.
 */
export function toTimeOfDay(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * The hours one day is asking about.
 *
 * `window` is both the default and the axis -- see PollSchedule -- so a day
 * nobody said anything special about gets the poll's own hours, and a day that
 * was singled out gets its own. Every question below that involves a day at
 * all goes through here rather than reading `schedule.window`, which is what
 * makes "Friday evenings, Saturday from nine" one rule rather than a special
 * case threaded through six functions.
 */
export function windowOn(schedule: PollSchedule, day: ScheduleDay): DailyWindow {
  return schedule.day_windows?.[day] ?? schedule.window
}

/**
 * Every window the creator is offering, in order: one option per start time.
 *
 * A window is offered when the whole of it fits inside that day's in-bounds
 * hours, so a fourteen-hour day of hourly starts offers a three-hour meeting
 * twelve slots and not fourteen -- the last two would run past the end of the
 * day. Starts step by the granularity, which is also the resolution the ballot
 * paints at, so every window begins on a line the voter can see.
 *
 * **Each day is measured against its own hours.** A Friday that runs 6pm-10pm
 * and a Saturday that runs 9am-10pm are two different counts from one
 * schedule, and a day too short to hold the meeting contributes nothing rather
 * than contributing something that does not fit.
 *
 * Chronological, which is both what a reader expects and what `sort_order`
 * ends up holding, since `create_poll` keeps the order it is given.
 */
export function enumerateWindows(schedule: PollSchedule, days: ScheduleDay[]): WindowStart[] {
  const length = meetingMinutes(schedule)
  const starts: WindowStart[] = []

  for (const day of [...days].sort()) {
    const hours = windowOn(schedule, day)
    const first = toMinutes(hours.start)
    const last = toMinutes(hours.end)
    for (let at = first; at + length <= last; at += schedule.granularity) {
      starts.push(`${day}T${toTimeOfDay(at)}:00${schedule.timezone}`)
    }
  }
  return starts
}

/**
 * How many options one day would produce, without building them.
 *
 * Per day rather than per poll now that two days need not be the same length:
 * the create form adds these up to say "that is 780 windows, and a poll can
 * hold 500" before anybody presses the button, and reads them one at a time to
 * say which day is the one too short to hold the meeting.
 */
export function windowsOn(schedule: PollSchedule, day: ScheduleDay): number {
  const hours = windowOn(schedule, day)
  const span = toMinutes(hours.end) - toMinutes(hours.start)
  const length = meetingMinutes(schedule)
  if (span < length) return 0
  return Math.floor((span - length) / schedule.granularity) + 1
}

/** The size of the whole ballot: every day's windows, added up. */
export function countWindows(schedule: PollSchedule, days: ScheduleDay[]): number {
  return days.reduce((total, day) => total + windowsOn(schedule, day), 0)
}

/**
 * The hours the grid has to be tall enough to draw: the union of every day's.
 *
 * This is what `window` is set to when a poll is created, and it is why
 * `window` is stored at all. A poll whose Friday starts at 6pm and whose
 * Saturday starts at 9am is drawn on one axis running 9am to 10pm, with
 * Friday morning greyed out -- rather than on two grids, or on one that clips
 * whichever day it was not built for.
 *
 * With no days at all there is nothing to take a union of, so the poll's own
 * hours stand. The create form is in that state until somebody picks a date.
 */
export function spanOf(schedule: PollSchedule, days: ScheduleDay[]): DailyWindow {
  let first: number | null = null
  let last: number | null = null

  for (const day of days) {
    const hours = windowOn(schedule, day)
    const from = toMinutes(hours.start)
    const to = toMinutes(hours.end)
    if (first === null || from < first) first = from
    if (last === null || to > last) last = to
  }

  if (first === null || last === null) return schedule.window
  return { start: toTimeOfDay(first), end: toTimeOfDay(last) }
}

/**
 * Every cell of the grid a voter may paint on one day, in order.
 *
 * A cell counts as in bounds when the whole of it is: a day ending at 10pm
 * with half-hour granules ends on the 9:30 cell, and the 10:00 cell belongs to
 * a day that is over. What the ballot uses this for is two things -- greying
 * out what cannot be painted, and filling a whole day in one gesture.
 */
export function granulesInBounds(schedule: PollSchedule, day: ScheduleDay): GranuleKey[] {
  const hours = windowOn(schedule, day)
  const last = toMinutes(hours.end)
  const keys: GranuleKey[] = []
  for (
    let at = toMinutes(hours.start);
    at + schedule.granularity <= last;
    at += schedule.granularity
  ) {
    keys.push(`${day} ${toTimeOfDay(at)}`)
  }
  return keys
}

/**
 * Whether one cell of the grid is a cell this poll is asking about.
 *
 * Two ways to fail, and the ballot draws them the same way because they mean
 * the same thing: the day is not one of the poll's days at all, or the day is
 * but the hour is outside that day's own hours. Painting outside either would
 * be ignored by `scoresFromPainting` -- no window covers it -- so it is
 * refused at the gesture rather than swallowed after it.
 */
export function paintable(
  schedule: PollSchedule,
  inBounds: ReadonlySet<ScheduleDay>,
  day: ScheduleDay,
  timeOfDay: string,
): boolean {
  if (!inBounds.has(day)) return false
  const hours = windowOn(schedule, day)
  const at = toMinutes(timeOfDay)
  return at >= toMinutes(hours.start) && at + schedule.granularity <= toMinutes(hours.end)
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

/** The days a poll is asking about: exactly the days its options start on. */
export function daysOf(windowStarts: WindowStart[]): ScheduleDay[] {
  const days = new Set<ScheduleDay>()
  for (const start of windowStarts) {
    const parsed = parseWindowStart(start)
    if (parsed) days.add(parsed.day)
  }
  return [...days].sort()
}

/**
 * The grid cells one window covers: `desired_slots` of them, starting at its
 * own start.
 *
 * A window never crosses midnight -- `enumerateWindows` only offers one that
 * fits inside a day -- so this is arithmetic on one date and needs no calendar.
 */
export function granulesOf(start: WindowStart, schedule: PollSchedule): GranuleKey[] {
  const parsed = parseWindowStart(start)
  if (!parsed) return []

  const from = toMinutes(parsed.timeOfDay)
  const keys: GranuleKey[] = []
  for (let i = 0; i < schedule.desired_slots; i++) {
    keys.push(`${parsed.day} ${toTimeOfDay(from + i * schedule.granularity)}`)
  }
  return keys
}

/**
 * A painted calendar, flattened into the score per window that gets sent.
 *
 * **A window's rating is the lowest rating among the granules it covers**, and
 * the choice of minimum over mean is the load-bearing one. With a mean, a
 * three-hour window containing one hour the voter flatly cannot attend still
 * scores 3.3 and can win the poll. With a minimum, any window touching a 0 is
 * a 0 -- which is exactly what "I can't be there" has to mean, since a meeting
 * is not partly attendable.
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
    let lowest = 5
    for (const key of granulesOf(start, schedule)) {
      lowest = Math.min(lowest, painting[key] ?? 0)
      if (lowest === 0) break
    }
    scores[start] = lowest
  }
  return scores
}

/**
 * A ballot read back, repainted onto the calendar.
 *
 * The inverse of the rule above, as far as there is one: a granule's rating is
 * the **highest** score among the windows covering it, since a window's score
 * was the lowest among its granules. Take the maximum and every granule the
 * voter marked comes back marked; take anything less and a voter opening
 * "change my vote" finds their availability quietly shrunk.
 *
 * **It is lossy, and knowingly so.** The minimum threw information away, and
 * no inverse can put it back: a voter who marked 09:00 as 5 and 10:00 as 2 on
 * a two-hour meeting sent one window scored 2, and reading that back paints
 * both hours 2. What survives is the shape of their availability, which is
 * what they will be looking at; what is lost is the difference between "this
 * hour is merely fine" and "the hour beside it is bad". Saving an unedited
 * ballot back is therefore not a no-op -- it can lower a rating. That is the
 * accepted trade for storing windows rather than granules, which is what lets
 * a time poll be an ordinary poll everywhere else in the app.
 */
export function paintingFromScores(
  windowStarts: WindowStart[],
  scores: Record<WindowStart, number>,
  schedule: PollSchedule,
): Record<GranuleKey, number> {
  const painting: Record<GranuleKey, number> = {}
  for (const start of windowStarts) {
    const score = scores[start] ?? 0
    if (score === 0) continue
    for (const key of granulesOf(start, schedule)) {
      painting[key] = Math.max(painting[key] ?? 0, score)
    }
  }
  return painting
}

/**
 * Whether a ballot says nothing at all -- every window scored 0.
 *
 * Worth asking on purpose, because it is reachable by a voter who did
 * everything right: mark two separate hours on a poll looking for a
 * three-hour block and every window contains an unmarked granule, so every
 * window is 0 and the ballot contributes nothing to any option. That is the
 * correct answer to "when can you do three hours" and it looks exactly like
 * the app having eaten the vote, so the ballot says so before it is sent
 * rather than after.
 */
export function saysNothing(scores: Record<WindowStart, number>): boolean {
  return Object.values(scores).every((score) => score === 0)
}

// ---------------------------------------------------------------------------
// Offsets, and the only functions here allowed to read a clock
// ---------------------------------------------------------------------------

/**
 * Everything above this line is wall-clock arithmetic in the poll's own offset
 * and touches nothing outside its arguments. Below it sit the offset
 * functions, and four of them -- `browserOffset`, `zoneOffsetOn`,
 * `zoneShiftsWithin`, `viewerZone` -- read `Date` and `Intl`: the reader's own
 * clock and the world's zone database. They are gathered here rather than
 * scattered so that the exception is one place rather than four.
 *
 * **None of their answers reaches a window start, a granule key or a score.**
 * Two run once, in the create form, to turn "Denver" into the fixed offset the
 * poll is then held at for good; one warns that a poll straddles a clock
 * change; one names the zone the reader is sitting in so they can be told how
 * far from the grid they are. That is the whole list, and it is the line that
 * keeps a voter's zone out of a grid built to exclude it.
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
 * The days in a poll on which a named zone's clocks are not what they are on
 * the first day of it -- the poll that spans a daylight-saving change.
 *
 * A poll is one offset throughout, so this cannot be fixed; it can only be
 * said. A creator picking "London" for a meeting the week the clocks go back
 * is told that half their grid will read an hour off the wall, and can move
 * the poll or accept it. Empty is the ordinary answer and the quiet one.
 */
export function zoneShiftsWithin(timeZone: string, days: ScheduleDay[]): ScheduleDay[] {
  const sorted = [...days].sort()
  if (sorted.length === 0) return []
  const held = zoneOffsetOn(timeZone, sorted[0])
  if (held === null) return []
  return sorted.filter((day) => zoneOffsetOn(timeZone, day) !== held)
}

/**
 * An offset as a sentence, for whoever is looking at the grid: `Mountain Time
 * (Denver) -- UTC-06:00`, or just `UTC-06:00` on a poll whose creator picked a
 * bare offset.
 *
 * The offset is always in it. A label is what the creator meant and the offset
 * is what the poll *is*, and a reader who is shown only the first has been
 * handed the ambiguity that storing an offset was meant to remove.
 */
export function describeOffset(schedule: PollSchedule): string {
  const offset = `UTC${schedule.timezone}`
  const label = schedule.timezone_label?.trim()
  return label ? `${label} — ${offset}` : offset
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

/** The schedule a new time poll starts with: a working day, in this browser's offset. */
export function blankSchedule(): PollSchedule {
  return {
    timezone: browserOffset(),
    window: { start: '09:00', end: '17:00' },
    desired_slots: 2,
    granularity: 30,
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * An option's name, as a person reads it: `Tue 1 Sep, 2:00pm`.
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
 * Formatted by hand rather than through `Intl.DateTimeFormat`, because every
 * formatter that takes a `Date` also takes the reader's own timezone with it,
 * and a poll is held in one offset that everybody sees the same. Building a
 * `Date` here to format it would put the reader's zone back into a grid built
 * specifically to keep it out -- a 2pm Denver poll would read as 10pm to a
 * voter in Berlin on the results page while their ballot said 2pm.
 *
 * The weekday is worked out from the date arithmetically, in UTC, which is
 * safe for the same reason: the parts are treated as wall clock and never as
 * an instant.
 *
 * The window's *end* is deliberately not here. It would need the schedule
 * back, and every window in a poll is the same length -- sixty rows each
 * saying "– 5:00pm" three hours after their own start is noise, and the length
 * is one fact about the poll rather than one fact per option.
 */
export function formatWindow(name: string): string {
  const parsed = parseWindowStart(name)
  // A name that is not a window is shown as it is. Better a stray label on a
  // results page than a crash on one.
  if (!parsed) return name

  const [year, month, day] = parsed.day.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]

  return `${weekday} ${day} ${MONTHS[month - 1]}, ${clock(toMinutes(parsed.timeOfDay))}`
}

/** The day part alone, for a column heading over a grid. */
export function formatDay(day: ScheduleDay): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay()]
  return `${weekday} ${dayOfMonth} ${MONTHS[month - 1]}`
}

/**
 * Minutes since midnight as a twelve-hour clock: `9:30am`, `2:00pm`, `12:00am`.
 * 1440 is midnight at the end of the day, which is where a window running to
 * the end of a day that goes to `24:00` finishes.
 */
export function clock(minutes: number): string {
  const hours24 = Math.floor(minutes / 60) % 24
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12
  const suffix = hours24 < 12 ? 'am' : 'pm'
  return `${hours12}:${String(minutes % 60).padStart(2, '0')}${suffix}`
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
