/**
 * Places a poll can be held, as a person would name one.
 *
 * A poll is stored at a **fixed UTC offset** and never at a named zone -- see
 * `PollSchedule.timezone`, where the reasons are written down, and they have
 * not changed. What has changed is who has to do the conversion. Asking a
 * creator for `-07:00` asks them for a number most people do not know about
 * themselves, and the ones who do often know the half of the year they are not
 * currently in: somebody in Denver is on `-07:00` in January and `-06:00` in
 * July, and a poll about a July meeting built on a January answer is an hour
 * wrong on every option.
 *
 * So the form asks for a place, and `zoneOffsetOn` asks the browser's own zone
 * database what that place's clock reads on the first day the poll is asking
 * about. The answer is stored, the zone is discarded, and everything
 * downstream is exactly the poll it was before: one offset, one grid,
 * everybody looking at the same labels. The name the creator picked is kept
 * beside the offset as `timezone_label`, which is presentation and nothing
 * else -- a voter is told "Mountain Time (Denver) — UTC-06:00" instead of four
 * digits.
 *
 * **The list is deliberately short.** The full zone database is around six
 * hundred names, most of them either aliases or places nobody is organising a
 * meeting from, and a searchable list of six hundred is not more usable than a
 * searchable list of sixty -- it is less. What is here is one entry per
 * offset-and-rule combination that a person is plausibly sitting in, named
 * after the biggest city on it. Anybody the list does not cover picks a bare
 * offset from the group at the bottom of it, which is what every creator did
 * before this existed.
 *
 * A zone is named by its rule rather than by the season: `Mountain Time`, not
 * `Mountain Daylight Time`. The season is exactly the thing that is not fixed,
 * and a label that names one is a label that is wrong for half the year --
 * whereas the offset beside it is right for the poll, always, because it was
 * resolved on the poll's own dates.
 */

import { browserOffset, viewerZone, zoneOffsetOn } from './schedule'

export interface TimeZoneChoice {
  /** An IANA zone id, which is what `Intl` is asked about. */
  zone: string
  /** The rule, not the season: `Mountain Time`. */
  name: string
  /** Somewhere on it a reader will recognise. */
  city: string
}

/** Which part of the world to look under. Ordered west to east within each. */
export type TimeZoneRegion = 'Americas' | 'Europe & Africa' | 'Asia' | 'Oceania' | 'Elsewhere'

