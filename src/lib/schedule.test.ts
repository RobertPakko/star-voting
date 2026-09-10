import { describe, expect, test } from 'vitest'
import {
  boundsOf,
  boundsOnDay,
  carryForward,
  countWindows,
  DAY_MINUTES,
  daysOf,
  describeLength,
  describeOffset,
  enumerateWindows,
  formatDay,
  formatWindow,
  granularityFor,
  granuleKey,
  granulesOf,
  isDaily,
  MEETING_LENGTHS,
  offsetMinutes,
  paintingFromScores,
  saysNothing,
  scoresFromPainting,
  spanningLength,
  spanOf,
  stepGranule,
  toTimeOfDay,
  winnerLabel,
  zoneOffsetOn,
  type Bounds,
  type GranuleKey,
} from './schedule'
import { MAX_OPTIONS } from './limits'
import type { PollSchedule } from './types'

/**
 * The derivation, and only the derivation.
 *
 * These are the two functions the whole feature rests on: a time poll is an
 * ordinary poll everywhere in the database, so if the enumeration or the
 * minimum rule is wrong there is nothing downstream that would notice. The
 * tally would run happily over the wrong sixty options and elect one of them.
 *
 * The SQL suite (`npm test`) cannot reach any of this -- it is browser logic,
 * by design -- so it is checked here, with `npm run test:unit`. Kept to the
 * pure functions on purpose: this is not a foothold for testing components.
 */

/** The worked example: a three-hour meeting, 08:00-22:00, at half-hours. */
const threeHours: PollSchedule = {
  timezone: '-07:00',
  window: { start: '08:00', end: '22:00' },
  desired_slots: 6,
  granularity: 30,
}

/** Ninety minutes at the same resolution, which is the awkward one. */
const ninetyMinutes: PollSchedule = {
  timezone: '+01:00',
  window: { start: '09:00', end: '12:00' },
  desired_slots: 3,
  granularity: 30,
}

/** A three-day retreat: a granule is a day, and a window is three of them. */
const retreat: PollSchedule = {
  timezone: '-07:00',
  window: { start: '00:00', end: '24:00' },
  desired_slots: 3,
  granularity: DAY_MINUTES,
}

/**
 * What a creator painting a stretch of each day leaves behind, which is the
 * only kind of bounds most polls have. Everything below is written in terms of
 * this rather than of a schedule, because a schedule no longer says which days
 * or hours a poll is asking about -- the painting does, and the options are
 * the painting.
 */
function painted(days: string[], from: string, to: string, granularity = 30): Set<GranuleKey> {
  const cells = new Set<GranuleKey>()
  const [fromH, fromM] = from.split(':').map(Number)
  const [toH, toM] = to.split(':').map(Number)
  for (const day of days) {
    for (let at = fromH * 60 + fromM; at + granularity <= toH * 60 + toM; at += granularity) {
      cells.add(granuleKey(day, at))
    }
  }
  return cells
}

/** And whole days, for a poll answered in them. */
function wholeDays(days: string[]): Set<GranuleKey> {
  return new Set(days.map((day) => granuleKey(day, 0)))
}

