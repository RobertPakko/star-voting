import { describe, expect, test } from 'vitest'
import {
  FIXED_OFFSET_PREFIX,
  TIME_ZONES,
  TIME_ZONE_REGIONS,
  fixedOffsetOf,
  resolveZone,
  zoneLabel,
  zoneOfSchedule,
} from './timezones'
import { zoneOffsetOn } from './schedule'

/**
 * The list, and the round trip through it.
 *
 * A poll stores the *offset* a place resolved to and the *label* that place
 * was called; the place itself is thrown away, because a poll held at a named
 * zone is the thing schedule mode exists not to be. Duplicating a time poll
 * has to find the place again, and the only handle it has is the label.
 *
 * So the round trip is load-bearing and silently breakable: rename a city here
 * and every existing poll's label stops matching, at which point duplicates
 * quietly fall back to the bare offset and stop following their zone across a
 * daylight-saving change. Nothing else about the app would look any different.
 * That is what these check.
 */

const EVERY = TIME_ZONE_REGIONS.flatMap((region) => TIME_ZONES[region])

describe('the list of places', () => {
  test('is not empty, which is the assertion that stops the rest passing vacuously', () => {
    expect(EVERY.length).toBeGreaterThan(40)
    expect(TIME_ZONE_REGIONS).toContain('Americas')
  })

  test('names a zone the runtime has actually heard of', () => {
    // A typo in an IANA id is invisible until somebody picks it: the label
    // reads fine and the offset silently comes back null.
    for (const choice of EVERY) {
      expect(zoneOffsetOn(choice.zone, '2026-07-01'), choice.zone).not.toBeNull()
      expect(zoneOffsetOn(choice.zone, '2026-01-01'), choice.zone).not.toBeNull()
    }
  })

  test('and each of them exactly once', () => {
    expect(new Set(EVERY.map((c) => c.zone)).size).toBe(EVERY.length)
    // Labels too: two entries sharing one is a round trip that lands on
    // whichever happened to be built last.
    expect(new Set(EVERY.map(zoneLabel)).size).toBe(EVERY.length)
  })
})

describe('a stored schedule, read back as the place it came from', () => {
  test('every label finds its way home', () => {
    for (const choice of EVERY) {
      const stored = resolveZone(choice.zone, '2026-09-04')
      expect(zoneOfSchedule(stored.timezone, stored.timezone_label), choice.zone).toBe(choice.zone)
    }
  })

  test('a bare offset comes back as itself', () => {
    const stored = resolveZone(`${FIXED_OFFSET_PREFIX}-03:30`, '2026-09-04')
    expect(stored).toEqual({ timezone: '-03:30', timezone_label: null })
    expect(zoneOfSchedule(stored.timezone, stored.timezone_label)).toBe(
      `${FIXED_OFFSET_PREFIX}-03:30`,
    )
    expect(fixedOffsetOf(zoneOfSchedule('-03:30', null))).toBe('-03:30')
  })

  test('and so does a label naming a place this list no longer carries', () => {
    // What a poll made by an older or newer bundle looks like. The offset is
    // what the poll is actually held at, so falling back to it is never wrong
    // -- the copy simply stops following that zone's clock changes.
    expect(zoneOfSchedule('-07:00', 'Pacific Time (Atlantis)')).toBe(`${FIXED_OFFSET_PREFIX}-07:00`)
    // And a poll made before labels existed at all.
    expect(zoneOfSchedule('+05:45', null)).toBe(`${FIXED_OFFSET_PREFIX}+05:45`)
    expect(zoneOfSchedule('+05:45', undefined)).toBe(`${FIXED_OFFSET_PREFIX}+05:45`)
  })

  test('a place is resolved on the day it is asked about, not on today', () => {
    // The bug this replaced: a poll made in March about a July meeting stored
    // March's offset and was an hour out on every option it offered.
    expect(resolveZone('America/Denver', '2026-07-04').timezone).toBe('-06:00')
    expect(resolveZone('America/Denver', '2026-01-04').timezone).toBe('-07:00')
    expect(resolveZone('America/Denver', '2026-07-04').timezone_label).toBe(
      'Mountain Time (Denver)',
    )
  })
})
