import { describe, expect, it } from 'vitest'
import { carriedFrom, winnersOf } from './sequel'
import type { BallotSheet, PollResults } from './types'

const results = (over: Partial<PollResults>): PollResults => ({
  options: [],
  option_count: 3,
  calendar: false,
  finalists: [],
  tie: false,
  tiebreaks: [],
  runoff: null,
  winner_id: 'pizza',
  voter_count: 2,
  invited_count: 0,
  mode: 'open',
  closed_early: false,
  options_edited_after_votes: false,
  votes_after_reveal: false,
  kind: 'option',
  kind_value: null,
  kind_result: null,
  ...over,
})

const sheet: BallotSheet = {
  voters_named: true,
  options: [],
  ballots: [
    { voter: 'Ana', scores: { pizza: 5, tacos: 1 } },
    { voter: 'Ben', scores: { pizza: 1, tacos: 4 }, given: 2.5 },
  ],
}

const spot = (place: number, id: string) => ({
  place,
  options: [{ id, name: id, total_score: 0 }],
  finalists: [],
  finalist_names: [],
  runoff: null,
  tiebreaks: [],
})

describe('a sequel', () => {
  it('charges every ballot the stars it gave the winner, on top of what it brought', () => {
    expect(carriedFrom(sheet, results({}), [])).toEqual([
      { voter: 'Ana', given: 5 },
      { voter: 'Ben', given: 3.5 },
    ])
  })

  it('charges nobody for a tie', () => {
    expect(winnersOf(results({ winner_id: null }))).toEqual([])
    expect(carriedFrom(sheet, results({ winner_id: null }), [])[1].given).toBe(2.5)
  })

  it('charges multiple winners for the places the question asked for', () => {
    const multiple = results({
      kind: 'multiple',
      kind_value: 2,
      kind_result: [spot(1, 'pizza'), spot(2, 'tacos'), spot(3, 'sushi')],
    })
    expect(winnersOf(multiple)).toEqual(['pizza', 'tacos'])
    expect(winnersOf({ ...multiple, kind_value: null })).toEqual(['pizza'])
  })

  it('keeps the voters who skipped, as they were, and nobody twice', () => {
    expect(
      carriedFrom(sheet, results({}), [
        { voter: 'Cy', given: 7 },
        { voter: 'ana', given: 1 },
      ]).map((row) => row.voter),
    ).toEqual(['Ana', 'Ben', 'Cy'])
  })
})
