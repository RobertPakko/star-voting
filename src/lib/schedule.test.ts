import { describe, expect, test } from 'vitest'
import {
  clock,
  countWindows,
  daysOf,
  describeOffset,
  enumerateWindows,
  formatWindow,
  granulesInBounds,
  granulesOf,
  offsetMinutes,
  paintable,
  paintingFromScores,
  saysNothing,
  scoresFromPainting,
  spanOf,
  windowOn,
  windowsOn,
  winnerLabel,
  zoneOffsetOn,
  zoneShiftsWithin,
} from './schedule'
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

/** The plan's worked example: a three-hour meeting, 8am-10pm, hourly starts. */
const threeHours: PollSchedule = {
  timezone: '-07:00',
  window: { start: '08:00', end: '22:00' },
  desired_slots: 3,
  granularity: 60,
}

/** Ninety minutes at half-hour resolution, which is the awkward one. */
const ninetyMinutes: PollSchedule = {
  timezone: '+01:00',
  window: { start: '09:00', end: '12:00' },
  desired_slots: 3,
  granularity: 30,
}

describe('enumerating the windows', () => {
  test('offers only windows that fit inside the day', () => {
    const starts = enumerateWindows(threeHours, ['2026-09-01'])
    // Fourteen hours of day, three-hour meeting, hourly starts: the last one
    // that fits begins at 7pm and ends at 10pm. A fifteenth start at 8pm
    // would run past the end of the day.
    expect(starts).toHaveLength(12)
    expect(starts[0]).toBe('2026-09-01T08:00:00-07:00')
    expect(starts[11]).toBe('2026-09-01T19:00:00-07:00')
  })

  test('counts the same windows without building them', () => {
    expect(windowsOn(threeHours, '2026-09-01')).toBe(12)
    expect(windowsOn(ninetyMinutes, '2026-09-01')).toBe(4)
    // A meeting longer than the day is offered nowhere, rather than once.
    expect(windowsOn({ ...threeHours, desired_slots: 15 }, '2026-09-01')).toBe(0)
    expect(countWindows(threeHours, ['2026-09-01', '2026-09-02'])).toBe(24)
  })

  test('steps by the granularity, not by the hour', () => {
    const starts = enumerateWindows(ninetyMinutes, ['2026-09-01'])
    expect(starts.map((s) => s.slice(11, 16))).toEqual(['09:00', '09:30', '10:00', '10:30'])
  })

  test('names carry the poll offset, and sort chronologically as text', () => {
    const starts = enumerateWindows(threeHours, ['2026-09-03', '2026-09-01'])
    expect(starts).toHaveLength(24)
    expect(starts.every((s) => s.endsWith('-07:00'))).toBe(true)
    expect([...starts].sort()).toEqual(starts)
    // Which is also what makes them unique within a poll, and so acceptable
    // to insert_option's case-insensitive duplicate check.
    expect(new Set(starts).size).toBe(starts.length)
  })

  test('a window running to the end of a day that ends at midnight', () => {
    const toMidnight = { ...threeHours, window: { start: '21:00', end: '24:00' } }
    const starts = enumerateWindows(toMidnight, ['2026-09-01'])
    expect(starts).toEqual(['2026-09-01T21:00:00-07:00'])
    expect(granulesOf(starts[0], toMidnight)).toEqual([
      '2026-09-01 21:00',
      '2026-09-01 22:00',
      '2026-09-01 23:00',
    ])
  })

  test('the days a poll asks about are the days its options start on', () => {
    const starts = enumerateWindows(threeHours, ['2026-09-02', '2026-09-01', '2026-09-02'])
    expect(daysOf(starts)).toEqual(['2026-09-01', '2026-09-02'])
  })
})

