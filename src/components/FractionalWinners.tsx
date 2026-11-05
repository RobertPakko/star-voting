import { Anchor, Modal, Stack, Text } from '@mantine/core'
import { Link } from 'react-router-dom'

/**
 * A share for every option rather than a place, opened from the result's
 * *More results* menu (`MoreResults`): the shares that make the product of
 * every voter's average stars largest (the Nash welfare). For a choice that
 * can be split — a budget, a run of meetings, an afternoon — where *Multiple
 * winners* is for picking several whole options.
 *
 * Multiplying is what makes it proportional: a group that likes only its own
 * option gets that option a share the size of the group. The modal says only
 * what it is for; `/extensions` explains how, on `/star`'s example.
 *
 * **A placeholder for now**: the modal says what it will do, and computes
 * nothing.
 */
export function FractionalWinners({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      centered
      title={<Text fw={600}>Fractional winners</Text>}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          For splitting something between the options, like a budget or a run of meetings. Every
          option gets a share, sized so that each group of voters gets some of what it likes.{' '}
          <Anchor component={Link} to="/extensions?section=fractional-winners" inherit>
            How it works
          </Anchor>
        </Text>
        <Text size="sm">Coming soon.</Text>
      </Stack>
    </Modal>
  )
}
