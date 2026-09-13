import { Button, Modal, Stack, Text } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { CoinVerticalIcon } from '@phosphor-icons/react'
import { coinFlip } from '../lib/coinFlip'
import classes from './CoinFlip.module.css'

/** One of the two the runoff could not separate, named for the reader. */
export interface Finalist {
  id: string
  name: string
}

/**
 * The way out of a poll that elected nobody.
 *
 * A tie is the one result this app reports that leaves the group worse off
 * than before they voted: "No winner" is true, it is the correct output of the
 * method (see AGENTS.md, "Tie-breaks"), and it is also nine people still
 * standing in the street. Every rule the election has was spent getting here,
 * so there is nothing left to compute — the two options really are equal, and
 * what is wanted now is not a better tally but a fair way to stop.
 *
 * So: a coin, next to the card that says there is no winner, and nowhere else.
 * It is deliberately not dressed up as part of the result. The poll still has
 * no winner, `poll_winner_name` still returns null, the list still shows the
 * poll as settling nothing, and this writes nothing anywhere — see
 * `coinFlip`, which is the whole of the mechanism and explains why the side is
 * derived rather than drawn or stored.
 *
 * **What makes it usable is that it is the same flip for everyone**, which is
 * the one thing a reader cannot check from here: their own screen looks
 * identical either way. The modal says so in as many words, because a group
 * only accepts a coin they believe the others saw land the same way.
 */
export function CoinFlip({
  pollId,
  finalists,
}: {
  /** What the flip is seeded on, with the two ids; see coinFlip. */
  pollId: string
  /** The two finalists, in whichever order the tally listed them. */
  finalists: [Finalist, Finalist]
}) {
  const [opened, modal] = useDisclosure(false)

  const winner = coinFlip(pollId, finalists[0].id, finalists[1].id)
  const [won, lost] = finalists[0].id === winner ? finalists : [finalists[1], finalists[0]]

  return (
    <>
      <Button
        variant="default"
        size="compact-sm"
        leftSection={<CoinVerticalIcon size={16} aria-hidden />}
        onClick={modal.open}
      >
        Flip a coin
      </Button>

      <Modal
        opened={opened}
        onClose={modal.close}
        centered
        title={<Text fw={600}>Flip a coin</Text>}
      >
        <Stack gap="lg">
          {/* The coin carries both names and neither is the announcement: it
              spins, so whichever face is readable at a given frame is an
              accident of timing. The result is stated underneath in text,
              which is also what a reader who has asked for less motion gets —
              the animation collapses to its final frame and the sentence was
              never part of it. */}
          <div className={classes.stage} aria-hidden>
            <div className={classes.coin}>
              <div className={classes.face}>
                <span className={classes.name}>{won.name}</span>
              </div>
              <div className={`${classes.face} ${classes.back}`}>
                <span className={classes.name}>{lost.name}</span>
              </div>
            </div>
          </div>

          <Text fw={700} size="lg" ta="center">
            {won.name} wins the toss.
          </Text>

          <Stack gap="xs">
            <Text size="sm">
              <strong>Everybody gets this same flip.</strong> The side it lands on comes from the
              poll and its two finalists rather than from this browser, so reopening it, reloading
              the page, or opening it on somebody else&rsquo;s phone lands it the same way up. There
              is nothing to re-roll and nobody to tell.
            </Text>
            <Text size="sm" c="dimmed">
              The election itself is still tied. This settles the argument, not the poll: nothing is
              recorded, and {won.name} and {lost.name} stay exactly as level as the votes left them.
            </Text>
          </Stack>
        </Stack>
      </Modal>
    </>
  )
}