describe('a window is scored by its worst hour', () => {
  const day = '2026-09-01'
  const starts = enumerateWindows(threeHours, [day])

  test('the whole point: one bad hour makes the window unavailable', () => {
    // Free all afternoon, except that 4pm is impossible.
    const painting: Record<string, number> = {}
    for (let hour = 13; hour <= 19; hour++) painting[`${day} ${hour}:00`] = 5
    painting[`${day} 16:00`] = 0

    const scores = scoresFromPainting(starts, painting, threeHours)

    // Every window covering 4pm is out, whatever else it covers -- a mean
    // would have scored the 2pm-5pm window 3.3 and let it win.
    expect(scores[`${day}T14:00:00-07:00`]).toBe(0)
    expect(scores[`${day}T15:00:00-07:00`]).toBe(0)
    expect(scores[`${day}T16:00:00-07:00`]).toBe(0)
    // And the ones either side of it are untouched.
    expect(scores[`${day}T13:00:00-07:00`]).toBe(5)
    expect(scores[`${day}T17:00:00-07:00`]).toBe(5)
  })

  test('a lukewarm hour drags its windows down to itself', () => {
    const painting = {
      [`${day} 09:00`]: 5,
      [`${day} 10:00`]: 2,
      [`${day} 11:00`]: 4,
    }
    const scores = scoresFromPainting(starts, painting, threeHours)
    expect(scores[`${day}T09:00:00-07:00`]).toBe(2)
  })

  test('an unpainted hour is a 0, which is a real answer', () => {
    const scores = scoresFromPainting(starts, {}, threeHours)
    expect(Object.values(scores).every((score) => score === 0)).toBe(true)
    expect(saysNothing(scores)).toBe(true)
  })

  test('two free hours are not a three-hour block, and the ballot says so', () => {
    // The case that looks like the app ate the vote: everything the voter
    // marked is real, and none of it is long enough for the meeting.
    const painting = { [`${day} 09:00`]: 5, [`${day} 14:00`]: 5 }
    expect(saysNothing(scoresFromPainting(starts, painting, threeHours))).toBe(true)
  })

  test('every window gets a score, so no option is left unsent', () => {
    const scores = scoresFromPainting(starts, { [`${day} 09:00`]: 5 }, threeHours)
    expect(Object.keys(scores).sort()).toEqual([...starts].sort())
  })
})

describe('reading a ballot back onto the calendar', () => {
  const day = '2026-09-01'
  const starts = enumerateWindows(threeHours, [day])

  test('a painting survives the round trip when it is flat', () => {
    const painting: Record<string, number> = {}
    for (let hour = 13; hour <= 18; hour++) painting[`${day} ${hour}:00`] = 4

    const scores = scoresFromPainting(starts, painting, threeHours)
    expect(paintingFromScores(starts, scores, threeHours)).toEqual(painting)
  })

  test('and is lossy when it is not, in the direction that keeps availability', () => {
    // 5 at 9am and 2 at 10am sends one window scored 2; the maximum over the
    // windows covering 9am is that same 2, so the 5 is gone. The voter's
    // availability is intact and their enthusiasm is flattened, which is the
    // trade -- see paintingFromScores.
    const painting = { [`${day} 09:00`]: 5, [`${day} 10:00`]: 2, [`${day} 11:00`]: 4 }
    const repainted = paintingFromScores(
      starts,
      scoresFromPainting(starts, painting, threeHours),
      threeHours,
    )
    expect(repainted).toEqual({
      [`${day} 09:00`]: 2,
      [`${day} 10:00`]: 2,
      [`${day} 11:00`]: 2,
    })
  })

  test('a 0 window paints nothing rather than painting a zero', () => {
    const repainted = paintingFromScores(starts, {}, threeHours)
    expect(repainted).toEqual({})
  })

  test('a granule under two windows takes the better of them', () => {
    // 1pm is the last hour of the 11am window and the first of the 1pm one.
    const scores = { [`${day}T11:00:00-07:00`]: 1, [`${day}T13:00:00-07:00`]: 5 }
    expect(paintingFromScores(starts, scores, threeHours)[`${day} 13:00`]).toBe(5)
  })
})

