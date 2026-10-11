import { DAY_MINUTES, parseWindowStart, toMinutes, type WindowStart } from './schedule'

/**
 * The time a time poll settled on, as an event somebody can put in their own
 * calendar.
 *
 * There is no calendar API behind this and nothing is sent anywhere: the three
 * ways out are a link that opens Google Calendar's own "new event" form, the
 * same for Outlook on the web, and an `.ics` file, which is what Apple
 * Calendar, desktop Outlook, Thunderbird and nearly everything else import.
 * Each one shows the reader the event before it is saved, so a wrong time is
 * caught by the person whose diary it is going into.
 *
 * **The window's name is the instant, and that is what makes this exact.** An
 * option's name is a full ISO 8601 start with its offset on it (see
 * `enumerateWindows`), so it converts to UTC without anybody's clock being
 * consulted -- a voter in Berlin adding a meeting held at `-07:00` gets it at
 * the right moment in Berlin. The length is the poll's, `meetingMinutes`.
 *
 * **A poll answered in whole days becomes an all-day event**, rather than one
 * running from midnight to midnight at the poll's offset: a three-day retreat
 * is three days in anybody's calendar, not three days starting at 08:00 the
 * day before for somebody nine hours ahead. All-day dates are floating -- they
 * carry no zone -- which is exactly what a date with no time on it means.
 */
export interface MeetingEvent {
  /** What the event is called; the poll's title. */
  title: string
  /** The winning option's name, which is its start. */
  start: WindowStart
  /** How long it runs. */
  minutes: number
  /** A line or two under it -- the link back to the poll. */
  details?: string
  /** Stable across downloads, so importing the file twice updates one event. */
  uid: string
}

/**
 * When the event starts and ends, in the two forms the calendar formats use:
 * `YYYYMMDD` for an all-day event (the end exclusive, as both formats want),
 * `YYYYMMDDTHHMMSSZ` for a timed one.
 *
 * Null for a name that is not a window, which no caller should have but a
 * results page would rather draw no button for than a broken one.
 */
export function eventTimes(
  start: WindowStart,
  minutes: number,
): { allDay: boolean; start: string; end: string } | null {
  const parsed = parseWindowStart(start)
  if (!parsed || !(minutes > 0)) return null

  if (toMinutes(parsed.timeOfDay) === 0 && minutes % DAY_MINUTES === 0) {
    // The date parts read as UTC so the arithmetic is on the calendar date
    // alone -- no zone can move it across midnight.
    const [year, month, day] = parsed.day.split('-').map(Number)
    const first = Date.UTC(year, month - 1, day)
    const last = first + (minutes / DAY_MINUTES) * DAY_MINUTES * 60_000
    return { allDay: true, start: compactDate(first), end: compactDate(last) }
  }

  const at = Date.parse(start)
  if (Number.isNaN(at)) return null
  return {
    allDay: false,
    start: compactInstant(at),
    end: compactInstant(at + minutes * 60_000),
  }
}

function compactDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replaceAll('-', '')
}

function compactInstant(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

/** Google Calendar's "new event" form, filled in. */
export function googleCalendarUrl(event: MeetingEvent): string | null {
  const times = eventTimes(event.start, event.minutes)
  if (!times) return null
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${times.start}/${times.end}`,
  })
  if (event.details) params.set('details', event.details)
  return `https://calendar.google.com/calendar/render?${params}`
}

/**
 * Outlook on the web's compose form, filled in. It reads ISO 8601, so the
 * compact forms are expanded back out; an all-day event is a date and a flag.
 */
export function outlookCalendarUrl(event: MeetingEvent): string | null {
  const times = eventTimes(event.start, event.minutes)
  if (!times) return null
  const expand = (compact: string) =>
    times.allDay
      ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
      : `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T` +
        `${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: event.title,
    startdt: expand(times.start),
    enddt: expand(times.end),
  })
  if (times.allDay) params.set('allday', 'true')
  if (event.details) params.set('body', event.details)
  return `https://outlook.live.com/calendar/0/action/compose?${params}`
}

/**
 * The event as an iCalendar file (RFC 5545).
 *
 * Two details are about the format rather than the event: text values escape
 * `\`, `;`, `,` and newlines, and a line longer than 75 octets is folded onto
 * the next with a leading space -- counted in UTF-8 bytes, since a title in
 * anything but ASCII reaches the limit in fewer characters.
 */
export function icsFile(event: MeetingEvent, now: number = Date.now()): string | null {
  const times = eventTimes(event.start, event.minutes)
  if (!times) return null
  const when = times.allDay
    ? [`DTSTART;VALUE=DATE:${times.start}`, `DTEND;VALUE=DATE:${times.end}`]
    : [`DTSTART:${times.start}`, `DTEND:${times.end}`]
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ChoiceLab//STAR Voting//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeText(event.uid)}`,
    `DTSTAMP:${compactInstant(now)}`,
    ...when,
    `SUMMARY:${escapeText(event.title)}`,
    ...(event.details ? [`DESCRIPTION:${escapeText(event.details)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(fold).join('\r\n') + '\r\n'
}

function escapeText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

function fold(line: string): string {
  const encoder = new TextEncoder()
  const out: string[] = []
  let current = ''
  let bytes = 0
  // The first line may hold 75 octets; each continuation spends one on the
  // space that marks it.
  let limit = 75
  for (const char of line) {
    const size = encoder.encode(char).length
    if (bytes + size > limit) {
      out.push(current)
      current = ' '
      bytes = 1
      limit = 75
    }
    current += char
    bytes += size
  }
  out.push(current)
  return out.join('\r\n')
}

/** What the downloaded file is called: the title, made safe for a filesystem. */
export function icsFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return `${slug || 'meeting'}.ics`
}

/** Hand the file to the browser; see `downloadCsv`, which this mirrors. */
export function downloadIcs(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = fileName
  link.click()
  URL.revokeObjectURL(href)
}
