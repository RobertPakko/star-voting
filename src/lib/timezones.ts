import {
  browserOffset,
  describeOffset,
  offsetMinutes,
  toTimeOfDay,
  viewerZone,
  zoneOffsetOn,
} from './schedule'
import type { ScheduleDay } from './schedule'

/**
 * The offsets a poll can be held in, and what to call them.
 *
 * A poll is stored at a **fixed UTC offset** and never at a named zone -- see
 * `PollSchedule.timezone`, where the reasons are written down. So the picker
 * offers offsets, in order, and that is the whole of what is being chosen:
 * `UTC-07:00`, `UTC+05:30`, `UTC+01:00`. There is one list and one kind of
 * thing in it.
 *
 * **The zones below are machinery, not choices.** Nobody picks one and nothing
 * stores one. They exist to answer "what do people call this offset", so that
 * a creator who does not know they are on `-07:00` can recognise
 * `UTC-07:00 (Pacific Time)` and pick it. The name is a caption on the number
 * and the number is what the poll is.
 *
 * **A name is worked out for the poll's own dates, which is the trick that
 * makes one name per offset possible at all.** `-07:00` is Pacific Time in
 * July and Mountain Time in January, because the clocks move and the offset
 * does not; asking on the poll's first day gets the one that is true while the
 * poll is running. It also means the answer changes when the dates do, so the
 * label is re-derived rather than kept -- see `CreatePoll`'s `pickOffset` and
 * `pickDays`.
 *
 * **Order is precedence.** Several zones share an offset on any given day, and
 * the first entry here that matches is the one that names it. The order is
 * roughly how many people would recognise the name as their own, which is a
 * judgement rather than a fact -- and a cheap one to get slightly wrong, since
 * the offset is written beside it and is never ambiguous. Within a continent
 * it works out exactly, because the zones there are on different offsets from
 * each other at any one moment: in July `-07:00` reaches Los Angeles first and
 * in January it reaches Denver first, and both are right.
 */

interface NamedZone {
  /** An IANA zone id, which is what `Intl` is asked about. */
  zone: string
  /** The rule, not the season: `Pacific Time`, never `Pacific Daylight Time`. */
  name: string
}

const ZONES: NamedZone[] = [
  { zone: 'Asia/Shanghai', name: 'China Time' },
  { zone: 'Asia/Kolkata', name: 'India Time' },
  { zone: 'America/New_York', name: 'Eastern Time' },
  { zone: 'Europe/Berlin', name: 'Central European Time' },
  { zone: 'America/Chicago', name: 'Central Time' },
  { zone: 'America/Los_Angeles', name: 'Pacific Time' },
  { zone: 'Europe/London', name: 'UK Time' },
  { zone: 'America/Denver', name: 'Mountain Time' },
  { zone: 'Asia/Tokyo', name: 'Japan Time' },
  { zone: 'Europe/Athens', name: 'Eastern European Time' },
  { zone: 'America/Sao_Paulo', name: 'Brasília Time' },
  { zone: 'Asia/Jakarta', name: 'Western Indonesia Time' },
  { zone: 'Asia/Dhaka', name: 'Bangladesh Time' },
  { zone: 'Asia/Karachi', name: 'Pakistan Time' },
  { zone: 'Africa/Lagos', name: 'West Africa Time' },
  { zone: 'Africa/Nairobi', name: 'East Africa Time' },
  { zone: 'Europe/Moscow', name: 'Moscow Time' },
  { zone: 'Asia/Riyadh', name: 'Arabia Time' },
  { zone: 'Asia/Dubai', name: 'Gulf Time' },
  { zone: 'Asia/Bangkok', name: 'Indochina Time' },
  { zone: 'Australia/Sydney', name: 'Eastern Australia Time' },
  { zone: 'Pacific/Auckland', name: 'New Zealand Time' },
  { zone: 'Atlantic/Reykjavik', name: 'Greenwich Mean Time' },
  { zone: 'America/Halifax', name: 'Atlantic Time' },
  { zone: 'America/Anchorage', name: 'Alaska Time' },
  { zone: 'Pacific/Honolulu', name: 'Hawaii–Aleutian Time' },
  { zone: 'Australia/Perth', name: 'Western Australia Time' },
  { zone: 'Australia/Adelaide', name: 'Central Australia Time' },
  { zone: 'Asia/Tehran', name: 'Iran Time' },
  { zone: 'Asia/Kabul', name: 'Afghanistan Time' },
  { zone: 'Asia/Kathmandu', name: 'Nepal Time' },
  { zone: 'Asia/Yangon', name: 'Myanmar Time' },
  { zone: 'America/St_Johns', name: 'Newfoundland Time' },
  { zone: 'Pacific/Chatham', name: 'Chatham Time' },
]

