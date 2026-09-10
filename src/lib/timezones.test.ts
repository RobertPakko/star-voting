import { describe, expect, test } from 'vitest'
import { NAMED_ZONES, offsetChoices, offsetDrift, offsetName } from './timezones'
import { offsetMinutes, zoneOffsetOn } from './schedule'

/**
 * One list of offsets, and the names hung off it.
 *
 * A poll is held at an offset and never at a zone, so the offsets are what the
 * picker offers and the zones below are machinery: they answer "what do people
 * on this offset call it", so a creator who does not know they are on `-07:00`
 * can recognise `Pacific Time` and pick it.
 *
 * Two things can go wrong quietly. A zone id with a typo in it reads fine and
 * silently names nothing, and a caption worked out for the wrong half of the
 * year names the wrong place -- `-07:00` is Pacific Time in July and Mountain
 * Time in January, and either answer looks perfectly reasonable on its own.
 * Both are checked here.
 */

describe('the zones the names come from', () => {
  test('there are some, which is what stops the rest passing vacuously', () => {
    expect(NAMED_ZONES.length).toBeGreaterThan(20)
  })

  test('each names a zone the runtime has actually heard of', () => {
    for (const { zone } of NAMED_ZONES) {
      expect(zoneOffsetOn(zone, '2026-07-01'), zone).not.toBeNull()
      expect(zoneOffsetOn(zone, '2026-01-01'), zone).not.toBeNull()
    }
  })

  test('and each of them once', () => {
    expect(new Set(NAMED_ZONES.map((z) => z.zone)).size).toBe(NAMED_ZONES.length)
  })

  test('named by the rule rather than by the season', () => {
    // `Pacific Daylight Time` is right for half a year and wrong for the other
    // half; `Pacific Time` is the rule, and the offset beside it says which
    // half the poll is in.
    for (const { name } of NAMED_ZONES) {
      expect(name, name).not.toMatch(/Daylight|Standard|Summer/)
    }
  })
})

describe('what an offset is called', () => {
  test('depends on the time of year, which is the whole trick', () => {
    // The same number, two names, and both right on their own dates. Asking on
    // the poll's own first day is what lets there be one name per offset.
    expect(offsetName('-07:00', '2026-07-15')).toBe('Pacific Time')
    expect(offsetName('-07:00', '2026-01-15')).toBe('Mountain Time')
    expect(offsetName('-06:00', '2026-07-15')).toBe('Mountain Time')
    expect(offsetName('-06:00', '2026-01-15')).toBe('Central Time')
    expect(offsetName('-05:00', '2026-07-15')).toBe('Central Time')
    expect(offsetName('-05:00', '2026-01-15')).toBe('Eastern Time')
    expect(offsetName('-04:00', '2026-07-15')).toBe('Eastern Time')
  })

  test('and the same holds across Europe', () => {
    expect(offsetName('+00:00', '2026-07-15')).toBe('Greenwich Mean Time')
    expect(offsetName('+01:00', '2026-07-15')).toBe('UK Time')
    expect(offsetName('+02:00', '2026-07-15')).toBe('Central European Time')
    expect(offsetName('+01:00', '2026-01-15')).toBe('Central European Time')
    expect(offsetName('+02:00', '2026-01-15')).toBe('Eastern European Time')
  })

  test('an offset nobody keeps a clock on has no name', () => {
    expect(offsetName('-07:15', '2026-07-15')).toBeNull()
    expect(offsetName('+02:15', '2026-07-15')).toBeNull()
  })

  test('the part-hours that do exist are named, because that is why they are offered', () => {
    expect(offsetName('+05:30', '2026-07-15')).toBe('India Time')
    expect(offsetName('+05:45', '2026-07-15')).toBe('Nepal Time')
    expect(offsetName('+09:30', '2026-07-15')).toBe('Central Australia Time')
  })
})

describe('the list the picker draws', () => {
  const july = offsetChoices('2026-07-15')

  test('is every whole hour of civil time, in order', () => {
    const minutes = july.map((choice) => offsetMinutes(choice.offset))
    expect(minutes[0]).toBe(-12 * 60)
    expect(minutes[minutes.length - 1]).toBe(14 * 60)
    expect([...minutes].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(minutes)
    for (let hours = -12; hours <= 14; hours++) expect(minutes).toContain(hours * 60)
  })

  test('plus the part-hours somebody is actually on that day, and no others', () => {
    const parts = july.filter((choice) => offsetMinutes(choice.offset)! % 60 !== 0)
    expect(parts.map((choice) => choice.offset)).toContain('+05:30')
    expect(parts.map((choice) => choice.offset)).toContain('+05:45')
    // The sixty quarter-hours nobody has ever kept a clock on are the whole
    // reason the old list was noise, and they are not here.
    expect(parts.map((choice) => choice.offset)).not.toContain('-07:15')
    // Every part-hour that survives is here because something is on it, so
    // every one of them is named.
    for (const choice of parts) expect(choice.name, choice.offset).not.toBeNull()
  })

  test('and never a duplicate, whatever the day', () => {
    for (const day of ['2026-01-15', '2026-07-15', '2026-11-01']) {
      const offsets = offsetChoices(day).map((choice) => choice.offset)
      expect(new Set(offsets).size, day).toBe(offsets.length)
    }
  })

  test('keeps an offset a poll is already held at, however odd', () => {
    // Otherwise opening or duplicating such a poll shows an empty box where
    // its own offset should be.
    const kept = offsetChoices('2026-07-15', '-07:15')
    expect(kept.map((c) => c.offset)).toContain('-07:15')
    expect(kept.find((c) => c.offset === '-07:15')?.name).toBeNull()
    // And does not double up when the list already has it.
    const already = offsetChoices('2026-07-15', '+05:30').map((c) => c.offset)
    expect(already.filter((offset) => offset === '+05:30')).toHaveLength(1)
  })
})

describe('a poll that runs across a clock change', () => {
  test('says which day it moves and what it moves to', () => {
    // The last Sunday in October, when the UK goes back to +00:00. A poll held
    // at +01:00 over those dates reads an hour off the wall in London from
    // then on -- which cannot be fixed, one poll being one offset, so it is
    // said.
    const across = ['2026-10-23', '2026-10-24', '2026-10-26', '2026-10-27']
    expect(offsetDrift('+01:00', across)).toEqual({
      day: '2026-10-26',
      name: 'UK Time',
      becomes: '+00:00',
    })
  })

  test('and is silent on the ordinary poll that does not', () => {
    expect(offsetDrift('+01:00', ['2026-07-01', '2026-07-08'])).toBeNull()
    expect(offsetDrift('+01:00', [])).toBeNull()
    // An offset nobody is on cannot drift away from anybody.
    expect(offsetDrift('-07:15', ['2026-10-23', '2026-10-27'])).toBeNull()
  })
})
