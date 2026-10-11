import { describe, expect, it } from 'vitest'
import { eventTimes, googleCalendarUrl, icsFile, outlookCalendarUrl } from './calendarEvent'

describe('eventTimes', () => {
  it('converts a window at its own offset to UTC', () => {
    expect(eventTimes('2026-09-01T14:00:00-07:00', 180)).toEqual({
      allDay: false,
      start: '20260901T210000Z',
      end: '20260902T000000Z',
    })
  })

  it('carries across midnight in UTC', () => {
    expect(eventTimes('2026-09-01T23:30:00+05:30', 60)).toEqual({
      allDay: false,
      start: '20260901T180000Z',
      end: '20260901T190000Z',
    })
  })

  it('makes whole days an all-day event with an exclusive end, whatever the offset', () => {
    expect(eventTimes('2026-12-31T00:00:00-07:00', 3 * 1440)).toEqual({
      allDay: true,
      start: '20261231',
      end: '20270103',
    })
  })

  it('refuses a name that is not a window', () => {
    expect(eventTimes('Pizza', 60)).toBeNull()
  })
})

const event = {
  title: 'Movie night',
  start: '2026-09-04T18:00:00-07:00',
  minutes: 120,
  details: 'https://choicelab.app/star-voting/#/polls/abc',
  uid: 'abc-2026-09-04T18:00:00-07:00@choicelab.app',
}

describe('links', () => {
  it('fills in Google Calendar', () => {
    const url = new URL(googleCalendarUrl(event)!)
    expect(url.searchParams.get('text')).toBe('Movie night')
    expect(url.searchParams.get('dates')).toBe('20260905T010000Z/20260905T030000Z')
  })

  it('fills in Outlook with ISO times', () => {
    const url = new URL(outlookCalendarUrl(event)!)
    expect(url.searchParams.get('startdt')).toBe('2026-09-05T01:00:00Z')
    expect(url.searchParams.get('enddt')).toBe('2026-09-05T03:00:00Z')
    expect(url.searchParams.get('allday')).toBeNull()
  })
})

describe('icsFile', () => {
  it('escapes text and uses CRLF', () => {
    const text = icsFile({ ...event, title: 'Dinner; drinks, games' }, Date.UTC(2026, 0, 1))!
    expect(text).toContain('SUMMARY:Dinner\\; drinks\\, games\r\n')
    expect(text).toContain('DTSTART:20260905T010000Z\r\n')
    expect(text).toContain('DTSTAMP:20260101T000000Z\r\n')
    expect(text.split('\r\n').every((line) => !line.includes('\n'))).toBe(true)
  })

  it('folds long lines at 75 octets, counting UTF-8 bytes', () => {
    const text = icsFile({ ...event, title: 'é'.repeat(100) })!
    const encoder = new TextEncoder()
    for (const line of text.split('\r\n'))
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75)
    const summary = text.split('\r\n').filter((l) => l.startsWith('SUMMARY') || l.startsWith(' '))
    expect(summary.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe(
      `SUMMARY:${'é'.repeat(100)}`,
    )
  })

  it('writes whole days as dates', () => {
    const text = icsFile({ ...event, start: '2026-09-04T00:00:00-07:00', minutes: 1440 })!
    expect(text).toContain('DTSTART;VALUE=DATE:20260904\r\n')
    expect(text).toContain('DTEND;VALUE=DATE:20260905\r\n')
  })
})
