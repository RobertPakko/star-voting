import { useState, type ReactNode } from 'react'
import { Button, Card, Group, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { Reveal } from './Reveal'

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
  arriving = false,
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
  /**
   * Whether this ballot is arriving later than the page around it, and so
   * needs an entrance of its own.
   *
   * Only the calendar does. Every other ballot is in the main bundle and
   * mounts with the page, which already fades in as a whole -- `Layout` wraps
   * the route in a `Reveal` -- so an entrance here would be a second fade
   * running over the first. The calendar is fetched when it is drawn (see
   * components/deferred.ts), so it lands after that fade is over and would
   * otherwise be the one thing in the app that snaps in.
   *
   * **It wraps the body and not the card, and that distinction is the whole
   * of the care needed here.** What stands in for a ballot being fetched is
   * `QuestionSkeleton`, which renders a real card holding the *real* name box
   * and the *real* question strip over a placeholder body -- precisely so
   * neither of them blinks while the wait happens. Fading the card would play
   * a full entrance over two things that had not changed a pixel, which is
   * the mistake the Motion section of AGENTS.md records against the question
   * strip. Only the body was ever a placeholder, so only the body arrives.
   */
  arriving?: boolean
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
        {/* One element, never several: `Reveal` is a `div`, and a `div` around
            several children that this `Stack` was spacing would take them out
            of it. Both ballots hand over a single element, so the box stands
            exactly where that element stood. */}
        {arriving ? <Reveal>{children}</Reveal> : children}

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
