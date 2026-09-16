import { describe, expect, test } from 'vitest'
import { ballotsCsv, ballotsFileName } from './ballotCsv'
import type { BallotSheet } from './types'

/**
 * The file a reader takes away to add a poll up for themselves.
 *
 * Two things are worth testing and the second is the reason this file exists:
 * that the rows are the sheet, and that a name somebody typed cannot become
 * something a spreadsheet runs. Everything in a published sheet -- the voters'
 * names and the options' -- was written by whoever held the poll's link.
 */

function sheet(over: Partial<BallotSheet> = {}): BallotSheet {
  return {
    voters_named: true,
    options: [
      { id: 'a', name: 'Pizza' },
      { id: 'b', name: 'Tacos' },
    ],
    ballots: [
      { voter: 'Ada', scores: { a: 5, b: 1 } },
      { voter: 'Grace', scores: { a: 0, b: 4 } },
    ],
    ...over,
  }
}

function lines(csv: string): string[] {
  return csv.split('\r\n')
}

describe('the ballots as a CSV', () => {
  test('a heading and one row per ballot, in the order the sheet came in', () => {
    expect(lines(ballotsCsv(sheet()))).toEqual(['Voter,Pizza,Tacos', 'Ada,5,1', 'Grace,0,4'])
  })

  test('no totals row: the claim is not part of the evidence', () => {
    expect(ballotsCsv(sheet())).not.toContain('Total')
  })

  test('an unnamed sheet is numbered, as the grid numbers it', () => {
    const csv = ballotsCsv(
      sheet({
        voters_named: false,
        ballots: [
          { voter: null, scores: { a: 3, b: 3 } },
          { voter: null, scores: { a: 2, b: 5 } },
        ],
      }),
    )
    expect(lines(csv)).toEqual(['Ballot,Pizza,Tacos', '1,3,3', '2,2,5'])
  })

  test('an option nobody scored counts as 0, as it does in the tally', () => {
    const csv = ballotsCsv(sheet({ ballots: [{ voter: 'Ada', scores: { a: 4 } }] }))
    expect(lines(csv)[1]).toBe('Ada,4,0')
  })

  test('commas, quotes and line breaks are escaped rather than lost', () => {
    const csv = ballotsCsv(
      sheet({
        options: [{ id: 'a', name: 'Pizza, two of them' }],
        ballots: [
          { voter: 'She said "yes"', scores: { a: 5 } },
          { voter: 'Two\nlines', scores: { a: 1 } },
        ],
      }),
    )
    expect(csv).toContain('"Pizza, two of them"')
    expect(csv).toContain('"She said ""yes"""')
    expect(csv).toContain('"Two\nlines"')
  })

  test('a name that would be a formula is handed over as text', () => {
    // The whole reason this is not a `join(',')`: these four characters open a
    // formula in every spreadsheet, and both columns here are typed by
    // whoever holds the poll's link.
    const csv = ballotsCsv(
      sheet({
        options: [{ id: 'a', name: '=1+1' }],
        ballots: [
          { voter: '=HYPERLINK("http://evil","click")', scores: { a: 5 } },
          { voter: '+49 friends', scores: { a: 5 } },
          { voter: '-Ada', scores: { a: 5 } },
          { voter: '@everyone', scores: { a: 5 } },
        ],
      }),
    )
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`)
    expect(lines(csv)[0]).toBe(`Voter,'=1+1`)
    expect(lines(csv)[2]).toBe(`'+49 friends,5`)
    expect(lines(csv)[3]).toBe(`'-Ada,5`)
    expect(lines(csv)[4]).toBe(`'@everyone,5`)
  })

  test('a sheet with no ballots is the heading alone', () => {
    expect(ballotsCsv(sheet({ ballots: [] }))).toBe('Voter,Pizza,Tacos')
  })
})

describe('what the file is called', () => {
  test('the poll, and the question where there is one', () => {
    expect(ballotsFileName('Movie night')).toBe('movie-night-ballots.csv')
    expect(ballotsFileName('Movie night', 'What are we eating?')).toBe(
      'movie-night-what-are-we-eating-ballots.csv',
    )
  })

  test('a title a filesystem would choke on, and one there is none of', () => {
    expect(ballotsFileName('Lunch / dinner?')).toBe('lunch-dinner-ballots.csv')
    expect(ballotsFileName('???')).toBe('poll-ballots.csv')
    expect(ballotsFileName('')).toBe('poll-ballots.csv')
  })

  test('a very long title is cut, and never cut to a hanging hyphen', () => {
    // Sixty characters of slug, and the sixtieth is where the next word would
    // have started -- which is the one case the trailing trim is there for.
    expect(ballotsFileName('a'.repeat(59) + ' something')).toBe('a'.repeat(59) + '-ballots.csv')
    expect(ballotsFileName('a'.repeat(80))).toBe('a'.repeat(60) + '-ballots.csv')
  })
})
