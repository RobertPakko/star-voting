import { Anchor, Modal, Stack, Text } from '@mantine/core'
import { Link } from 'react-router-dom'

/**
 * Several winners from one set of ballots, opened from the result's *More
 * results* menu (`MoreResults`): a ranking of its own, a STAR election per
 * spot, with each winner's supporters counting for less in later spots
 * (runoffs included). Two winners are its top two. multi-winner-todo.md at
 * the repo root specifies the count.
 *
 * The full ranking is who to go with if the winner falls through, and its top
 * few can all belong to one large group of like-minded voters. Multiple
 * winners is for when several options are genuinely being chosen at once, and
 * shares them out. The modal says only what it is for; `/extensions`
 * explains how.
 *
 * **A placeholder for now**: the modal says what it will do, and computes
 * nothing.
 */
export function MultipleWinners({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      centered
      title={<Text fw={600}>Multiple winners</Text>}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          For choosing several options at once, so that different groups of voters each get one they
          like. Take as many from the top as you need.{' '}
          <Anchor component={Link} to="/extensions?section=multiple-winners" inherit>
            How it works
          </Anchor>
        </Text>
        <Text size="sm">Coming soon.</Text>
      </Stack>
    </Modal>
  )
}
