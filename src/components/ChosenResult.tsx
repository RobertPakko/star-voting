import type { ChosenResult as Chosen } from '../lib/choices'
import type { PollResults } from '../lib/types'
import { FractionalWinnersBody } from './FractionalWinners'
import { RankingBody, type RankingSource } from './FullRanking'
import { MultipleWinnersBody } from './MultipleWinners'
import { useLeftOut } from '../lib/useLeftOut'

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
}: {
  source: RankingSource
  results: PollResults
  chosen: Chosen
}) {
  const [leftOut, setLeftOut] = useLeftOut(source.pollId)

  switch (chosen.kind) {
    case 'ranking':
      return <RankingBody source={source} results={results} initial={chosen.entries} />
    case 'multiple':
      return (
        <MultipleWinnersBody
          source={source}
          results={results}
          initial={chosen.entries}
          leftOut={leftOut}
          onLeftOut={setLeftOut}
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
  }
}