describe('enumerating the windows', () => {
  test('offers only windows whose every cell was painted', () => {
    const starts = enumerateWindows(threeHours, painted(['2026-09-01'], '08:00', '22:00'))
    // Fourteen hours painted, three-hour meeting, half-hour starts: the last
    // one that fits begins at 19:00 and ends at 22:00.
    expect(starts).toHaveLength(23)
    expect(starts[0]).toBe('2026-09-01T08:00:00-07:00')
    expect(starts[22]).toBe('2026-09-01T19:00:00-07:00')
  })

  test('a gap in the painting is a gap in the options', () => {
    // A morning and an afternoon with lunch left out offers no window that
    // spans lunch, which is exactly what the creator said. This is the whole
    // of what the per-day hour rows could not express.
    const bounds = new Set([
      ...painted(['2026-09-01'], '09:00', '12:00'),
      ...painted(['2026-09-01'], '13:00', '17:00'),
    ])
    const starts = enumerateWindows(threeHours, bounds).map((s) => s.slice(11, 16))
    expect(starts).toEqual(['09:00', '13:00', '13:30', '14:00'])
  })

  test('counts the same windows without the caller building them', () => {
    expect(countWindows(threeHours, painted(['2026-09-01'], '08:00', '22:00'))).toBe(23)
    expect(countWindows(ninetyMinutes, painted(['2026-09-01'], '09:00', '12:00'))).toBe(4)
    // A meeting longer than anything painted is offered nowhere, rather than
    // once.
    expect(countWindows(threeHours, painted(['2026-09-01'], '09:00', '10:00'))).toBe(0)
    expect(countWindows(threeHours, painted(['2026-09-01', '2026-09-02'], '08:00', '22:00'))).toBe(
      46,
    )
  })

  test('steps by the granularity, not by the hour', () => {
    const starts = enumerateWindows(ninetyMinutes, painted(['2026-09-01'], '09:00', '12:00'))
    expect(starts.map((s) => s.slice(11, 16))).toEqual(['09:00', '09:30', '10:00', '10:30'])
  })

  test('names carry the poll offset, and sort chronologically as text', () => {
    const starts = enumerateWindows(
      threeHours,
      painted(['2026-09-03', '2026-09-01'], '08:00', '22:00'),
    )
    expect(starts).toHaveLength(46)
    expect(starts.every((s) => s.endsWith('-07:00'))).toBe(true)
    expect([...starts].sort()).toEqual(starts)
    // Which is also what makes them unique within a poll, and so acceptable
    // to insert_option's case-insensitive duplicate check.
    expect(new Set(starts).size).toBe(starts.length)
  })

  test('a window running to the end of a day that ends at midnight', () => {
    const bounds = painted(['2026-09-01'], '21:00', '24:00')
    const starts = enumerateWindows(threeHours, bounds)
    expect(starts).toEqual(['2026-09-01T21:00:00-07:00'])
    expect(granulesOf(starts[0], threeHours)).toEqual([
      '2026-09-01 21:00',
      '2026-09-01 21:30',
      '2026-09-01 22:00',
      '2026-09-01 22:30',
      '2026-09-01 23:00',
      '2026-09-01 23:30',
    ])
  })

  test('a fortnight of half-hour starts fits under the cap', () => {
    // The shape that found the bug this test exists for: an 11-hour day, a
    // one-hour meeting, half-hour steps, ten days -- 210 windows. The database
    // has taken 500 since 0055; `MAX_OPTIONS` said 50 for a while longer, so
    // the form refused a calendar the server would have stored. See
    // limits.test.ts, which is what stops the two drifting again.
    const hour: PollSchedule = { ...threeHours, desired_slots: 2 }
    const days = Array.from({ length: 10 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
    const bounds = painted(days, '08:00', '19:00')
    expect(countWindows(hour, painted(['2026-09-01'], '08:00', '19:00'))).toBe(21)
    const starts = enumerateWindows(hour, bounds)
    expect(starts).toHaveLength(210)
    expect(starts.length).toBeLessThanOrEqual(MAX_OPTIONS)
  })
})

describe('a meeting longer than a day', () => {
  test('a granule is a day, and a window is a run of them', () => {
    expect(isDaily(retreat)).toBe(true)
    expect(isDaily(threeHours)).toBe(false)
    // Five days marked, a three-day retreat: three runs of three fit.
    const starts = enumerateWindows(
      retreat,
      wholeDays(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']),
    )
    expect(starts).toEqual([
      '2026-09-01T00:00:00-07:00',
      '2026-09-02T00:00:00-07:00',
      '2026-09-03T00:00:00-07:00',
    ])
  })

  test('a run with a day missing from it offers nothing across the gap', () => {
    const starts = enumerateWindows(
      retreat,
      wholeDays(['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-05', '2026-09-06']),
    )
    expect(starts).toEqual(['2026-09-04T00:00:00-07:00'])
  })

  test('the cells a window covers cross the dates it spans', () => {
    expect(granulesOf('2026-09-30T00:00:00-07:00', retreat)).toEqual([
      '2026-09-30 00:00',
      '2026-10-01 00:00',
      '2026-10-02 00:00',
    ])
  })

  test('stepping carries into the next day, and only when it has to', () => {
    expect(stepGranule('2026-09-01 22:30', 30)).toBe('2026-09-01 23:00')
    expect(stepGranule('2026-09-01 23:30', 30)).toBe('2026-09-02 00:00')
    expect(stepGranule('2026-09-01 00:00', DAY_MINUTES)).toBe('2026-09-02 00:00')
    expect(stepGranule('2026-12-31 00:00', DAY_MINUTES)).toBe('2027-01-01 00:00')
  })

  test('the grid such a poll is drawn on is the whole of a day', () => {
    const bounds = wholeDays(['2026-09-01', '2026-09-02'])
    expect(spanOf(bounds, retreat)).toEqual({ start: '00:00', end: '24:00' })
  })
})

describe('how long a meeting is, as a person says it', () => {
  test('decimal hours rather than two units', () => {
    expect(describeLength(30)).toBe('30 minutes')
    expect(describeLength(60)).toBe('1 hour')
    expect(describeLength(90)).toBe('1.5 hours')
    expect(describeLength(120)).toBe('2 hours')
    expect(describeLength(630)).toBe('10.5 hours')
  })

  test('and days once it is a day or longer', () => {
    expect(describeLength(DAY_MINUTES)).toBe('1 day')
    expect(describeLength(3 * DAY_MINUTES)).toBe('3 days')
  })

  test('the same length in front of a noun', () => {
    expect(spanningLength(30)).toBe('30-minute')
    expect(spanningLength(90)).toBe('1.5-hour')
    expect(spanningLength(2 * DAY_MINUTES)).toBe('2-day')
  })

  test('the resolution follows the length, and is never asked about', () => {
    expect(granularityFor(30)).toBe(30)
    expect(granularityFor(90)).toBe(30)
    expect(granularityFor(DAY_MINUTES - 30)).toBe(30)
    expect(granularityFor(DAY_MINUTES)).toBe(DAY_MINUTES)
    expect(granularityFor(4 * DAY_MINUTES)).toBe(DAY_MINUTES)
  })

  test('every length offered is one its own resolution can express', () => {
    // Which is what keeps the two from disagreeing: there is no row in the
    // list that divides into a fraction of a granule.
    for (const minutes of MEETING_LENGTHS) {
      expect(minutes % granularityFor(minutes)).toBe(0)
    }
    expect(MEETING_LENGTHS[0]).toBe(30)
    expect(MEETING_LENGTHS).toContain(DAY_MINUTES)
  })
})

describe('a window is scored by its worst half hour', () => {
  const day = '2026-09-01'
  const starts = enumerateWindows(threeHours, painted([day], '08:00', '22:00'))

  test('the whole point: one bad hour makes the window unavailable', () => {
    // Free all afternoon, except that 16:00 is impossible.
    const painting: Record<string, number> = {}
    for (const key of painted([day], '13:00', '20:00')) painting[key] = 5
    painting[`${day} 16:00`] = 0

    const scores = scoresFromPainting(starts, painting, threeHours)

    // Every window covering 16:00 is out, whatever else it covers -- a mean
    // would have scored the 14:00 window 3.3 and let it win.
    expect(scores[`${day}T14:00:00-07:00`]).toBe(0)
    expect(scores[`${day}T15:00:00-07:00`]).toBe(0)
    expect(scores[`${day}T16:00:00-07:00`]).toBe(0)
    // And the ones either side of it are untouched.
    expect(scores[`${day}T13:00:00-07:00`]).toBe(5)
    expect(scores[`${day}T16:30:00-07:00`]).toBe(5)
  })

  test('a lukewarm half hour drags its windows down to itself', () => {
    const painting: Record<string, number> = {}
    for (const key of painted([day], '09:00', '12:00')) painting[key] = 5
    painting[`${day} 10:00`] = 2
    const scores = scoresFromPainting(starts, painting, threeHours)
    expect(scores[`${day}T09:00:00-07:00`]).toBe(2)
  })

  test('an unpainted cell is a 0, which is a real answer', () => {
    const scores = scoresFromPainting(starts, {}, threeHours)
    expect(Object.values(scores).every((score) => score === 0)).toBe(true)
    expect(saysNothing(scores)).toBe(true)
  })

  test('two free hours are not a three-hour block, and the ballot says so', () => {
    // The case that looks like the app ate the vote: everything the voter
    // marked is real, and none of it is long enough for the meeting.
    const painting: Record<string, number> = {}
    for (const key of painted([day], '09:00', '10:00')) painting[key] = 5
    for (const key of painted([day], '14:00', '15:00')) painting[key] = 5
    expect(saysNothing(scoresFromPainting(starts, painting, threeHours))).toBe(true)
  })

  test('every window gets a score, so no option is left unsent', () => {
    const scores = scoresFromPainting(starts, { [`${day} 09:00`]: 5 }, threeHours)
    expect(Object.keys(scores).sort()).toEqual([...starts].sort())
  })
})

describe('reading a ballot back onto the calendar', () => {
  const day = '2026-09-01'
  const starts = enumerateWindows(threeHours, painted([day], '08:00', '22:00'))

  test('a painting survives the round trip when it is flat', () => {
    const painting: Record<string, number> = {}
    for (const key of painted([day], '13:00', '19:00')) painting[key] = 4

    const scores = scoresFromPainting(starts, painting, threeHours)
    expect(paintingFromScores(starts, scores, threeHours)).toEqual(painting)
  })

  test('and is lossy when it is not, in the direction that keeps availability', () => {
    // A 2 anywhere inside a window sends that window scored 2; the maximum
    // over the windows covering each cell is that same 2, so the 5s are gone.
    // The voter's availability is intact and their enthusiasm is flattened,
    // which is the trade -- see paintingFromScores.
    const painting: Record<string, number> = {}
    for (const key of painted([day], '09:00', '12:00')) painting[key] = 5
    painting[`${day} 10:00`] = 2

    const repainted = paintingFromScores(
      starts,
      scoresFromPainting(starts, painting, threeHours),
      threeHours,
    )
    expect(new Set(Object.values(repainted))).toEqual(new Set([2]))
    expect(Object.keys(repainted).sort()).toEqual([...painted([day], '09:00', '12:00')].sort())
  })

  test('a 0 window paints nothing rather than painting a zero', () => {
    expect(paintingFromScores(starts, {}, threeHours)).toEqual({})
  })

  test('a cell under two windows takes the better of them', () => {
    // 13:00 is inside the 10:30 window and the first cell of the 13:00 one.
    const scores = { [`${day}T10:30:00-07:00`]: 1, [`${day}T13:00:00-07:00`]: 5 }
    expect(paintingFromScores(starts, scores, threeHours)[`${day} 13:00`]).toBe(5)
  })
})

describe('what a poll is asking about, read off its own options', () => {
  const days = ['2026-09-04', '2026-09-05']

  /**
   * The case the whole feature is for: a two-hour thing over a weekend, where
   * Friday is only free in the evening and Saturday is free from breakfast.
   * There is nothing stored that says so -- the options say it.
   */
  const weekend: PollSchedule = {
    timezone: '-07:00',
    window: { start: '09:00', end: '22:00' },
    desired_slots: 4,
    granularity: 30,
  }
  const marked = new Set([
    ...painted(['2026-09-04'], '18:00', '22:00'),
    ...painted(['2026-09-05'], '09:00', '22:00'),
  ])
  const options = enumerateWindows(weekend, marked)

  test('each day is enumerated against what was painted on it', () => {
    const friday = options.filter((s) => s.startsWith('2026-09-04'))
    const saturday = options.filter((s) => s.startsWith('2026-09-05'))

    // Four hours of Friday evening, two-hour meeting, half-hour starts.
    expect(friday.map((s) => s.slice(11, 16))).toEqual([
      '18:00',
      '18:30',
      '19:00',
      '19:30',
      '20:00',
    ])
    expect(saturday).toHaveLength(23)
    expect(saturday[0].slice(11, 16)).toBe('09:00')
    // Still one sorted list, which is what `sort_order` ends up holding.
    expect([...options].sort()).toEqual(options)
  })

  test('the bounds come back off the options, and the days with them', () => {
    const back = boundsOf(options, weekend)
    expect(daysOf(back)).toEqual(days)
    // Every cell a window covers, which is every cell painted except the last
    // granule or two of each stretch -- the ones no window could reach.
    expect(back.has('2026-09-04 18:00')).toBe(true)
    expect(back.has('2026-09-04 21:30')).toBe(true)
    expect(back.has('2026-09-04 17:30')).toBe(false)
    expect(back.has('2026-09-04 10:00')).toBe(false)
    expect(back.has('2026-09-06 10:00')).toBe(false)
  })

  test('and a day too short to hold the meeting is simply not there', () => {
    const short = enumerateWindows(weekend, painted(['2026-09-06'], '09:00', '10:00'))
    expect(short).toEqual([])
    expect(daysOf(boundsOf(short, weekend))).toEqual([])
  })

  test('the axis is the union, which is what the grid has to be tall enough for', () => {
    expect(spanOf(boundsOf(options, weekend), weekend)).toEqual({ start: '09:00', end: '22:00' })
    // Friday alone is four hours of grid, not thirteen.
    const friday = boundsOf(
      options.filter((s) => s.startsWith('2026-09-04')),
      weekend,
    )
    expect(spanOf(friday, weekend)).toEqual({ start: '18:00', end: '22:00' })
    // Nothing painted has no union to take, so a whole day stands.
    expect(spanOf(new Set<GranuleKey>(), weekend)).toEqual({ start: '00:00', end: '24:00' })
  })

  test('filling a whole day fills that day and no more', () => {
    const back: Bounds = boundsOf(options, weekend)
    expect(boundsOnDay(back, '2026-09-04')).toEqual([
      '2026-09-04 18:00',
      '2026-09-04 18:30',
      '2026-09-04 19:00',
      '2026-09-04 19:30',
      '2026-09-04 20:00',
      '2026-09-04 20:30',
      '2026-09-04 21:00',
      '2026-09-04 21:30',
    ])
    expect(boundsOnDay(back, '2026-09-05')).toHaveLength(26)
  })

  test('painting a whole day scores every window on it and nothing else', () => {
    // What the day-fill control does, put through the derivation: every window
    // on Friday takes the brush, and Saturday is untouched.
    const back = boundsOf(options, weekend)
    const painting: Record<string, number> = {}
    for (const key of boundsOnDay(back, '2026-09-04')) painting[key] = 4

    const scores = scoresFromPainting(options, painting, weekend)
    expect(scores['2026-09-04T18:00:00-07:00']).toBe(4)
    expect(scores['2026-09-04T20:00:00-07:00']).toBe(4)
    expect(scores['2026-09-05T09:00:00-07:00']).toBe(0)
    // And it survives being read back, because a flat painting is the one
    // shape the minimum rule loses nothing from.
    expect(paintingFromScores(options, scores, weekend)).toEqual(painting)
  })
})

describe('what a window is called on screen', () => {
  test('reads as a time, in the poll offset and never the reader own', () => {
    expect(formatWindow('2026-09-01T14:00:00-07:00')).toBe('Tue 1 Sep, 14:00')
    // The same instant with a different offset on it is a different wall
    // clock, and this reads the offset the poll declared rather than converting
    // to the reader's -- which is the whole of one-timezone-per-poll.
    expect(formatWindow('2026-09-05T09:30:00+01:00')).toBe('Sat 5 Sep, 09:30')
  })

  test('a window that starts at midnight is a day and no time', () => {
    // Every option of a poll answered in whole days starts at 00:00, and sixty
    // rows carrying the same four useless digits is what this saves.
    expect(formatWindow('2026-09-07T00:00:00-07:00')).toBe('Mon 7 Sep')
  })

  test('and takes no schedule, which is what keeps it out of the database', () => {
    // A name is enough. Nothing above this has to be told which kind of poll
    // it is drawing, so list_polls, poll_status and the three cards that draw
    // a winner all stayed as they were.
    expect(winnerLabel('2026-09-01T14:00:00-07:00')).toBe('Tue 1 Sep, 14:00')
    // null is "settled, and nobody won"; undefined is "not settled". Both are
    // answers rather than names, so neither is formatted.
    expect(winnerLabel(null)).toBeNull()
    expect(winnerLabel(undefined)).toBeUndefined()
  })

  test('every time in the app reads the same way round', () => {
    expect(toTimeOfDay(0)).toBe('00:00')
    expect(toTimeOfDay(12 * 60)).toBe('12:00')
    expect(toTimeOfDay(13 * 60 + 30)).toBe('13:30')
    // Midnight at the end of a day, which '00:00' would read as the start.
    expect(toTimeOfDay(DAY_MINUTES)).toBe('24:00')
  })

  test('a name that is not a window is shown as it is, not as a crash', () => {
    // Which is also what lets this be applied to every poll unconditionally:
    // an ordinary poll's options are not ISO instants, so they pass through.
    expect(formatWindow('Pizza')).toBe('Pizza')
    expect(formatWindow('2026-09-01')).toBe('2026-09-01')
    // No offset on it, so it is not a window start and not this app's to read.
    expect(formatWindow('2026-09-01T14:00:00')).toBe('2026-09-01T14:00:00')
    expect(winnerLabel('Pizza')).toBe('Pizza')
  })
})

describe('a place, resolved into the offset a poll is held at', () => {
  test('reads an offset back as minutes, and refuses anything else', () => {
    expect(offsetMinutes('-07:00')).toBe(-420)
    expect(offsetMinutes('+05:45')).toBe(345)
    expect(offsetMinutes('+00:00')).toBe(0)
    expect(offsetMinutes('America/Denver')).toBeNull()
    expect(offsetMinutes('')).toBeNull()
  })

  test('the same place is two different offsets in two different months', () => {
    // Which is the whole reason the form asks for a place and resolves it on
    // the poll's own dates: a July meeting arranged in January is an hour out
    // if the January answer is the one that gets stored.
    expect(zoneOffsetOn('America/Denver', '2026-07-04')).toBe('-06:00')
    expect(zoneOffsetOn('America/Denver', '2026-01-04')).toBe('-07:00')
    expect(zoneOffsetOn('Europe/London', '2026-07-04')).toBe('+01:00')
    expect(zoneOffsetOn('Europe/London', '2026-01-04')).toBe('+00:00')
  })

  test('including the offsets that are not a whole number of hours', () => {
    expect(zoneOffsetOn('Asia/Kolkata', '2026-07-04')).toBe('+05:30')
    expect(zoneOffsetOn('Asia/Kathmandu', '2026-07-04')).toBe('+05:45')
    // A long way from UTC, where noon UTC is the following day locally --
    // which is what the second pass in `zoneOffsetOn` is for.
    expect(zoneOffsetOn('Pacific/Auckland', '2026-01-15')).toBe('+13:00')
    expect(zoneOffsetOn('Pacific/Auckland', '2026-07-15')).toBe('+12:00')
  })

  test('a zone nobody has heard of is null rather than a throw', () => {
    expect(zoneOffsetOn('Middle/Earth', '2026-07-04')).toBeNull()
  })

  test('a reader is told the offset first and the name second', () => {
    expect(describeOffset('-07:00', 'Mountain Time')).toBe('UTC-07:00 · Mountain Time')
    // The ballot has no zone table to load, so it says the number alone.
    expect(describeOffset('-07:15', null)).toBe('UTC-07:15')
    expect(describeOffset('-07:00')).toBe('UTC-07:00')
    expect(describeOffset('-07:00', '   ')).toBe('UTC-07:00')
  })
})

describe('duplicating a poll onto dates that have not gone', () => {
  /** The weekend poll again: Friday evenings, Saturday from nine. */
  const weekend = new Set([
    ...painted(['2026-09-04'], '18:00', '22:00'),
    ...painted(['2026-09-05'], '09:00', '22:00'),
  ])
  const days = ['2026-09-04', '2026-09-05']

  test('dates still ahead are left exactly where they were', () => {
    // Duplicating a poll you made this morning gives back the days you picked
    // this morning, which is the only answer that is not a surprise.
    const kept = carryForward(weekend, '2026-09-01')
    expect(kept.weeks).toBe(0)
    expect(daysOf(kept.bounds)).toEqual(days)
    expect(kept.bounds).toEqual(weekend)
  })

  test('and the first day being today counts as ahead', () => {
    expect(carryForward(weekend, '2026-09-04').weeks).toBe(0)
  })

  test('dates that have gone move by whole weeks, so the weekdays hold', () => {
    // Five weeks and a bit later: the smallest number of whole weeks that puts
    // the Friday on or after the day the copy is being made.
    const moved = carryForward(weekend, '2026-10-08')
    expect(moved.weeks).toBe(5)
    expect(daysOf(moved.bounds)).toEqual(['2026-10-09', '2026-10-10'])
    // Still a Friday and still a Saturday, which is the whole reason the shift
    // is in weeks: a painting is an answer about days of the week.
    expect(formatDay('2026-10-09').startsWith('Fri')).toBe(true)
    expect(formatDay('2026-10-10').startsWith('Sat')).toBe(true)
  })

  test('and the hours move with the days they were painted on', () => {
    const moved = carryForward(weekend, '2026-10-08')
    expect(boundsOnDay(moved.bounds, '2026-10-09')[0]).toBe('2026-10-09 18:00')
    expect(boundsOnDay(moved.bounds, '2026-10-10')[0]).toBe('2026-10-10 09:00')
    // Which is what makes the copy the same poll: Friday evening is still
    // Friday evening rather than an answer given about the wrong day.
    const weekendSchedule: PollSchedule = { ...threeHours, desired_slots: 4 }
    expect(countWindows(weekendSchedule, moved.bounds)).toBe(countWindows(weekendSchedule, weekend))
  })

  test('a month boundary is a date, not a number of days in September', () => {
    const moved = carryForward(painted(['2026-09-28'], '09:00', '11:00'), '2026-10-08')
    expect(moved.weeks).toBe(2)
    expect(daysOf(moved.bounds)).toEqual(['2026-10-12'])
  })

  test('nothing to move is nothing to move', () => {
    const empty = carryForward(new Set<GranuleKey>(), '2026-10-08')
    expect(empty.weeks).toBe(0)
    expect([...empty.bounds]).toEqual([])
  })

  test('the whole of what a duplicate does, end to end', () => {
    // Exactly the pipeline `CreatePoll`'s prefill runs, minus the setters:
    // options back to cells, cells forward. The offset is the one thing that
    // does not move -- it is what the poll was held at, and a copy is held at
    // the same one.
    const grid: PollSchedule = { ...threeHours, timezone: '-06:00', desired_slots: 4 }
    const options = enumerateWindows(grid, weekend)
    const renewed = carryForward(boundsOf(options, grid), '2026-11-05')

    expect(daysOf(renewed.bounds)).toEqual(['2026-11-06', '2026-11-07'])

    // And the copy is the same poll: the same number of windows, the same
    // Friday evening, at the same offset.
    const copied = enumerateWindows(grid, renewed.bounds)
    expect(copied).toHaveLength(options.length)
    expect(copied[0]).toBe('2026-11-06T18:00:00-06:00')
    expect(copied.every((start) => start.endsWith('-06:00'))).toBe(true)
  })
})
