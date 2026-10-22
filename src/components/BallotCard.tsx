import { Fragment, useState, type ReactNode } from 'react'
import { Divider, Text } from '@mantine/core'
import { useBallotOrder } from '../lib/ballotOrder'
import {
  clearBallotDraft,
  readBallotDraft,
  useSaveBallotDraft,
  type DraftScope,
} from '../lib/ballotDraft'
import { BallotFrame, type BallotScore } from './BallotFrame'
import { OptionDescription } from './OptionDescription'
import { StarRating } from './StarRating'
import type { PollOption } from '../lib/types'
import classes from './BallotCard.module.css'

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
  draft,
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
  /**
   * Where this ballot's unsent scores are kept; see lib/ballotDraft.ts. Read
   * and written only on a first ballot -- a revision opens with `initial`,
   * which is the server's.
   */
  draft?: DraftScope
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
  const drafting = initial === undefined ? draft : undefined
  const [values, setValues] = useState<Record<string, number>>(
    () => initial ?? restoreDraft(drafting, options),
  )
  useSaveBallotDraft(drafting, values)

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
      onVoted={() => {
        if (drafting) clearBallotDraft(drafting)
        onVoted()
      }}
      onCancel={onCancel}
    >
      <Text size="sm">
        Rate each option from 0 to 5 stars. 5 is the highest preference while 0 is the lowest.
      </Text>
      <Divider />
      {ballot.map((option) => (
        <Fragment key={option.id}>
          {/* On a phone the stars wrap under a long description; see
              BallotCard.module.css. */}
          <div className={classes.row}>
            <div className={classes.text}>
              <Text fw={500}>{option.name}</Text>
              {option.description && <OptionDescription description={option.description} />}
            </div>
            <div className={classes.stars}>
              <StarRating
                label={`Score for ${option.name}`}
                value={values[option.id] ?? 0}
                onChange={(v) => setScore(option.id, v)}
                onPointerDown={onScorePointerDown}
              />
            </div>
          </div>
          <Divider />
        </Fragment>
      ))}
    </BallotFrame>
  )
}

/**
 * The scores this voter gave before the page lost them, for the options still
 * on the ballot. An option taken off since has nothing to be scored against;
 * one added since starts at 0, like any option nobody has scored.
 */
function restoreDraft(
  scope: DraftScope | undefined,
  options: PollOption[],
): Record<string, number> {
  const draft = scope && readBallotDraft(scope)
  if (!draft) return {}
  const restored: Record<string, number> = {}
  for (const option of options) if (option.id in draft) restored[option.id] = draft[option.id]
  return restored
}
