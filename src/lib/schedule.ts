import type { PollSchedule } from './types'

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
 * So this file is where the feature can actually be wrong, and everything in
 * it is a pure function of its arguments for that reason. No `Date`, no
 * `Intl`, no reading of the clock: a poll is held in one fixed UTC offset that
 * its creator declared, and every calculation below is wall-clock arithmetic
 * in that offset. A voter in Berlin and a voter in Denver are shown the same
 * grid with the same labels, which is the whole of what "one timezone per
 * poll" buys and the reason none of this needs a timezone library.
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
 * Every window the creator is offering, in order: one option per start time.
 *
 * A window is offered when the whole of it fits inside that day's in-bounds
 * hours, so a fourteen-hour day of hourly starts offers a three-hour meeting
 * twelve slots and not fourteen -- the last two would run past the end of the
 * day. Starts step by the granularity, which is also the resolution the ballot
 * paints at, so every window begins on a line the voter can see.
 *
 * Chronological, which is both what a reader expects and what `sort_order`
 * ends up holding, since `create_poll` keeps the order it is given.
 */
export function enumerateWindows(schedule: PollSchedule, days: ScheduleDay[]): WindowStart[] {
  const first = toMinutes(schedule.window.start)
  const last = toMinutes(schedule.window.end)
  const length = meetingMinutes(schedule)
  const starts: WindowStart[] = []

  for (const day of [...days].sort()) {
    for (let at = first; at + length <= last; at += schedule.granularity) {
      starts.push(`${day}T${toTimeOfDay(at)}:00${schedule.timezone}`)
    }
  }
  return starts
}

/**
 * How many options a schedule would produce over some number of days, without
 * building them. The create form asks so it can say "that is 780 windows, and
 * a poll can hold 500" before anybody presses the button.
 */
export function windowsPerDay(schedule: PollSchedule): number {
  const span = toMinutes(schedule.window.end) - toMinutes(schedule.window.start)
  const length = meetingMinutes(schedule)
  if (span < length) return 0
  return Math.floor((span - length) / schedule.granularity) + 1
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

/**
 * The offset this browser is in right now, as the default.
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
  return `${clamped < 0 ? '-' : '+'}${toTimeOfDay(Math.abs(clamped))}`
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
 * An option's name, as a person reads it: `Tue 1 Sep, 2:00 – 5:00pm`.
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
 */
export function formatWindow(name: string, schedule: PollSchedule): string {
  const parsed = parseWindowStart(name)
  // A name that is not a window is shown as it is. Better a stray label on a
  // results page than a crash on one.
  if (!parsed) return name

  const [year, month, day] = parsed.day.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
  const from = toMinutes(parsed.timeOfDay)
  const to = from + meetingMinutes(schedule)

  return `${weekday} ${day} ${MONTHS[month - 1]}, ${clock(from)} – ${clock(to)}`
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
 * A poll that is not a time poll passes through unrelabelled, because there is
 * no schedule to hand these.
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
>(results: T, schedule: PollSchedule): T {
  const label = (name: string) => formatWindow(name, schedule)
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
>(ranking: T[], schedule: PollSchedule): T[] {
  return ranking.map((place) => relabelResults(place, schedule))
}

/** And for the published sheet, whose columns are the options. */
export function relabelSheet<T extends { options: { name: string }[] }>(
  sheet: T,
  schedule: PollSchedule,
): T {
  return {
    ...sheet,
    options: sheet.options.map((option) => ({
      ...option,
      name: formatWindow(option.name, schedule),
    })),
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
 */
export function winnerLabel(
  name: string | null | undefined,
  schedule: PollSchedule | null | undefined,
): string | null | undefined {
  if (!name || !schedule) return name
  return formatWindow(name, schedule)
}
