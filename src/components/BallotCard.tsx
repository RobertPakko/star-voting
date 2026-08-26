import { Fragment, useState, type ReactNode } from 'react'
import { Button, Card, Divider, Group, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useBallotOrder } from '../lib/ballotOrder'
import { OptionDescription } from './OptionDescription'
import { StarRating } from './StarRating'
import type { PollOption } from '../lib/types'

/** One option's score, in the shape both ballot RPCs take. */
export type BallotScore = { candidate_id: string; score: number }

/**
 * The ballot itself: a score per option, and the button that sends them.
 *
 * There are two ballots in the app and there is one of this. An invite poll's
 * goes to `submit_ballot` as the account that is signed in; an open poll's
 * goes to `open_poll_submit` as `anon`, carrying a voter key and, the first
 * time, a name. Those are genuinely two paths — different grants, different
 * guards, different things to get wrong — and they stay two functions, the
 * way `submit_ballot` and `open_poll_submit` are two functions over one
 * `replace_scores()`. What was never two things is the ballot on screen: the
 * same shuffled rows, the same stars, the same "you can change your vote"
 * beside the same pair of buttons. Held as copies, they drifted in exactly
 * the places nobody looks — a `<br/>` here and not there — and any change to
 * scoring had to be made twice or be made on one kind of poll only.
 *
 * So the caller says what its ballot is *for*: which options, what it says
 * about the results, and where to send the scores. Everything a voter
 * touches is here.
 *
 * The same form fills in a ballot and changes one, on both kinds of poll,
 * which is why `initial` is the only thing that tells them apart. A ballot
 * you are changing that looked or behaved unlike the ballot you cast would be
 * two things to learn rather than one.
 */
export function BallotCard({
  options,
  initial,
  nameField,
  questionStrip,
  note,
  beforeSubmit,
  onSubmit,
  onVoted,
  onCancel,
  onScorePointerDown,
}: {
  options: PollOption[]
  /** The scores already on this voter's ballot; absent when casting a new one. */
  initial?: Record<string, number>
  /** The name box, on the one ballot that has nothing else to name a voter by. */
  nameField?: ReactNode
  /** Navigation for a multi-question ballot, rendered inside its card. */
  questionStrip?: ReactNode
  /** When the results come out, and whether the vote can change until then. */
  note: ReactNode
  /**
   * The caller's own last check before anything is sent; return false to stop.
   * One caller has a field of its own to be happy with, and a field's
   * complaint belongs on the field rather than on the line below this card's
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
  /**
   * A score is being tapped. The open-poll ballot drops focus from its name
   * field here, because a phone keyboard dismissed by hand does not blur the
   * field it belongs to and would otherwise pop back up over every star.
   */
  onScorePointerDown?: () => void
}) {
  const revising = initial !== undefined
  // Shown in this browser's own order rather than the creator's; see
  // lib/ballotOrder.ts. The scores below are keyed by option id, so this
  // changes what the voter reads and nothing about what they send.
  const ballot = useBallotOrder(options)
  const [values, setValues] = useState<Record<string, number>>(initial ?? {})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function setScore(optionId: string, score: number) {
    setValues((prev) => ({ ...prev, [optionId]: score }))
  }

  async function handleSubmit() {
    setError(null)
    if (beforeSubmit && !beforeSubmit()) return

    setSubmitting(true)
    try {
      await onSubmit(ballot.map((o) => ({ candidate_id: o.id, score: values[o.id] ?? 0 })))
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
        {ballot.map((option) => (
          <Fragment key={option.id}>
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <div style={{ minWidth: 0 }}>
                <Text fw={500}>{option.name}</Text>
                {option.description && <OptionDescription description={option.description} />}
              </div>
              <StarRating
                label={`Score for ${option.name}`}
                value={values[option.id] ?? 0}
                onChange={(v) => setScore(option.id, v)}
                onPointerDown={onScorePointerDown}
              />
            </Group>
            <Divider />
          </Fragment>
        ))}

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
