import type { ChosenResult as Chosen } from '../lib/choices'
import type { PollResults } from '../lib/types'
import { FractionalWinnersBody } from './FractionalWinners'
import { RankingBody, type RankingSource } from './FullRanking'
import { MultipleWinnersBody } from './MultipleWinners'
import { ConsensusBody } from './Consensus'
import { ProportionalBudgetBody } from './ProportionalBudget'
import type { MeetingEvent } from '../lib/calendarEvent'
import { useBudgetInputs, useLeftOut } from '../lib/useLeftOut'

/**
 * The result a question asked for (`polls.kind`), where it is more than
 * STAR's winner, drawn on the results page in place of the winner's banner,
 * from what the tally carried (`kind_result`), so it costs no request of its
 * own. It is the same body
 * the *More results* modal draws, so the reader can change the number or take
 * an option out here exactly as there; removals are held here, for as long as
 * this poll's results are on screen.
 */
export function ChosenResult({
  source,
  results,
  chosen,
  eventFor,
}: {
  source: RankingSource
  results: PollResults
  chosen: Chosen
  /** A time poll's window as a calendar event, for the consensus time. */
  eventFor?: (id: string) => MeetingEvent | null
}) {
  const [leftOut, setLeftOut] = useLeftOut(source.pollId)
  const [inputs, setInputs] = useBudgetInputs(source.pollId)

  switch (chosen.kind) {
    case 'ranking':
      return <RankingBody source={source} results={results} initial={chosen.entries} counted />
    case 'multiple':
      return (
        <MultipleWinnersBody
          source={source}
          results={results}
          initial={chosen.entries}
          leftOut={leftOut}
          onLeftOut={setLeftOut}
          counted
        />
      )
    case 'fractional':
      return (
        <FractionalWinnersBody
          source={source}
          results={results}
          initial={chosen.shares}
          leftOut={leftOut}
          onLeftOut={setLeftOut}
        />
      )
    case 'consensus':
      return (
        <ConsensusBody
          source={source}
          results={results}
          initial={chosen.consensus}
          leftOut={leftOut}
          onLeftOut={setLeftOut}
          eventFor={eventFor}
          bannered
        />
      )
    case 'budget':
      return (
        <ProportionalBudgetBody
          source={source}
          results={results}
          initial={chosen.budget}
          leftOut={leftOut}
          onLeftOut={setLeftOut}
          inputs={inputs}
          onInputs={setInputs}
        />
      )
  }
}
