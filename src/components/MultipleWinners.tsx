import { Anchor, Button, Modal, Stack, Text } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { Link } from 'react-router-dom'
import { UsersThreeIcon } from '@phosphor-icons/react'
import type { PollResults } from '../lib/types'

/**
 * Several winners from one set of ballots, behind a button in the result's
 * banner beside *Full ranking*: a STAR election per spot, with each winner's
 * supporters paying for it out of a budget of stars. multi-winner-todo.md at
 * the repo root specifies the count.
 *
 * The two answer different questions. The full ranking is who to go with if
 * the winner falls through, and its top few can all belong to one large group
 * of like-minded voters. Multiple winners is for when several options are
 * genuinely being chosen at once, and it shares them out so each sizeable group
 * of voters gets one it likes. `/star` explains both.
 *
 * **A placeholder for now**: the modal says what it will do, and computes
 * nothing.
 */
export function MultipleWinners({ results }: { results: PollResults }) {
  const [opened, modal] = useDisclosure(false)

  // Shown on the same terms as the full ranking: with two options, choosing
  // more than one winner is choosing both.
  if (results.options.length < 3) return null

  return (
    <>
      <Button
        variant="default"
        size="compact-sm"
        onClick={modal.open}
        leftSection={<UsersThreeIcon size={16} aria-hidden />}
      >
        Multiple winners
      </Button>

      <Modal
        opened={opened}
        onClose={modal.close}
        size="lg"
        centered
        title={<Text fw={600}>Multiple winners</Text>}
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            For when you are choosing more than one option and want everyone represented. Each
            spot is its own STAR election, and the voters who backed the winner pay for it out of
            their stars, so the next spot leans towards somebody else.{' '}
            <Anchor component={Link} to="/star" inherit>
              How it works
            </Anchor>
          </Text>
          <Text size="sm">Coming soon.</Text>
        </Stack>
      </Modal>
    </>
  )
}
