import { Fragment, useState, type ReactNode } from 'react'
import { Divider, Group, Text } from '@mantine/core'
import { useBallotOrder } from '../lib/ballotOrder'
import { BallotFrame, type BallotScore } from './BallotFrame'
import { OptionDescription } from './OptionDescription'
import { StarRating } from './StarRating'
import type { PollOption } from '../lib/types'

export type { BallotScore }

/**
 * The ballot for a poll that chooses an option: a score per option, in a list.
 *
 * Everything around it -- the card, the name box, the error line, Cancel and
 * Submit -- is `BallotFrame`, which the calendar ballot uses too. What is here
 * is the list itself and the one thing it knows that the frame does not: which
 * order to draw the options in, and what "score" means on a row.
 *
 * The same form fills in a ballot and changes one, which is why `initial` is
 * the only thing telling them apart: a ballot you are changing that looked or
 * behaved unlike the one you cast would be two things to learn.
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
  /** See BallotFrame: the caller's own last check before anything is sent. */
  beforeSubmit?: () => boolean
  /** See BallotFrame: throw to leave the voter where they are. */
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
  // Shown in this browser's own order rather than the creator's; see
  // lib/ballotOrder.ts. The scores below are keyed by option id, so this
  // changes what the voter reads and nothing about what they send.
  const ballot = useBallotOrder(options)
  const [values, setValues] = useState<Record<string, number>>(initial ?? {})

  function setScore(optionId: string, score: number) {
    setValues((prev) => ({ ...prev, [optionId]: score }))
  }

  return (
    <BallotFrame
      revising={initial !== undefined}
      nameField={nameField}
      questionStrip={questionStrip}
      note={note}
      beforeSubmit={beforeSubmit}
      collect={() => ballot.map((o) => ({ candidate_id: o.id, score: values[o.id] ?? 0 }))}
      onSubmit={onSubmit}
      onVoted={onVoted}
      onCancel={onCancel}
    >
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
    </BallotFrame>
  )
}
