import { Anchor, Modal, Stack, Text } from '@mantine/core'
import { Link } from 'react-router-dom'
import { choicePage, toolKind, toolLabel } from '../lib/choices'
import type { PollResults } from '../lib/types'
import type { ResultsSource } from './Results'
import { StarRounds } from './StarRounds'

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
  const label = toolLabel('option', results.kind)
  const winner = results.winner_id
    ? results.options.find((o) => o.id === results.winner_id)?.name
    : null

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      centered
      title={<Text fw={600}>{label}</Text>}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          The option rated highest, settled by a runoff between the two top-scoring options.{' '}
          <Anchor component={Link} to={choicePage(toolKind('option', results.kind))} inherit>
            How it works
          </Anchor>
        </Text>
        <Text fw={700} size="lg" style={{ overflowWrap: 'anywhere' }}>
          {winner ?? 'No winner'}
        </Text>
        <StarRounds source={source} results={results} />
      </Stack>
    </Modal>
  )
}