export const TIME_ZONES: Record<TimeZoneRegion, TimeZoneChoice[]> = {
  Americas: [
    { zone: 'Pacific/Honolulu', name: 'Hawaii–Aleutian Time', city: 'Honolulu' },
    { zone: 'America/Anchorage', name: 'Alaska Time', city: 'Anchorage' },
    { zone: 'America/Los_Angeles', name: 'Pacific Time', city: 'Los Angeles' },
    { zone: 'America/Vancouver', name: 'Pacific Time', city: 'Vancouver' },
    { zone: 'America/Phoenix', name: 'Mountain Time, no clock change', city: 'Phoenix' },
    { zone: 'America/Denver', name: 'Mountain Time', city: 'Denver' },
    { zone: 'America/Chicago', name: 'Central Time', city: 'Chicago' },
    { zone: 'America/Mexico_City', name: 'Central Time', city: 'Mexico City' },
    { zone: 'America/New_York', name: 'Eastern Time', city: 'New York' },
    { zone: 'America/Toronto', name: 'Eastern Time', city: 'Toronto' },
    { zone: 'America/Bogota', name: 'Colombia Time', city: 'Bogotá' },
    { zone: 'America/Lima', name: 'Peru Time', city: 'Lima' },
    { zone: 'America/Halifax', name: 'Atlantic Time', city: 'Halifax' },
    { zone: 'America/Santiago', name: 'Chile Time', city: 'Santiago' },
    { zone: 'America/Sao_Paulo', name: 'Brasília Time', city: 'São Paulo' },
    { zone: 'America/Argentina/Buenos_Aires', name: 'Argentina Time', city: 'Buenos Aires' },
  ],
  'Europe & Africa': [
    { zone: 'Atlantic/Reykjavik', name: 'Greenwich Mean Time', city: 'Reykjavík' },
    { zone: 'Europe/London', name: 'UK Time', city: 'London' },
    { zone: 'Europe/Dublin', name: 'Ireland Time', city: 'Dublin' },
    { zone: 'Europe/Lisbon', name: 'Western European Time', city: 'Lisbon' },
    { zone: 'Africa/Accra', name: 'Greenwich Mean Time', city: 'Accra' },
    { zone: 'Africa/Lagos', name: 'West Africa Time', city: 'Lagos' },
    { zone: 'Europe/Madrid', name: 'Central European Time', city: 'Madrid' },
    { zone: 'Europe/Paris', name: 'Central European Time', city: 'Paris' },
    { zone: 'Europe/Amsterdam', name: 'Central European Time', city: 'Amsterdam' },
    { zone: 'Europe/Berlin', name: 'Central European Time', city: 'Berlin' },
    { zone: 'Europe/Zurich', name: 'Central European Time', city: 'Zürich' },
    { zone: 'Europe/Rome', name: 'Central European Time', city: 'Rome' },
    { zone: 'Europe/Stockholm', name: 'Central European Time', city: 'Stockholm' },
    { zone: 'Europe/Warsaw', name: 'Central European Time', city: 'Warsaw' },
    { zone: 'Africa/Johannesburg', name: 'South Africa Time', city: 'Johannesburg' },
    { zone: 'Africa/Cairo', name: 'Eastern European Time', city: 'Cairo' },
    { zone: 'Europe/Athens', name: 'Eastern European Time', city: 'Athens' },
    { zone: 'Europe/Helsinki', name: 'Eastern European Time', city: 'Helsinki' },
    { zone: 'Europe/Kyiv', name: 'Eastern European Time', city: 'Kyiv' },
    { zone: 'Africa/Nairobi', name: 'East Africa Time', city: 'Nairobi' },
    { zone: 'Europe/Istanbul', name: 'Türkiye Time', city: 'Istanbul' },
    { zone: 'Europe/Moscow', name: 'Moscow Time', city: 'Moscow' },
  ],
  Asia: [
    { zone: 'Asia/Jerusalem', name: 'Israel Time', city: 'Jerusalem' },
    { zone: 'Asia/Riyadh', name: 'Arabia Time', city: 'Riyadh' },
    { zone: 'Asia/Tehran', name: 'Iran Time', city: 'Tehran' },
    { zone: 'Asia/Dubai', name: 'Gulf Time', city: 'Dubai' },
    { zone: 'Asia/Karachi', name: 'Pakistan Time', city: 'Karachi' },
    { zone: 'Asia/Kolkata', name: 'India Time', city: 'Delhi, Mumbai' },
    { zone: 'Asia/Kathmandu', name: 'Nepal Time', city: 'Kathmandu' },
    { zone: 'Asia/Dhaka', name: 'Bangladesh Time', city: 'Dhaka' },
    { zone: 'Asia/Bangkok', name: 'Indochina Time', city: 'Bangkok' },
    { zone: 'Asia/Jakarta', name: 'Western Indonesia Time', city: 'Jakarta' },
    { zone: 'Asia/Shanghai', name: 'China Time', city: 'Beijing, Shanghai' },
    { zone: 'Asia/Hong_Kong', name: 'Hong Kong Time', city: 'Hong Kong' },
    { zone: 'Asia/Singapore', name: 'Singapore Time', city: 'Singapore' },
    { zone: 'Asia/Manila', name: 'Philippine Time', city: 'Manila' },
    { zone: 'Asia/Taipei', name: 'Taipei Time', city: 'Taipei' },
    { zone: 'Asia/Seoul', name: 'Korea Time', city: 'Seoul' },
    { zone: 'Asia/Tokyo', name: 'Japan Time', city: 'Tokyo' },
  ],
  Oceania: [
    { zone: 'Australia/Perth', name: 'Western Australia Time', city: 'Perth' },
    { zone: 'Australia/Adelaide', name: 'Central Australia Time', city: 'Adelaide' },
    {
      zone: 'Australia/Brisbane',
      name: 'Eastern Australia Time, no clock change',
      city: 'Brisbane',
    },
    { zone: 'Australia/Sydney', name: 'Eastern Australia Time', city: 'Sydney' },
    { zone: 'Australia/Melbourne', name: 'Eastern Australia Time', city: 'Melbourne' },
    { zone: 'Pacific/Auckland', name: 'New Zealand Time', city: 'Auckland' },
    { zone: 'Pacific/Fiji', name: 'Fiji Time', city: 'Suva' },
  ],
  Elsewhere: [{ zone: 'UTC', name: 'Coordinated Universal Time', city: 'UTC' }],
}

export const TIME_ZONE_REGIONS = Object.keys(TIME_ZONES) as TimeZoneRegion[]

