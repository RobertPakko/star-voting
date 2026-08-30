import { useState, type ReactNode } from 'react'
import { Button, Card, Group, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'

/** One option's score, in the shape both ballot RPCs take. */
export type BallotScore = { candidate_id: string; score: number }

/**
 * Everything around a ballot that is not the ballot: the card, the name box,
 * the question strip, the error line, Cancel and Submit, and the one piece of
 * behaviour they add up to -- sending, and what to do when sending fails.
 *
 * There are two ballots in this app and there is one of this. `BallotCard` is
 * a list of options with stars beside them; `TimeBallotCard` is a calendar
 * somebody paints. Those really are two things -- one is read top to bottom
 * and the other is scanned -- but everything around them is the same
 * sentence, and held as copies the two would drift in exactly the places
 * nobody looks. That is the same argument `PollNotices` and `NameRoster` are
 * here for; see the note at the top of AGENTS.md.
 *
 * What a body supplies is `collect`: the scores, worked out however that body
 * works them out, at the moment Submit is pressed. Both bodies produce the
 * same `BallotScore[]` and it goes to the same `onSubmit`, so both ballot
 * paths -- `submit_ballot` and `open_poll_submit` -- work unchanged.
 */
export function BallotFrame({
  revising,
  nameField,
  questionStrip,
  note,
  collect,
  beforeSubmit,
  onSubmit,
  onVoted,
  onCancel,
  children,
}: {
  /** Changing a vote rather than casting one; the only thing that differs. */
  revising: boolean
  /** The name box, on the one ballot that has nothing else to name a voter by. */
  nameField?: ReactNode
  /** Navigation for a multi-question ballot, rendered inside its card. */
  questionStrip?: ReactNode
  /** When the results come out, and whether the vote can change until then. */
  note: ReactNode
  /** The ballot itself: what the voter actually touches. */
  children: ReactNode
  /** The scores as they stand, asked for at the moment Submit is pressed. */
  collect: () => BallotScore[]
  /**
   * The caller's own last check before anything is sent; return false to stop.
   * One caller has a field of its own to be happy with, and a field's
   * complaint belongs on the field rather than on the line below these
   * buttons.
   */
  beforeSubmit?: () => boolean
  /**
   * Send the scores. Throw to put the message on the ballot and leave the
   * voter where they are, with everything they scored still on screen.
   */
  onSubmit: (scores: BallotScore[]) => Promise<void>
  /** It went in. */
  onVoted: () => void
  /** Offered only when changing a vote; leaves the ballot as it stands. */
  onCancel?: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    setError(null)
    if (beforeSubmit && !beforeSubmit()) return

    setSubmitting(true)
    try {
      await onSubmit(collect())
      notifications.show({ message: revising ? 'Vote updated' : 'Vote submitted', color: 'green' })
      onVoted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit vote.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card withBorder>
      <Stack gap="sm">
        {nameField}
        {questionStrip}
        {children}

        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}

        <Group justify="space-between" wrap="wrap" gap="sm">
          {note}
          <Group gap="sm" align="flex-end" style={{ marginLeft: 'auto' }}>
            {onCancel && (
              <Button variant="subtle" onClick={onCancel} disabled={submitting}>
                Cancel
              </Button>
            )}
            <Button onClick={handleSubmit} loading={submitting}>
              {revising ? 'Save changes' : 'Submit vote'}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Card>
  )
}
