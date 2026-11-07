import { Stack, Text } from '@mantine/core'
import { toolKind } from '../lib/choices'
import type { PollResults } from '../lib/types'
import type { ResultsSource } from './Results'
import { StarRounds } from './StarRounds'
import { ChoiceModal } from './ChoiceBlurb'

/**
 * STAR's own answer, opened from *More results* on a question that asked for
 * something else: the best option (or time), and the runoff and scoring round
 * that chose it. Everything here is in the tally already held, so opening it
 * asks for nothing. A tie is reported and left there; the coin is for a
 * question that asked for the best option.
 */
export function BestOption({
  source,
  results,
  opened,
  onClose,
}: {
  source: ResultsSource
  /** Already relabelled by Results on a time poll; see relabelResults. */
  results: PollResults
  opened: boolean
  onClose: () => void
}) {
  const winner = results.winner_id
    ? results.options.find((o) => o.id === results.winner_id)?.name
    : null

  return (
    <ChoiceModal kind={toolKind('option', results.kind)} opened={opened} onClose={onClose}>
      <Stack gap="md">
        <Text fw={700} size="lg" ta="center" style={{ overflowWrap: 'anywhere' }}>
          {winner ?? 'No winner'}
        </Text>
        <StarRounds source={source} results={results} />
      </Stack>
    </ChoiceModal>
  )
}