describe('what a window is called on screen', () => {
  test('reads as a time, in the poll offset and never the reader own', () => {
    expect(formatWindow('2026-09-01T14:00:00-07:00')).toBe('Tue 1 Sep, 2:00pm')
    // The same instant with a different offset on it is a different wall
    // clock, and this reads the offset the poll declared rather than converting
    // to the reader's -- which is the whole of one-timezone-per-poll.
    expect(formatWindow('2026-09-05T09:30:00+01:00')).toBe('Sat 5 Sep, 9:30am')
  })

  test('and takes no schedule, which is what keeps it out of the database', () => {
    // A name is enough. Nothing above this has to be told which kind of poll
    // it is drawing, so list_polls, poll_status and the three cards that draw
    // a winner all stayed as they were.
    expect(winnerLabel('2026-09-01T14:00:00-07:00')).toBe('Tue 1 Sep, 2:00pm')
    // null is "settled, and nobody won"; undefined is "not settled". Both are
    // answers rather than names, so neither is formatted.
    expect(winnerLabel(null)).toBeNull()
    expect(winnerLabel(undefined)).toBeUndefined()
  })

  test('midnight at either end of the day', () => {
    expect(clock(0)).toBe('12:00am')
    expect(clock(12 * 60)).toBe('12:00pm')
    expect(clock(24 * 60)).toBe('12:00am')
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

describe('a day with hours of its own', () => {
  /**
   * The case the whole feature is for: a two-hour thing over a weekend, where
   * Friday is only free in the evening and Saturday is free from breakfast.
   *
   * `window` is the union of the two, because it is the axis the ballot's grid
   * is drawn on; the per-day entries are what each day actually asks.
   */
  const weekend: PollSchedule = {
    timezone: '-07:00',
    window: { start: '09:00', end: '22:00' },
    day_windows: {
      '2026-09-04': { start: '18:00', end: '22:00' },
      '2026-09-05': { start: '09:00', end: '22:00' },
    },
    desired_slots: 2,
    granularity: 60,
  }
  const days = ['2026-09-04', '2026-09-05']

  test('each day is enumerated against its own hours', () => {
    const starts = enumerateWindows(weekend, days)
    const friday = starts.filter((s) => s.startsWith('2026-09-04'))
    const saturday = starts.filter((s) => s.startsWith('2026-09-05'))

    // Four hours of Friday evening, two-hour meeting, hourly starts: 6, 7, 8.
    expect(friday.map((s) => s.slice(11, 16))).toEqual(['18:00', '19:00', '20:00'])
    // Thirteen hours of Saturday: 9am through 8pm.
    expect(saturday).toHaveLength(12)
    expect(saturday[0].slice(11, 16)).toBe('09:00')
    expect(saturday[11].slice(11, 16)).toBe('20:00')
    // Still one sorted list, which is what `sort_order` ends up holding.
    expect([...starts].sort()).toEqual(starts)
  })

  test('and counted against them, one day at a time and altogether', () => {
    expect(windowsOn(weekend, '2026-09-04')).toBe(3)
    expect(windowsOn(weekend, '2026-09-05')).toBe(12)
    expect(countWindows(weekend, days)).toBe(15)
  })

  test('a day nobody singled out gets the poll own hours', () => {
    // Sunday has no entry, so it is the poll's window: 9am to 10pm.
    expect(windowOn(weekend, '2026-09-06')).toEqual({ start: '09:00', end: '22:00' })
    expect(windowsOn(weekend, '2026-09-06')).toBe(12)
  })

  test('the axis is the union, which is what the grid has to be tall enough for', () => {
    expect(spanOf(weekend, days)).toEqual({ start: '09:00', end: '22:00' })
    // Friday alone is four hours of grid, not thirteen.
    expect(spanOf(weekend, ['2026-09-04'])).toEqual({ start: '18:00', end: '22:00' })
    // Nothing to take a union of leaves the poll's own hours standing.
    expect(spanOf(weekend, [])).toEqual(weekend.window)
  })

  test('what a voter may paint, cell by cell', () => {
    const inBounds = new Set(days)
    // Friday morning is on the grid -- Saturday needs those rows -- and is not
    // paintable, which is the whole reason the two are different questions.
    expect(paintable(weekend, inBounds, '2026-09-04', '10:00')).toBe(false)
    expect(paintable(weekend, inBounds, '2026-09-04', '18:00')).toBe(true)
    expect(paintable(weekend, inBounds, '2026-09-05', '10:00')).toBe(true)
    // The last cell of a day ends when the day does, and the one after it
    // belongs to a day that is over.
    expect(paintable(weekend, inBounds, '2026-09-04', '21:00')).toBe(true)
    expect(paintable(weekend, inBounds, '2026-09-04', '22:00')).toBe(false)
    // A day the poll never asked about is not paintable at any hour.
    expect(paintable(weekend, inBounds, '2026-09-06', '10:00')).toBe(false)
  })

  test('filling a whole day fills that day and no more', () => {
    expect(granulesInBounds(weekend, '2026-09-04')).toEqual([
      '2026-09-04 18:00',
      '2026-09-04 19:00',
      '2026-09-04 20:00',
      '2026-09-04 21:00',
    ])
    expect(granulesInBounds(weekend, '2026-09-05')).toHaveLength(13)
  })

  test('painting a whole day scores every window on it and nothing else', () => {
    // What the "Whole day" control does, put through the derivation: every
    // window on Friday takes the brush, and Saturday is untouched.
    const starts = enumerateWindows(weekend, days)
    const painting: Record<string, number> = {}
    for (const key of granulesInBounds(weekend, '2026-09-04')) painting[key] = 4

    const scores = scoresFromPainting(starts, painting, weekend)
    expect(scores['2026-09-04T18:00:00-07:00']).toBe(4)
    expect(scores['2026-09-04T20:00:00-07:00']).toBe(4)
    expect(scores['2026-09-05T09:00:00-07:00']).toBe(0)
    // And it survives being read back, because a flat painting is the one
    // shape the minimum rule loses nothing from.
    expect(paintingFromScores(starts, scores, weekend)).toEqual(painting)
  })

  test('a poll with no per-day hours is exactly the poll it was', () => {
    // The shape every poll made before this existed still has, and the shape
    // most polls will keep having.
    expect(windowOn(threeHours, '2026-09-01')).toEqual(threeHours.window)
    expect(enumerateWindows(threeHours, ['2026-09-01'])).toHaveLength(12)
    expect(spanOf(threeHours, ['2026-09-01', '2026-09-02'])).toEqual(threeHours.window)
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

  test('a poll that runs across a clock change says which days moved', () => {
    // The last Sunday in October, when the UK goes back to +00:00.
    const across = ['2026-10-23', '2026-10-24', '2026-10-26', '2026-10-27']
    expect(zoneShiftsWithin('Europe/London', across)).toEqual(['2026-10-26', '2026-10-27'])
    // And the ordinary answer, which is silence.
    expect(zoneShiftsWithin('Europe/London', ['2026-07-01', '2026-07-08'])).toEqual([])
    expect(zoneShiftsWithin('Europe/London', [])).toEqual([])
  })

  test('a reader is told the zone and the offset, never the zone alone', () => {
    const labelled: PollSchedule = { ...threeHours, timezone_label: 'Mountain Time (Denver)' }
    expect(describeOffset(labelled)).toBe('Mountain Time (Denver) — UTC-07:00')
    // A poll whose creator picked a bare offset has nothing to add to it.
    expect(describeOffset(threeHours)).toBe('UTC-07:00')
  })
})