/**
 * Which offset each named zone is on, on one day -- worked out once per day
 * asked about rather than once per row of the picker.
 *
 * Every question below is some form of "who is on this offset", and answering
 * it means asking `Intl` about thirty-odd zones. The picker asks it forty
 * times over, once per row, and re-asks on every keystroke in its search box.
 */
const ON_DAY = new Map<ScheduleDay, Map<string, string>>()

function offsetsOn(on: ScheduleDay): Map<string, string> {
  let known = ON_DAY.get(on)
  if (!known) {
    known = new Map()
    for (const { zone } of ZONES) {
      const offset = zoneOffsetOn(zone, on)
      if (offset) known.set(zone, offset)
    }
    ON_DAY.set(on, known)
  }
  return known
}

/**
 * What to call an offset on a given day, or null when nothing in the list is
 * on it -- which is most of the quarter-hours nobody lives on, and is the
 * whole of what "if applicable" means in the picker.
 */
export function offsetName(offset: string, on: ScheduleDay): string | null {
  const known = offsetsOn(on)
  for (const { zone, name } of ZONES) {
    if (known.get(zone) === offset) return name
  }
  return null
}

/** `UTC-07:00 (Pacific Time)`, or `UTC-07:15` where there is nothing to add. */
export function describeOffsetWith(offset: string, name?: string | null): string {
  return describeOffset(offset, name)
}

/**
 * The offsets the picker offers on a given day, ascending.
 *
 * Every whole hour from -12:00 to +14:00 -- the range of civil time, Chatham
 * Islands and all -- plus every part-hour offset something in the list above is
 * actually on that day. So `+05:30` and `+05:45` are there because India and
 * Nepal are, `-02:30` appears only while Newfoundland is on summer time, and
 * the sixty quarter-hours nobody has ever kept a clock on are not there at all.
 *
 * That is a narrowing of what used to be offered, and the reason for it is the
 * reason the list was merged in the first place: a row that names an offset no
 * human being is on is a row to scroll past. Every part-hour row that survives
 * has a name beside it, because it is there precisely because something is on
 * it.
 *
 * `keep` is an offset to include whatever the list says -- a poll already
 * stored at one, so that opening or duplicating it shows what it is held at
 * rather than an empty box.
 */
export function offsetChoices(
  on: ScheduleDay,
  keep?: string,
): { offset: string; name: string | null }[] {
  const wanted = new Set<number>()
  for (let hours = -12; hours <= 14; hours++) wanted.add(hours * 60)
  for (const offset of offsetsOn(on).values()) {
    const minutes = offsetMinutes(offset)
    if (minutes !== null) wanted.add(minutes)
  }
  const kept = keep ? offsetMinutes(keep) : null
  if (kept !== null) wanted.add(kept)

  return [...wanted]
    .sort((a, b) => a - b)
    .map((minutes) => {
      const offset = `${minutes < 0 ? '-' : '+'}${toTimeOfDay(Math.abs(minutes))}`
      return { offset, name: offsetName(offset, on) }
    })
}

/**
 * The clock change a poll is about to run across, or null for the ordinary
 * poll that is not.
 *
 * A poll is one offset for its whole length and that cannot be fixed -- it is
 * the point. What can be done is to say so: the zone that gave this offset its
 * name is checked on every day of the poll, and if it leaves the offset partway
 * through, the first day it does and what it moves to come back. A creator who
 * picked `UTC+01:00 · UK Time` for the week the clocks go back is told that the
 * later days will read an hour off the wall in London, and can move the poll or
 * accept it.
 *
 * Nothing to say when the offset has no name: an offset nobody is on cannot
 * drift away from anybody.
 */
export function offsetDrift(
  offset: string,
  days: ScheduleDay[],
): { day: ScheduleDay; name: string; becomes: string } | null {
  const sorted = [...days].sort()
  if (sorted.length === 0) return null

  const named = ZONES.find((entry) => offsetsOn(sorted[0]).get(entry.zone) === offset)
  if (!named) return null

  for (const day of sorted) {
    const then = zoneOffsetOn(named.zone, day)
    if (then && then !== offset) return { day, name: named.name, becomes: then }
  }
  return null
}

/**
 * The offset this browser is on, on the day the poll starts -- the picker's
 * opening guess, and right nearly always, because a creator is usually
 * organising a meeting where they are.
 *
 * On the poll's day rather than today, which is the whole difference between
 * this and reading `getTimezoneOffset()`: somebody in Denver setting up a July
 * meeting in March is on `-07:00` as they type and `-06:00` when it happens.
 */
export function viewerOffsetOn(on: ScheduleDay): string {
  return zoneOffsetOn(viewerZone(), on) ?? browserOffset()
}

/** Every zone the names come from, for `timezones.test.ts`. */
export const NAMED_ZONES: readonly NamedZone[] = ZONES