/** Every entry, flattened, for the lookups below. */
const BY_ZONE = new Map<string, TimeZoneChoice>(
  TIME_ZONE_REGIONS.flatMap((region) => TIME_ZONES[region]).map((choice) => [choice.zone, choice]),
)

/** The entry for an IANA zone id, if the list carries one. */
export function zoneChoice(zone: string): TimeZoneChoice | undefined {
  return BY_ZONE.get(zone)
}

/**
 * How a chosen zone is written down on the poll: `Mountain Time (Denver)`.
 *
 * Stored in `timezone_label` and shown beside the offset, never instead of it.
 * A zone whose name is already the place -- UTC -- says it once.
 */
export function zoneLabel(choice: TimeZoneChoice): string {
  return choice.city === choice.name ? choice.name : `${choice.name} (${choice.city})`
}

/**
 * The value a bare UTC offset carries in the picker, kept apart from the zone
 * ids so one `Select` can offer both without either shadowing the other.
 *
 * `utc:` rather than nothing, because `UTC` is itself a real IANA zone id and
 * is in the list above; without the prefix, "the zone called UTC" and "the
 * fixed offset +00:00" would be the same string meaning two different things.
 */
export const FIXED_OFFSET_PREFIX = 'utc:'

/** `utc:-07:00` back to `-07:00`; anything else is a zone id, so null. */
export function fixedOffsetOf(value: string): string | null {
  return value.startsWith(FIXED_OFFSET_PREFIX) ? value.slice(FIXED_OFFSET_PREFIX.length) : null
}

/**
 * The picker's answer, turned into the two fields a schedule carries.
 *
 * **This is the moment the zone stops existing.** Everything before it is a
 * place; everything after it is a number and a label nothing computes with. A
 * zone is resolved against `on` -- the first day the poll is asking about --
 * so a poll made in March about a meeting in July is built on July's clocks;
 * `CreatePoll` calls this again whenever that day moves, which is what keeps
 * the two in step without an effect watching them.
 *
 * A bare offset (`utc:-07:00`) resolves to itself and carries no label: there
 * is no place to name, and `UTC-07:00` said twice is not more informative than
 * `UTC-07:00` said once.
 *
 * The fallback is the offset the browser is on today. It is reached only by a
 * runtime that will not resolve a zone at all, which no browser this app runs
 * on does -- and an hour's error on a poll nobody could otherwise create is
 * the better of the two failures.
 */
export function resolveZone(
  value: string,
  on: string,
): { timezone: string; timezone_label: string | null } {
  const fixed = fixedOffsetOf(value)
  if (fixed !== null) return { timezone: fixed, timezone_label: null }

  const choice = zoneChoice(value)
  if (!choice) return { timezone: browserOffset(), timezone_label: null }

  return {
    timezone: zoneOffsetOn(choice.zone, on) ?? browserOffset(),
    timezone_label: zoneLabel(choice),
  }
}

/**
 * Which entry of the list this browser is sitting in, as the picker's opening
 * answer -- and a bare offset when the list does not carry it.
 *
 * A guess, and the right one nearly always: the creator is usually organising
 * a meeting where they are. It is a guess they can see and change, which is
 * the difference between this and reading their offset silently.
 */
export function zoneForViewer(): string {
  const here = viewerZone()
  return BY_ZONE.has(here) ? here : `${FIXED_OFFSET_PREFIX}${browserOffset()}`
}

/** Every entry again, by the label it is stored under; see `zoneOfSchedule`. */
const BY_LABEL = new Map<string, string>(
  TIME_ZONE_REGIONS.flatMap((region) => TIME_ZONES[region]).map((choice) => [
    zoneLabel(choice),
    choice.zone,
  ]),
)

/**
 * The picker value for a schedule that already exists — which is what a
 * *duplicate* of a time poll opens on.
 *
 * The zone is not stored: `resolveZone` turns it into an offset and throws it
 * away, which is the whole design. What is stored is the label, so the way
 * back is the label — and it works because a label is generated from this list
 * rather than typed. A poll whose creator picked a bare offset, one made
 * before labels existed, and one whose label names a place this list has since
 * dropped all come back as the offset itself, which is what the poll is
 * actually held at and never wrong.
 *
 * `timezones.test.ts` asserts the round trip over every entry, because a
 * renamed city would break it silently: duplicates would quietly stop
 * following their zone across a daylight-saving change and nothing else would
 * look any different.
 */
export function zoneOfSchedule(timezone: string, label?: string | null): string {
  const zone = label ? BY_LABEL.get(label.trim()) : undefined
  return zone ?? `${FIXED_OFFSET_PREFIX}${timezone}`
}
